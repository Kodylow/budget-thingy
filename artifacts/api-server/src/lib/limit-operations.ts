import { createHash, randomUUID } from "node:crypto";
import {
  db,
  groupUserLimitPoliciesTable,
  limitOperationsTable,
  limitOperationTargetsTable,
  usageLimitAuditsTable,
  workspaceDefaultLimitTargetsTable,
  type ClearLimitPolicySnapshot,
  type LimitOperation,
  type LimitOperationTarget,
  type LimitTargetAttempt,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  getFreshDirectoryForLimitValidation,
  reconcilePersistedLimitWrite,
} from "./enterprise";
import { resolveCurrentAuthorization, type Authorization } from "./authz";
import {
  listConfiguredWorkspaceLimits,
  isReplitBudgetWriteConfigured,
  ReplitBudgetConnectorError,
  setBudget,
  type ConfiguredWorkspaceLimit,
  type ReplitBudgetWrite,
} from "./replit-budgets";
import {
  markMemberLimitAsHandSet,
  reconcileClearedLimitPolicy,
} from "./member-limit-policies";
import { logger } from "./logger";

const MAX_ATTEMPTS = 4;
const CONCURRENCY = 3;
const running = new Set<string>();
export type WorkspaceLimitType = ReplitBudgetWrite["type"];
export type LimitChange = {
  workspaceId: string;
  type: WorkspaceLimitType;
  targetId: string;
  amountUsd: number | null;
};

export class LimitOperationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "LimitOperationError";
  }
}

function cents(amount: number): number {
  const value = Math.round(amount * 100);
  if (!Number.isFinite(amount) || amount <= 0 || Math.abs(value / 100 - amount) > 1e-9) {
    throw new LimitOperationError(
      "amountUsd must be a finite positive USD amount with at most two decimal places",
    );
  }
  return value;
}

function fingerprint(workspaceId: string, amountCents: number, userIds: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ workspaceId, amountCents, userIds: [...userIds].sort() }))
    .digest("hex");
}

function changeKey(change: Pick<LimitChange, "workspaceId" | "type" | "targetId">): string {
  return `${change.workspaceId}\u0000${change.type}\u0000${change.targetId}`;
}

function targetChange(target: LimitOperationTarget): LimitChange {
  return {
    workspaceId: target.workspaceId,
    type: target.targetType as WorkspaceLimitType,
    targetId: target.targetId,
    amountUsd: target.newAmountUsdCents == null ? null : target.newAmountUsdCents / 100,
  };
}

function canonicalChanges(changes: LimitChange[]) {
  return changes.map((change) => ({
    ...change,
    amountCents: change.amountUsd == null ? null : cents(change.amountUsd),
  })).sort((a, b) => changeKey(a).localeCompare(changeKey(b)));
}

function changesFingerprint(
  kind: string,
  changes: LimitChange[],
  clearPolicySnapshot: readonly ClearLimitPolicySnapshot[] = [],
): string {
  return createHash("sha256").update(JSON.stringify({
    kind,
    targets: canonicalChanges(changes).map(({ amountUsd: _amountUsd, ...change }) => change),
    clearPolicySnapshot,
  })).digest("hex");
}

export async function enabledClearPolicySnapshot(
  executor: Pick<typeof db, "select"> = db,
): Promise<ClearLimitPolicySnapshot[]> {
  const [groups, workspaces] = await Promise.all([
    executor.select().from(groupUserLimitPoliciesTable),
    executor.select().from(workspaceDefaultLimitTargetsTable),
  ]);
  return [
    ...groups.filter((row) => row.isEnabled && row.amountUsd != null).map((row) => ({
      sourceType: "group" as const,
      workspaceId: row.workspaceId,
      sourceId: row.groupId,
      amountUsd: row.amountUsd!,
    })),
    ...workspaces.filter((row) => row.isEnabled).map((row) => ({
      sourceType: "workspace_default" as const,
      workspaceId: row.workspaceId,
      sourceId: row.workspaceId,
      amountUsd: row.monthlyLimitUsd,
    })),
  ].sort((left, right) =>
    `${left.sourceType}:${left.workspaceId}:${left.sourceId}`.localeCompare(
      `${right.sourceType}:${right.workspaceId}:${right.sourceId}`,
    )
  );
}

function policyLockKey(policy: ClearLimitPolicySnapshot): string {
  return JSON.stringify([
    "member-limit-policy",
    policy.sourceType,
    policy.workspaceId,
    policy.sourceId,
  ]);
}

type LimitTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function disableFrozenClearPolicies(
  tx: LimitTransaction,
  frozen: readonly ClearLimitPolicySnapshot[],
): Promise<void> {
  for (const policy of frozen) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${policyLockKey(policy)}, 0))`);
  }
  const currentPolicies = await enabledClearPolicySnapshot(tx);
  if (JSON.stringify(currentPolicies) !== JSON.stringify(frozen)) {
    throw new LimitOperationError("Local limit policies changed after review; prepare again", 409);
  }
  for (const policy of frozen) {
    if (policy.sourceType === "group") {
      await tx.update(groupUserLimitPoliciesTable).set({
        amountUsd: null,
        isEnabled: false,
        updatedAt: new Date(),
      }).where(and(
        eq(groupUserLimitPoliciesTable.workspaceId, policy.workspaceId),
        eq(groupUserLimitPoliciesTable.groupId, policy.sourceId),
      ));
    } else {
      await tx.update(workspaceDefaultLimitTargetsTable).set({
        isEnabled: false,
      }).where(eq(workspaceDefaultLimitTargetsTable.workspaceId, policy.workspaceId));
    }
  }
}

function configuredChange(limit: ConfiguredWorkspaceLimit, amountUsd: number | null): LimitChange {
  return {
    workspaceId: limit.workspaceId,
    type: limit.type,
    targetId: limit.type === "workspace_group_limit"
      ? limit.groupId
      : limit.type === "workspace_user_limit" ? limit.userId : limit.workspaceId,
    amountUsd,
  };
}

export function canWriteChange(authz: Authorization | null, change: LimitChange): boolean {
  if (!authz || authz.isPreview) return false;
  if (change.type === "workspace_group_limit") {
    return authz.capabilities.canWriteGroupLimits &&
      authz.capabilities.canWriteUserLimitsIn.includes(change.workspaceId);
  }
  return authz.capabilities.canWriteUserLimitsIn.includes(change.workspaceId);
}

function canClearAll(authz: Authorization | null): boolean {
  return !!authz && authz.isTrueAccountAdmin && !authz.isPreview &&
    authz.capabilities.canWriteGroupLimits && isReplitBudgetWriteConfigured();
}

function canWrite(authz: Authorization | null, workspaceId: string): boolean {
  return !!authz &&
    !authz.isPreview &&
    authz.capabilities.canWriteUserLimitsIn.includes(workspaceId);
}

async function load(operationId: string): Promise<{
  operation: LimitOperation;
  targets: LimitOperationTarget[];
}> {
  const [operation] = await db
    .select()
    .from(limitOperationsTable)
    .where(eq(limitOperationsTable.id, operationId))
    .limit(1);
  if (!operation) throw new LimitOperationError("Limit operation not found", 404);
  const targets = await db
    .select()
    .from(limitOperationTargetsTable)
    .where(eq(limitOperationTargetsTable.operationId, operationId));
  return { operation, targets };
}

export function operationJson(
  operation: LimitOperation,
  targets: LimitOperationTarget[],
) {
  const presentedState = (target: LimitOperationTarget) =>
    operation.state === "prepared" ? "queued" : target.state;
  const count = (state: string) =>
    targets.filter((target) => presentedState(target) === state).length;
  return {
    id: operation.id,
    workspaceId: operation.workspaceId,
    kind: operation.kind,
    state: operation.state,
    amountUsd: operation.amountUsdCents == null ? null : operation.amountUsdCents / 100,
    reviewFingerprint: operation.requestFingerprint,
    localPolicyCount: operation.clearPolicySnapshot.length,
    actorUserId: operation.actorUserId,
    preparedAt: operation.preparedAt.toISOString(),
    committedAt: operation.committedAt?.toISOString() ?? null,
    completedAt: operation.completedAt?.toISOString() ?? null,
    counts: {
      total: targets.length,
      queued: count("queued"),
      applying: count("applying"),
      verified: count("verified"),
      failed: count("failed"),
      verificationPending: count("verification_pending"),
    },
    targets: targets.map((target) => ({
      workspaceId: target.workspaceId,
      type: target.targetType,
      targetId: target.targetId,
      userId: target.userId,
      groupId: target.groupId,
      memberName: target.memberName,
      memberEmail: target.memberEmail,
      oldAmountUsd: target.oldAmountUsdCents == null ? null : target.oldAmountUsdCents / 100,
      newAmountUsd: target.newAmountUsdCents == null ? null : target.newAmountUsdCents / 100,
      state: presentedState(target),
      attempts: target.attempts,
      history: target.attemptHistory,
      errorStage: operation.state === "prepared" ? null : target.errorStage,
      errorCode: operation.state === "prepared" ? null : target.errorCode,
      errorMessage: operation.state === "prepared" ? null : target.errorMessage,
      upstreamRequestId: target.upstreamRequestId,
      queuedAt: target.queuedAt?.toISOString() ?? null,
      applyingAt: target.applyingAt?.toISOString() ?? null,
      verifiedAt: target.verifiedAt?.toISOString() ?? null,
      failedAt: target.failedAt?.toISOString() ?? null,
    })),
  };
}

export async function prepareLimitOperation(input: {
  authz: Authorization;
  actor: { id: string; email?: string | null; name?: string | null };
  workspaceId: string;
  amountUsd: number;
  userIds: string[];
  groupIds: string[];
  idempotencyKey: string;
}) {
  if (!canWrite(input.authz, input.workspaceId)) {
    throw new LimitOperationError("Access denied", 403);
  }
  if (!isReplitBudgetWriteConfigured()) {
    throw new LimitOperationError(
      "Enterprise budget writes are not configured with write:budgets",
      503,
    );
  }
  const amountCents = cents(input.amountUsd);
  const directory = await getFreshDirectoryForLimitValidation();
  if (!directory.workspaces.has(input.workspaceId)) {
    throw new LimitOperationError("Workspace not found", 404);
  }
  const requested = new Set(input.userIds);
  for (const groupId of new Set(input.groupIds)) {
    const group = directory.groups.find(
      (candidate) =>
        candidate.id === groupId && candidate.workspaceId === input.workspaceId,
    );
    if (!group) throw new LimitOperationError(`Group ${groupId} not found in workspace`, 400);
    for (const userId of directory.groupMembers.get(groupId) ?? []) requested.add(userId);
  }
  const targets = [...requested].sort().map((userId) => {
    const member = directory.members.get(userId);
    const membership = member?.workspaces.get(input.workspaceId);
    if (!member || !membership) {
      throw new LimitOperationError(`User ${userId} is not a workspace member`, 400);
    }
    if (membership.isDisabled || member.isInternalReplitUser) {
      throw new LimitOperationError(
        `User ${userId} is ${membership.isDisabled ? "disabled" : "internal"} and cannot be targeted`,
        400,
      );
    }
    return { member, userId };
  });
  if (!targets.length) throw new LimitOperationError("At least one eligible target is required");
  const reviewFingerprint = fingerprint(input.workspaceId, amountCents, targets.map((t) => t.userId));
  const [existing] = await db.select().from(limitOperationsTable).where(and(
    eq(limitOperationsTable.actorUserId, input.actor.id),
    eq(limitOperationsTable.idempotencyKey, input.idempotencyKey),
  )).limit(1);
  if (existing) {
    if (existing.requestFingerprint !== reviewFingerprint) {
      throw new LimitOperationError("Idempotency key was already used for another request", 409);
    }
    const loaded = await load(existing.id);
    return operationJson(loaded.operation, loaded.targets);
  }
  const id = randomUUID();
  const explicit = directory.budgets.userLimits.get(input.workspaceId) ?? new Map();
  try {
    await db.transaction(async (tx) => {
      await tx.insert(limitOperationsTable).values({
        id,
        workspaceId: input.workspaceId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: reviewFingerprint,
        actorUserId: input.actor.id,
        actorEmail: input.actor.email ?? null,
        actorName: input.actor.name ?? null,
        amountUsdCents: amountCents,
      });
      await tx.insert(limitOperationTargetsTable).values(targets.map(({ member, userId }) => ({
        operationId: id,
        workspaceId: input.workspaceId,
        targetType: "workspace_user_limit",
        targetId: userId,
        userId,
        memberName: member.name ?? member.username,
        memberEmail: member.email,
        oldAmountUsdCents: explicit.has(userId)
          ? Math.round(explicit.get(userId)! * 100)
          : null,
        newAmountUsdCents: amountCents,
        // Prepared targets are frozen but inactive; commit atomically queues them.
        state: "failed",
        errorStage: "prepare",
        errorCode: "not_committed",
        errorMessage: "Awaiting commit",
      })));
    });
  } catch (error) {
    if ((error as { code?: string }).code !== "23505") throw error;
    const [winner] = await db.select().from(limitOperationsTable).where(and(
      eq(limitOperationsTable.actorUserId, input.actor.id),
      eq(limitOperationsTable.idempotencyKey, input.idempotencyKey),
    )).limit(1);
    if (!winner || winner.requestFingerprint !== reviewFingerprint) {
      throw new LimitOperationError("Idempotency key was already used for another request", 409);
    }
    const replay = await load(winner.id);
    return operationJson(replay.operation, replay.targets);
  }
  const loaded = await load(id);
  return operationJson(loaded.operation, loaded.targets);
}

async function validateChanges(
  authz: Authorization,
  changes: LimitChange[],
  directory: Awaited<ReturnType<typeof getFreshDirectoryForLimitValidation>>,
): Promise<void> {
  if (changes.length > 1000) throw new LimitOperationError("At most 1000 targets are allowed");
  const seen = new Set<string>();
  for (const change of changes) {
    if (seen.has(changeKey(change))) throw new LimitOperationError("Duplicate limit target");
    seen.add(changeKey(change));
    if (!directory.workspaces.has(change.workspaceId)) {
      throw new LimitOperationError(`Workspace ${change.workspaceId} not found`, 404);
    }
    if (!canWriteChange(authz, change)) throw new LimitOperationError("Access denied", 403);
    if (change.type === "workspace_default_user_limit") {
      if (change.targetId !== change.workspaceId) {
        throw new LimitOperationError("Workspace default targetId must equal workspaceId");
      }
    } else if (change.type === "workspace_group_limit") {
      const group = directory.groups.find((candidate) =>
        candidate.id === change.targetId && candidate.workspaceId === change.workspaceId
      );
      if (!group) throw new LimitOperationError(`Group ${change.targetId} not found in workspace`, 409);
    } else if (change.type === "workspace_user_limit") {
      const member = directory.members.get(change.targetId);
      const membership = member?.workspaces.get(change.workspaceId);
      if (!member || !membership || membership.isDisabled || member.isInternalReplitUser) {
        throw new LimitOperationError(`User ${change.targetId} is not an eligible workspace member`, 409);
      }
    } else {
      throw new LimitOperationError("Unsupported limit type");
    }
    if (change.amountUsd !== null) cents(change.amountUsd);
  }
}

export async function prepareLimitChanges(input: {
  authz: Authorization;
  actor: { id: string; email?: string | null; name?: string | null };
  changes: LimitChange[];
  idempotencyKey: string;
  clearAll?: boolean;
}) {
  if (!isReplitBudgetWriteConfigured()) {
    throw new LimitOperationError("Enterprise budget writes are not configured with write:budgets", 503);
  }
  if (input.clearAll && !canClearAll(input.authz)) {
    throw new LimitOperationError("Clear All requires a true account administrator", 403);
  }
  if (input.clearAll) {
    const [replay] = await db.select().from(limitOperationsTable).where(and(
      eq(limitOperationsTable.actorUserId, input.actor.id),
      eq(limitOperationsTable.idempotencyKey, input.idempotencyKey),
    )).limit(1);
    if (replay) {
      if (replay.kind !== "clear_all") {
        throw new LimitOperationError("Idempotency key was already used for another request", 409);
      }
      const loaded = await load(replay.id);
      return operationJson(loaded.operation, loaded.targets);
    }
  }
  const inventory = await listConfiguredWorkspaceLimits();
  const changes = input.clearAll
    ? inventory.map((limit) => configuredChange(limit, null))
    : canonicalChanges(input.changes).map(({ amountCents: _amountCents, ...change }) => change);
  const directory = await getFreshDirectoryForLimitValidation();
  if (!input.clearAll) {
    await validateChanges(input.authz, changes, directory);
  }
  const kind = input.clearAll ? "clear_all" : "change";
  const clearPolicySnapshot = input.clearAll ? await enabledClearPolicySnapshot() : [];
  const reviewFingerprint = changesFingerprint(kind, changes, clearPolicySnapshot);
  const [existing] = await db.select().from(limitOperationsTable).where(and(
    eq(limitOperationsTable.actorUserId, input.actor.id),
    eq(limitOperationsTable.idempotencyKey, input.idempotencyKey),
  )).limit(1);
  if (existing) {
    if (existing.requestFingerprint !== reviewFingerprint) {
      throw new LimitOperationError("Idempotency key was already used for another request", 409);
    }
    const replay = await load(existing.id);
    return operationJson(replay.operation, replay.targets);
  }
  const oldByKey = new Map(inventory.map((limit) => {
    const change = configuredChange(limit, limit.amountUsd);
    return [changeKey(change), limit.amountUsd] as const;
  }));
  const id = randomUUID();
  try {
    await db.transaction(async (tx) => {
      await tx.insert(limitOperationsTable).values({
        id,
        workspaceId: changes.length === 1 ? changes[0]!.workspaceId : null,
        kind,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: reviewFingerprint,
        actorUserId: input.actor.id,
        actorEmail: input.actor.email ?? null,
        actorName: input.actor.name ?? null,
        amountUsdCents: null,
        clearPolicySnapshot,
      });
      if (changes.length) {
        const values = changes.map((change) => {
          const member = change.type === "workspace_user_limit"
            ? directory.members.get(change.targetId) : undefined;
          const group = change.type === "workspace_group_limit"
            ? directory.groups.find((candidate) =>
              candidate.id === change.targetId && candidate.workspaceId === change.workspaceId)
            : undefined;
          const old = oldByKey.get(changeKey(change));
          return {
            operationId: id,
            workspaceId: change.workspaceId,
            targetType: change.type,
            targetId: change.targetId,
            userId: change.type === "workspace_user_limit" ? change.targetId : null,
            groupId: change.type === "workspace_group_limit" ? change.targetId : null,
            memberName: member?.name ?? member?.username ?? group?.name ?? null,
            memberEmail: member?.email ?? null,
            oldAmountUsdCents: old == null ? null : Math.round(old * 100),
            newAmountUsdCents: change.amountUsd == null ? null : cents(change.amountUsd),
            state: "failed",
            errorStage: "prepare",
            errorCode: "not_committed",
            errorMessage: "Awaiting commit",
          };
        });
        // Keep statement parameter counts bounded even for the complete
        // server-discovered Clear All inventory.
        for (let offset = 0; offset < values.length; offset += 250) {
          await tx.insert(limitOperationTargetsTable).values(
            values.slice(offset, offset + 250),
          );
        }
      }
    });
  } catch (error) {
    if ((error as { code?: string }).code !== "23505") throw error;
    const [winner] = await db.select().from(limitOperationsTable).where(and(
      eq(limitOperationsTable.actorUserId, input.actor.id),
      eq(limitOperationsTable.idempotencyKey, input.idempotencyKey),
    )).limit(1);
    if (!winner || winner.requestFingerprint !== reviewFingerprint) {
      throw new LimitOperationError("Idempotency key was already used for another request", 409);
    }
    const replay = await load(winner.id);
    return operationJson(replay.operation, replay.targets);
  }
  const loaded = await load(id);
  return operationJson(loaded.operation, loaded.targets);
}

export async function commitLimitOperation(input: {
  operationId: string;
  authz: Authorization;
  reviewFingerprint: string;
  amountUsd: number;
  userIds: string[];
}) {
  const loaded = await load(input.operationId);
  if (!loaded.operation.workspaceId || !canWrite(input.authz, loaded.operation.workspaceId)) {
    throw new LimitOperationError("Access denied", 403);
  }
  const ids = [...new Set(input.userIds)].sort();
  const frozenIds = loaded.targets.map((target) => target.userId).sort();
  if (
    input.reviewFingerprint !== loaded.operation.requestFingerprint ||
    cents(input.amountUsd) !== loaded.operation.amountUsdCents ||
    JSON.stringify(ids) !== JSON.stringify(frozenIds)
  ) throw new LimitOperationError("Commit does not exactly match the frozen review");
  if (loaded.operation.state !== "prepared") {
    resumeLimitOperation(input.operationId);
    return operationJson(loaded.operation, loaded.targets);
  }
  await revalidateTargets(loaded.operation, loaded.targets);
  await assertFrozenOldValues(loaded.operation, loaded.targets);
  try {
    await db.transaction(async (tx) => {
      await tx.update(limitOperationsTable).set({
        state: "queued",
        committedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(limitOperationsTable.id, input.operationId),
        eq(limitOperationsTable.state, "prepared"),
      ));
      await tx.update(limitOperationTargetsTable).set({
        state: "queued",
        queuedAt: new Date(),
        errorStage: null,
        errorCode: null,
        errorMessage: null,
        failedAt: null,
        updatedAt: new Date(),
      }).where(eq(limitOperationTargetsTable.operationId, input.operationId));
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new LimitOperationError("A target already has an active limit operation", 409);
    }
    throw error;
  }
  resumeLimitOperation(input.operationId);
  const committed = await load(input.operationId);
  return operationJson(committed.operation, committed.targets);
}

async function assertFrozenOldValues(
  operation: LimitOperation,
  targets: LimitOperationTarget[],
): Promise<void> {
  const inventory = await listConfiguredWorkspaceLimits();
  const current = new Map(inventory.map((limit) => {
    const change = configuredChange(limit, limit.amountUsd);
    return [changeKey(change), Math.round(limit.amountUsd * 100)] as const;
  }));
  for (const target of targets) {
    const key = changeKey(targetChange(target));
    if ((current.get(key) ?? null) !== target.oldAmountUsdCents) {
      throw new LimitOperationError("Limit values changed after review; prepare again", 409);
    }
  }
  if (operation.kind === "clear_all") {
    const frozen = new Set(targets.map((target) => changeKey(targetChange(target))));
    if (current.size !== frozen.size || [...current.keys()].some((key) => !frozen.has(key))) {
      throw new LimitOperationError("Configured limits changed after review; prepare again", 409);
    }
  }
}

export async function commitLimitChanges(input: {
  operationId: string;
  authz: Authorization;
  reviewFingerprint: string;
  changes: LimitChange[];
  confirmation?: string;
}) {
  const loaded = await load(input.operationId);
  if (loaded.operation.kind === "clear_all") {
    if (!canClearAll(input.authz)) throw new LimitOperationError("Access denied", 403);
    if (input.confirmation !== "CLEAR LIMITS") {
      throw new LimitOperationError("Type CLEAR LIMITS to commit this operation");
    }
  } else if (loaded.targets.some((target) => !canWriteChange(input.authz, targetChange(target)))) {
    throw new LimitOperationError("Access denied", 403);
  }
  const frozen = loaded.targets.map(targetChange);
  if (
    input.reviewFingerprint !== loaded.operation.requestFingerprint ||
    changesFingerprint(loaded.operation.kind, input.changes) !==
      changesFingerprint(loaded.operation.kind, frozen)
  ) {
    throw new LimitOperationError("Commit does not exactly match the frozen review");
  }
  if (loaded.operation.state !== "prepared") {
    resumeLimitOperation(input.operationId);
    return operationJson(loaded.operation, loaded.targets);
  }
  const currentAuthz = await resolveCurrentAuthorization(loaded.operation.actorUserId);
  if (loaded.operation.kind === "clear_all") {
    if (!canClearAll(currentAuthz)) throw new LimitOperationError("Limit-writing permission was revoked", 403);
  } else if (loaded.targets.some((target) => !canWriteChange(currentAuthz, targetChange(target)))) {
    throw new LimitOperationError("Limit-writing permission was revoked", 403);
  }
  const directory = await getFreshDirectoryForLimitValidation();
  if (loaded.operation.kind !== "clear_all") {
    await validateChanges(currentAuthz!, frozen, directory);
  }
  await assertFrozenOldValues(loaded.operation, loaded.targets);
  await db.transaction(async (tx) => {
    if (loaded.operation.kind === "clear_all") {
      await disableFrozenClearPolicies(tx, loaded.operation.clearPolicySnapshot);
    }
    const changed = await tx.update(limitOperationsTable).set({
      state: "queued",
      committedAt: new Date(),
      completedAt: loaded.targets.length ? null : new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(limitOperationsTable.id, input.operationId),
      eq(limitOperationsTable.state, "prepared"),
    )).returning({ id: limitOperationsTable.id });
    if (!changed.length) return;
    if (loaded.targets.length) {
      await tx.update(limitOperationTargetsTable).set({
        state: "queued",
        queuedAt: new Date(),
        errorStage: null,
        errorCode: null,
        errorMessage: null,
        failedAt: null,
        updatedAt: new Date(),
      }).where(eq(limitOperationTargetsTable.operationId, input.operationId));
    } else {
      await tx.update(limitOperationsTable).set({ state: "completed" })
        .where(eq(limitOperationsTable.id, input.operationId));
    }
  }).catch((error) => {
    if ((error as { code?: string }).code === "23505") {
      throw new LimitOperationError("A target already has an active limit operation", 409);
    }
    throw error;
  });
  if (loaded.targets.length) resumeLimitOperation(input.operationId);
  const committed = await load(input.operationId);
  return operationJson(committed.operation, committed.targets);
}

async function revalidateTargets(
  operation: LimitOperation,
  targets: LimitOperationTarget[],
): Promise<void> {
  const authz = await resolveCurrentAuthorization(operation.actorUserId);
  if (!operation.workspaceId || !canWrite(authz, operation.workspaceId)) {
    throw new LimitOperationError("Limit-writing permission was revoked", 403);
  }
  const directory = await getFreshDirectoryForLimitValidation();
  for (const target of targets) {
    if (!target.userId || !operation.workspaceId) {
      throw new LimitOperationError("Legacy operation target is invalid", 409);
    }
    const member = directory.members.get(target.userId);
    const membership = member?.workspaces.get(operation.workspaceId);
    if (!member || !membership || membership.isDisabled || member.isInternalReplitUser) {
      throw new LimitOperationError(
        `Target ${target.userId} is no longer an eligible workspace member`,
        409,
      );
    }
  }
}

function history(
  target: LimitOperationTarget,
  stage: LimitTargetAttempt["stage"],
  outcome: string,
  extra: Partial<LimitTargetAttempt> = {},
): LimitTargetAttempt[] {
  return [...target.attemptHistory, {
    at: new Date().toISOString(),
    stage,
    outcome,
    ...extra,
  }];
}

async function observeTarget(target: LimitOperationTarget): Promise<number | null> {
  const inventory = await listConfiguredWorkspaceLimits();
  const current = new Map(inventory.map((limit) => {
    const change = configuredChange(limit, limit.amountUsd);
    return [changeKey(change), limit.amountUsd] as const;
  }));
  return current.get(changeKey(targetChange(target))) ?? null;
}

async function reconcileTarget(target: LimitOperationTarget): Promise<boolean> {
  const expected = target.newAmountUsdCents == null ? null : target.newAmountUsdCents / 100;
  return await observeTarget(target) === expected;
}

async function processTarget(target: LimitOperationTarget, operation: LimitOperation) {
  const [current] = await db.select().from(limitOperationTargetsTable).where(and(
    eq(limitOperationTargetsTable.operationId, target.operationId),
    eq(limitOperationTargetsTable.workspaceId, target.workspaceId),
    eq(limitOperationTargetsTable.targetType, target.targetType),
    eq(limitOperationTargetsTable.targetId, target.targetId),
  )).limit(1);
  if (!current || !["queued", "applying", "verification_pending"].includes(current.state)) return;
  const authz = await resolveCurrentAuthorization(operation.actorUserId);
  const authorized = operation.kind === "clear_all"
    ? canClearAll(authz)
    : canWriteChange(authz, targetChange(current));
  if (!authorized) {
    await fail(current, "authorization", "permission_revoked", "Limit-writing permission was revoked");
    return;
  }
  if (operation.kind !== "clear_all") {
    const directory = await getFreshDirectoryForLimitValidation();
    try {
      await validateChanges(authz!, [targetChange(current)], directory);
    } catch (error) {
      await fail(current, "membership", "ineligible",
        error instanceof Error ? error.message : "Target is no longer eligible");
      return;
    }
  }
  await db.update(limitOperationTargetsTable).set({
    state: "applying",
    applyingAt: current.applyingAt ?? new Date(),
    attempts: current.attempts + 1,
    updatedAt: new Date(),
  }).where(and(
    eq(limitOperationTargetsTable.operationId, current.operationId),
    eq(limitOperationTargetsTable.workspaceId, current.workspaceId),
    eq(limitOperationTargetsTable.targetType, current.targetType),
    eq(limitOperationTargetsTable.targetId, current.targetId),
  ));
  // Every target gets a complete current read immediately before mutation.
  // This both reconciles uncertain/restarted work and prevents overwriting an
  // external change made after the frozen review.
  try {
    const observed = await observeTarget(current);
    const desired = current.newAmountUsdCents == null ? null : current.newAmountUsdCents / 100;
    const frozenOld = current.oldAmountUsdCents == null ? null : current.oldAmountUsdCents / 100;
    if (observed === desired) {
      await finishVerified(current, operation, "reconcile", "already_applied");
      return;
    }
    if (observed !== frozenOld) {
      await fail(current, "reconcile", "stale_value",
        "Current limit no longer matches the frozen review");
      return;
    }
  } catch (error) {
    await db.update(limitOperationTargetsTable).set({
      state: "verification_pending",
      errorStage: "verification",
      errorCode: "read_unavailable",
      errorMessage: error instanceof Error ? error.message : "Unable to verify current limit",
      attemptHistory: history(current, "verification", "pending", {
        message: error instanceof Error ? error.message : undefined,
      }),
      updatedAt: new Date(),
    }).where(and(
      eq(limitOperationTargetsTable.operationId, current.operationId),
      eq(limitOperationTargetsTable.workspaceId, current.workspaceId),
      eq(limitOperationTargetsTable.targetType, current.targetType),
      eq(limitOperationTargetsTable.targetId, current.targetId),
    ));
    return;
  }
  try {
    const change = targetChange(current);
    const write: ReplitBudgetWrite = change.type === "workspace_user_limit"
      ? { type: change.type, workspaceId: change.workspaceId, userId: change.targetId, amountUsd: change.amountUsd }
      : change.type === "workspace_group_limit"
        ? { type: change.type, workspaceId: change.workspaceId, groupId: change.targetId, amountUsd: change.amountUsd }
        : { type: change.type, workspaceId: change.workspaceId, amountUsd: change.amountUsd };
    const result = await setBudget(write, {
      retryTransient: false,
      operationId: current.operationId,
      expectedAmountUsd:
        current.oldAmountUsdCents == null ? null : current.oldAmountUsdCents / 100,
    });
    await finishVerified(current, operation, "write", "verified", result.requestId);
  } catch (error) {
    const connector = error instanceof ReplitBudgetConnectorError ? error : null;
    const ambiguous =
      connector?.upstreamStatus == null ||
      connector.upstreamStatus === 200;
    if (ambiguous) {
      try {
        if (await reconcileTarget(current)) {
          await finishVerified(current, operation, "reconcile", "confirmed_after_ambiguous_error",
            connector?.requestId);
          return;
        }
      } catch {
        // Remain verification-pending rather than asserting failure.
      }
    }
    const retryable = ambiguous ||
      connector?.upstreamStatus === 409 ||
      connector?.upstreamStatus === 429 ||
      connector?.upstreamStatus === 503;
    if (retryable && (current.attempts + 1 < MAX_ATTEMPTS || ambiguous)) {
      await db.update(limitOperationTargetsTable).set({
        state: "verification_pending",
        errorStage: "verification",
        errorCode: `upstream_${connector?.upstreamStatus ?? "ambiguous"}`,
        errorMessage: error instanceof Error ? error.message : "Ambiguous upstream outcome",
        upstreamRequestId: connector?.requestId,
        attemptHistory: history(current, "verification", "pending", {
          requestId: connector?.requestId,
          message: error instanceof Error ? error.message : undefined,
        }),
        updatedAt: new Date(),
      }).where(and(
        eq(limitOperationTargetsTable.operationId, current.operationId),
        eq(limitOperationTargetsTable.workspaceId, current.workspaceId),
        eq(limitOperationTargetsTable.targetType, current.targetType),
        eq(limitOperationTargetsTable.targetId, current.targetId),
      ));
      return;
    }
    await fail(current, "write", `upstream_${connector?.upstreamStatus ?? "error"}`,
      error instanceof Error ? error.message : "Budget write failed", connector?.requestId);
  }
}

let localRepairForTests: null | ((write: ReplitBudgetWrite) => Promise<void>) = null;

export function setLimitLocalRepairForTests(
  repair: null | ((write: ReplitBudgetWrite) => Promise<void>),
) {
  localRepairForTests = repair;
}

export async function finishVerified(
  target: LimitOperationTarget,
  operation: LimitOperation,
  stage: "write" | "reconcile",
  outcome: string,
  requestId?: string,
) {
  const change = targetChange(target);
  const write: ReplitBudgetWrite = change.type === "workspace_user_limit"
    ? { type: change.type, workspaceId: change.workspaceId, userId: change.targetId, amountUsd: change.amountUsd }
    : change.type === "workspace_group_limit"
      ? { type: change.type, workspaceId: change.workspaceId, groupId: change.targetId, amountUsd: change.amountUsd }
      : { type: change.type, workspaceId: change.workspaceId, amountUsd: change.amountUsd };
  try {
    await (localRepairForTests
      ? localRepairForTests(write)
      : reconcilePersistedLimitWrite(write));
    if (write.amountUsd === null) {
      await reconcileClearedLimitPolicy(write);
    } else if (write.type === "workspace_user_limit") {
      await markMemberLimitAsHandSet(write.workspaceId, write.userId);
    }
  } catch (error) {
    logger.error({ err: error, operationId: operation.id, targetId: target.targetId },
      "limit write verified upstream but local reconciliation failed");
    await db.update(limitOperationTargetsTable).set({
      state: "verification_pending",
      verifiedAt: null,
      errorStage: "verification",
      errorCode: "local_persistence_failed",
      errorMessage: "Upstream write verified; local reconciliation requires repair",
      updatedAt: new Date(),
    }).where(and(
      eq(limitOperationTargetsTable.operationId, target.operationId),
      eq(limitOperationTargetsTable.workspaceId, target.workspaceId),
      eq(limitOperationTargetsTable.targetType, target.targetType),
      eq(limitOperationTargetsTable.targetId, target.targetId),
    ));
    return;
  }
  await db.update(limitOperationTargetsTable).set({
    state: "verified",
    verifiedAt: new Date(),
    failedAt: null,
    errorStage: null,
    errorCode: null,
    errorMessage: null,
    upstreamRequestId: requestId ?? target.upstreamRequestId,
    attemptHistory: history(target, stage, outcome, { requestId }),
    updatedAt: new Date(),
  }).where(and(
    eq(limitOperationTargetsTable.operationId, target.operationId),
    eq(limitOperationTargetsTable.workspaceId, target.workspaceId),
    eq(limitOperationTargetsTable.targetType, target.targetType),
    eq(limitOperationTargetsTable.targetId, target.targetId),
  ));
  try {
    if (target.userId) await db.insert(usageLimitAuditsTable).values({
      operatorUserId: operation.actorUserId,
      operatorEmail: operation.actorEmail,
      operatorName: operation.actorName,
      workspaceId: target.workspaceId,
      memberUserId: target.userId,
      memberEmail: target.memberEmail,
      memberName: target.memberName,
      action: target.newAmountUsdCents == null ? "clear" : "set",
      operation: "bulk",
      requestedAmountUsd: target.newAmountUsdCents == null ? null : target.newAmountUsdCents / 100,
      outcome: "success",
    });
  } catch (error) {
    logger.error({ err: error, operationId: operation.id, targetId: target.targetId },
      "limit write verified but audit persistence failed");
  }
}

async function fail(
  target: LimitOperationTarget,
  stage: LimitTargetAttempt["stage"],
  code: string,
  message: string,
  requestId?: string,
) {
  await db.update(limitOperationTargetsTable).set({
    state: "failed",
    failedAt: new Date(),
    errorStage: stage,
    errorCode: code,
    errorMessage: message,
    upstreamRequestId: requestId,
    attemptHistory: history(target, stage, "failed", { requestId, message }),
    updatedAt: new Date(),
  }).where(and(
    eq(limitOperationTargetsTable.operationId, target.operationId),
    eq(limitOperationTargetsTable.workspaceId, target.workspaceId),
    eq(limitOperationTargetsTable.targetType, target.targetType),
    eq(limitOperationTargetsTable.targetId, target.targetId),
  ));
}

async function processOperation(operationId: string) {
  try {
    await db.update(limitOperationsTable).set({ state: "running", updatedAt: new Date() })
      .where(and(
        eq(limitOperationsTable.id, operationId),
        inArray(limitOperationsTable.state, ["queued", "running"]),
      ));
    for (;;) {
      const loaded = await load(operationId);
      const pending = loaded.targets.filter((target) =>
        target.state === "queued" ||
        target.state === "applying" ||
        (target.state === "verification_pending" && target.attempts < MAX_ATTEMPTS)
      );
      if (!pending.length) {
        await db.update(limitOperationsTable).set({
          state: "completed",
          completedAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(limitOperationsTable.id, operationId));
        return;
      }
      for (let offset = 0; offset < pending.length; offset += CONCURRENCY) {
        await Promise.all(
          pending.slice(offset, offset + CONCURRENCY)
            .map((target) => processTarget(target, loaded.operation)),
        );
      }
    }
  } catch (error) {
    logger.error({ err: error, operationId }, "durable limit operation pass failed");
  } finally {
    running.delete(operationId);
  }
}

export function resumeLimitOperation(operationId: string): void {
  if (running.has(operationId)) return;
  running.add(operationId);
  void processOperation(operationId);
}

export async function getLimitOperation(
  operationId: string,
  authz: Authorization,
  resume = true,
) {
  const loaded = await load(operationId);
  const readable = loaded.operation.kind === "clear_all"
    ? canClearAll(authz)
    : loaded.targets.every((target) => canWriteChange(authz, targetChange(target)));
  if (!readable) {
    throw new LimitOperationError("Access denied", 403);
  }
  if (resume && !authz.isPreview && ["queued", "running"].includes(loaded.operation.state)) {
    resumeLimitOperation(operationId);
  }
  return operationJson(loaded.operation, loaded.targets);
}

export async function retryLimitTargets(input: {
  operationId: string;
  authz: Authorization;
  userIds: string[];
  idempotencyKey: string;
}) {
  const loaded = await load(input.operationId);
  if (loaded.operation.state === "prepared" || loaded.operation.committedAt === null) {
    throw new LimitOperationError("Prepared operations must be committed before retry", 409);
  }
  if (!loaded.operation.workspaceId || !canWrite(input.authz, loaded.operation.workspaceId)) {
    throw new LimitOperationError("Access denied", 403);
  }
  const selected = new Set(input.userIds);
  const eligible = loaded.targets.filter((target) =>
    target.userId !== null && selected.has(target.userId) &&
    (target.state === "failed" || target.state === "verification_pending")
  );
  if (!eligible.length) throw new LimitOperationError("No retryable targets selected");
  // The retry key is recorded in immutable history, making a replay a no-op once
  // the selected rows have left a retryable state.
  const marker = `retry:${input.idempotencyKey}`;
  if (eligible.some((target) =>
    target.attemptHistory.some((attempt) => attempt.outcome === marker)
  )) return operationJson(loaded.operation, loaded.targets);
  await revalidateTargets(loaded.operation, eligible);
  await db.transaction(async (tx) => {
    for (const target of eligible) {
      await tx.update(limitOperationTargetsTable).set({
        state: "queued",
        queuedAt: new Date(),
        failedAt: null,
        errorStage: null,
        errorCode: null,
        errorMessage: null,
        attemptHistory: history(target, "verification", marker),
        updatedAt: new Date(),
      }).where(and(
        eq(limitOperationTargetsTable.operationId, target.operationId),
        eq(limitOperationTargetsTable.workspaceId, target.workspaceId),
        eq(limitOperationTargetsTable.targetType, target.targetType),
        eq(limitOperationTargetsTable.targetId, target.targetId),
      ));
    }
    await tx.update(limitOperationsTable).set({
      state: "queued",
      completedAt: null,
      updatedAt: new Date(),
    }).where(eq(limitOperationsTable.id, input.operationId));
  });
  resumeLimitOperation(input.operationId);
  return getLimitOperation(input.operationId, input.authz, false);
}

export async function retryLimitChanges(input: {
  operationId: string;
  authz: Authorization;
  targets: Array<Pick<LimitChange, "workspaceId" | "type" | "targetId">>;
  idempotencyKey: string;
}) {
  const loaded = await load(input.operationId);
  if (loaded.operation.state === "prepared" || loaded.operation.committedAt === null) {
    throw new LimitOperationError("Prepared operations must be committed before retry", 409);
  }
  const selected = new Set(input.targets.map(changeKey));
  const eligible = loaded.targets.filter((target) =>
    selected.has(changeKey(targetChange(target))) &&
    (target.state === "failed" || target.state === "verification_pending")
  );
  if (!eligible.length) throw new LimitOperationError("No retryable targets selected");
  const currentAuthz = await resolveCurrentAuthorization(loaded.operation.actorUserId);
  const authorized = loaded.operation.kind === "clear_all"
    ? canClearAll(input.authz) && canClearAll(currentAuthz)
    : eligible.every((target) =>
      canWriteChange(input.authz, targetChange(target)) &&
      canWriteChange(currentAuthz, targetChange(target)));
  if (!authorized) throw new LimitOperationError("Limit-writing permission was revoked", 403);
  const marker = `retry:${input.idempotencyKey}`;
  if (eligible.some((target) =>
    target.attemptHistory.some((attempt) => attempt.outcome === marker)
  )) return operationJson(loaded.operation, loaded.targets);
  const directory = await getFreshDirectoryForLimitValidation();
  if (loaded.operation.kind !== "clear_all") {
    await validateChanges(currentAuthz!, eligible.map(targetChange), directory);
  }
  await db.transaction(async (tx) => {
    for (const target of eligible) {
      await tx.update(limitOperationTargetsTable).set({
        state: "queued",
        queuedAt: new Date(),
        failedAt: null,
        errorStage: null,
        errorCode: null,
        errorMessage: null,
        attemptHistory: history(target, "verification", marker),
        updatedAt: new Date(),
      }).where(and(
        eq(limitOperationTargetsTable.operationId, target.operationId),
        eq(limitOperationTargetsTable.workspaceId, target.workspaceId),
        eq(limitOperationTargetsTable.targetType, target.targetType),
        eq(limitOperationTargetsTable.targetId, target.targetId),
      ));
    }
    await tx.update(limitOperationsTable).set({
      state: "queued",
      completedAt: null,
      updatedAt: new Date(),
    }).where(eq(limitOperationsTable.id, input.operationId));
  });
  resumeLimitOperation(input.operationId);
  return getLimitOperation(input.operationId, input.authz, false);
}

export async function resumeDurableLimitOperations(): Promise<void> {
  const rows = await db.select({ id: limitOperationsTable.id })
    .from(limitOperationsTable)
    .where(inArray(limitOperationsTable.state, ["queued", "running"]));
  for (const row of rows) resumeLimitOperation(row.id);
}