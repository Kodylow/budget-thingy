import { createHash, randomUUID } from "node:crypto";
import {
  db,
  limitOperationsTable,
  limitOperationTargetsTable,
  usageLimitAuditsTable,
  type LimitOperation,
  type LimitOperationTarget,
  type LimitTargetAttempt,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  getFreshDirectoryForLimitValidation,
  reconcilePersistedLimitWrite,
} from "./enterprise";
import { resolveCurrentAuthorization, type Authorization } from "./authz";
import {
  listReplitMemberBudgets,
  isReplitBudgetWriteConfigured,
  ReplitBudgetConnectorError,
  setBudget,
} from "./replit-budgets";
import { markMemberLimitAsHandSet } from "./member-limit-policies";
import { logger } from "./logger";

const MAX_ATTEMPTS = 4;
const CONCURRENCY = 3;
const running = new Set<string>();

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
    state: operation.state,
    amountUsd: operation.amountUsdCents / 100,
    reviewFingerprint: operation.requestFingerprint,
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
      userId: target.userId,
      memberName: target.memberName,
      memberEmail: target.memberEmail,
      oldAmountUsd: target.oldAmountUsdCents == null ? null : target.oldAmountUsdCents / 100,
      newAmountUsd: target.newAmountUsdCents / 100,
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

export async function commitLimitOperation(input: {
  operationId: string;
  authz: Authorization;
  reviewFingerprint: string;
  amountUsd: number;
  userIds: string[];
}) {
  const loaded = await load(input.operationId);
  if (!canWrite(input.authz, loaded.operation.workspaceId)) {
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

async function revalidateTargets(
  operation: LimitOperation,
  targets: LimitOperationTarget[],
): Promise<void> {
  const authz = await resolveCurrentAuthorization(operation.actorUserId);
  if (!canWrite(authz, operation.workspaceId)) {
    throw new LimitOperationError("Limit-writing permission was revoked", 403);
  }
  const directory = await getFreshDirectoryForLimitValidation();
  for (const target of targets) {
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

async function reconcileTarget(target: LimitOperationTarget): Promise<boolean> {
  const snapshot = await listReplitMemberBudgets(target.workspaceId);
  return snapshot.status === "available" &&
    snapshot.budgets.get(target.userId)?.budgetUsd === target.newAmountUsdCents / 100;
}

async function processTarget(target: LimitOperationTarget, operation: LimitOperation) {
  const [current] = await db.select().from(limitOperationTargetsTable).where(and(
    eq(limitOperationTargetsTable.operationId, target.operationId),
    eq(limitOperationTargetsTable.userId, target.userId),
  )).limit(1);
  if (!current || !["queued", "applying", "verification_pending"].includes(current.state)) return;
  const authz = await resolveCurrentAuthorization(operation.actorUserId);
  if (!canWrite(authz, operation.workspaceId)) {
    await fail(current, "authorization", "permission_revoked", "Limit-writing permission was revoked");
    return;
  }
  const directory = await getFreshDirectoryForLimitValidation();
  const member = directory.members.get(current.userId);
  const membership = member?.workspaces.get(current.workspaceId);
  if (!member || !membership || membership.isDisabled || member.isInternalReplitUser) {
    await fail(current, "membership", "ineligible", "Member is no longer eligible");
    return;
  }
  await db.update(limitOperationTargetsTable).set({
    state: "applying",
    applyingAt: current.applyingAt ?? new Date(),
    attempts: current.attempts + 1,
    updatedAt: new Date(),
  }).where(and(
    eq(limitOperationTargetsTable.operationId, current.operationId),
    eq(limitOperationTargetsTable.userId, current.userId),
  ));
  // Reconcile first on resumed/uncertain work. POST is desired-state, but this
  // avoids an unnecessary retry after an ambiguous response.
  if (current.attempts > 0 || current.state !== "queued") {
    try {
      if (await reconcileTarget(current)) {
        await finishVerified(current, "reconcile", "already_applied");
        return;
      }
    } catch {
      // A failed read is not proof the desired state was absent.
    }
  }
  try {
    const result = await setBudget({
      type: "workspace_user_limit",
      workspaceId: current.workspaceId,
      userId: current.userId,
      amountUsd: current.newAmountUsdCents / 100,
    }, { retryTransient: false });
    await finishVerified(current, "write", "verified", result.requestId);
    try {
      await reconcilePersistedLimitWrite({
        type: "workspace_user_limit",
        workspaceId: current.workspaceId,
        userId: current.userId,
        amountUsd: current.newAmountUsdCents / 100,
      });
      await markMemberLimitAsHandSet(current.workspaceId, current.userId);
      await db.insert(usageLimitAuditsTable).values({
        operatorUserId: operation.actorUserId,
        operatorEmail: operation.actorEmail,
        operatorName: operation.actorName,
        workspaceId: operation.workspaceId,
        memberUserId: current.userId,
        memberEmail: current.memberEmail,
        memberName: current.memberName,
        action: "set",
        operation: "bulk",
        requestedAmountUsd: current.newAmountUsdCents / 100,
        outcome: "success",
      });
    } catch (error) {
      // Never downgrade acknowledged upstream success because local audit repair failed.
      logger.error({ err: error, operationId: operation.id, userId: current.userId },
        "limit write verified but local audit persistence failed");
      await db.update(limitOperationTargetsTable).set({
        errorStage: "audit",
        errorCode: "local_persistence_failed",
        errorMessage: "Upstream write verified; local audit requires repair",
      }).where(and(
        eq(limitOperationTargetsTable.operationId, current.operationId),
        eq(limitOperationTargetsTable.userId, current.userId),
      )).catch(() => undefined);
    }
  } catch (error) {
    const connector = error instanceof ReplitBudgetConnectorError ? error : null;
    const ambiguous =
      connector?.upstreamStatus == null ||
      connector.upstreamStatus === 200;
    if (ambiguous) {
      try {
        if (await reconcileTarget(current)) {
          await finishVerified(current, "reconcile", "confirmed_after_ambiguous_error",
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
        eq(limitOperationTargetsTable.userId, current.userId),
      ));
      return;
    }
    await fail(current, "write", `upstream_${connector?.upstreamStatus ?? "error"}`,
      error instanceof Error ? error.message : "Budget write failed", connector?.requestId);
  }
}

async function finishVerified(
  target: LimitOperationTarget,
  stage: "write" | "reconcile",
  outcome: string,
  requestId?: string,
) {
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
    eq(limitOperationTargetsTable.userId, target.userId),
  ));
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
    eq(limitOperationTargetsTable.userId, target.userId),
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
  if (!authz.capabilities.canWriteUserLimitsIn.includes(loaded.operation.workspaceId)) {
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
  if (!canWrite(input.authz, loaded.operation.workspaceId)) {
    throw new LimitOperationError("Access denied", 403);
  }
  const selected = new Set(input.userIds);
  const eligible = loaded.targets.filter((target) =>
    selected.has(target.userId) &&
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
        eq(limitOperationTargetsTable.userId, target.userId),
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