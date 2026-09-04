import {
  db,
  groupUserLimitPoliciesTable,
  memberLimitPolicyAssignmentsTable,
  workspaceDefaultLimitTargetsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  getCachedDirectory,
  type DirectoryCache,
  type EnterpriseMember,
} from "./enterprise";
import {
  listReplitMemberBudgets,
  setReplitMemberBudget,
} from "./replit-budgets";

export type MemberLimitPolicySourceType = "group" | "workspace_default";

export interface MemberLimitPolicy {
  workspaceId: string;
  sourceType: MemberLimitPolicySourceType;
  sourceId: string;
  amountUsd: number | null;
  isEnabled: boolean;
}

export interface ResolvedMemberBaseline {
  amountUsd: number;
  sourceType: MemberLimitPolicySourceType;
  sourceId: string;
}

export interface MemberLimitPolicyAssignment {
  workspaceId: string;
  userId: string;
  lastAmountUsd: number;
  sourceType: MemberLimitPolicySourceType;
  sourceId: string;
}

export type CurrentMemberLimitState =
  | { kind: "no_limit" }
  | { kind: "policy_managed"; assignment: MemberLimitPolicyAssignment }
  | { kind: "hand_set_override"; amountUsd: number };

export type MemberLimitPolicyOutcomeStatus =
  | "applied"
  | "cleared"
  | "unchanged"
  | "no_policy"
  | "override_preserved"
  | "failed";

export interface MemberLimitPolicyOutcome {
  workspaceId: string;
  userId: string;
  desired: ResolvedMemberBaseline | null;
  previousAmountUsd: number | null;
  state: CurrentMemberLimitState["kind"];
  status: MemberLimitPolicyOutcomeStatus;
  error: string | null;
}

export interface MemberLimitPolicyMemberView {
  effectiveBaseline: ResolvedMemberBaseline | null;
  isHandSetOverride: boolean;
  assignment: MemberLimitPolicyAssignment | null;
}

function isPositiveAmount(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

/** Resolve the lowest enabled positive baseline, with a stable identity tie-break. */
export function resolveMemberBaseline(
  workspaceId: string,
  userId: string,
  policies: readonly MemberLimitPolicy[],
  groupMembers: ReadonlyMap<string, readonly string[]>,
): ResolvedMemberBaseline | null {
  const candidates = policies.flatMap((policy) => {
    if (
      policy.workspaceId !== workspaceId ||
      !policy.isEnabled ||
      !isPositiveAmount(policy.amountUsd)
    ) {
      return [];
    }
    if (
      policy.sourceType === "group" &&
      !(groupMembers.get(policy.sourceId) ?? []).includes(userId)
    ) {
      return [];
    }
    return [{
      amountUsd: policy.amountUsd,
      sourceType: policy.sourceType,
      sourceId: policy.sourceId,
    }];
  });
  candidates.sort(
    (left, right) =>
      left.amountUsd - right.amountUsd ||
      `${left.sourceType}:${left.sourceId}`.localeCompare(
        `${right.sourceType}:${right.sourceId}`,
      ),
  );
  return candidates[0] ?? null;
}

/** Classify an upstream value without trusting stale policy assignment rows. */
export function classifyCurrentMemberLimit(
  amountUsd: number | null,
  assignment: MemberLimitPolicyAssignment | null,
): CurrentMemberLimitState {
  if (!isPositiveAmount(amountUsd)) return { kind: "no_limit" };
  if (assignment && assignment.lastAmountUsd === amountUsd) {
    return { kind: "policy_managed", assignment };
  }
  return { kind: "hand_set_override", amountUsd };
}

export interface ApplyMemberLimitPlanInput {
  workspaceId: string;
  userIds: readonly string[];
  policies: readonly MemberLimitPolicy[];
  groupMembers: ReadonlyMap<string, readonly string[]>;
  currentLimits: ReadonlyMap<string, number | null>;
  assignments: ReadonlyMap<string, MemberLimitPolicyAssignment>;
}

export interface MemberLimitPolicyWriter {
  setMemberLimit(
    workspaceId: string,
    userId: string,
    amountUsd: number | null,
  ): Promise<void>;
  saveAssignment(assignment: MemberLimitPolicyAssignment): Promise<void>;
  deleteAssignment(workspaceId: string, userId: string): Promise<void>;
}

/**
 * Apply a preloaded plan. The loop is intentionally serial: upstream budget
 * writes must never overlap, and one member's failure must not abandon others.
 */
export async function applyMemberLimitPlan(
  input: ApplyMemberLimitPlanInput,
  writer: MemberLimitPolicyWriter,
): Promise<MemberLimitPolicyOutcome[]> {
  const outcomes: MemberLimitPolicyOutcome[] = [];
  for (const userId of input.userIds) {
    const previousAmountUsd = input.currentLimits.get(userId) ?? null;
    const assignment = input.assignments.get(userId) ?? null;
    const state = classifyCurrentMemberLimit(previousAmountUsd, assignment);
    const desired = resolveMemberBaseline(
      input.workspaceId,
      userId,
      input.policies,
      input.groupMembers,
    );
    const base = {
      workspaceId: input.workspaceId,
      userId,
      desired,
      previousAmountUsd,
      state: state.kind,
    };

    if (state.kind === "hand_set_override") {
      outcomes.push({
        ...base,
        status: "override_preserved",
        error: null,
      });
      continue;
    }
    if (desired === null && state.kind === "no_limit") {
      outcomes.push({ ...base, status: "no_policy", error: null });
      continue;
    }
    if (
      desired !== null &&
      state.kind === "policy_managed" &&
      previousAmountUsd === desired.amountUsd &&
      assignment?.sourceType === desired.sourceType &&
      assignment.sourceId === desired.sourceId
    ) {
      outcomes.push({ ...base, status: "unchanged", error: null });
      continue;
    }

    const nextAmount = desired?.amountUsd ?? null;
    try {
      // setReplitMemberBudget is the verified desired-state write boundary.
      await writer.setMemberLimit(input.workspaceId, userId, nextAmount);
      if (desired) {
        await writer.saveAssignment({
          workspaceId: input.workspaceId,
          userId,
          lastAmountUsd: desired.amountUsd,
          sourceType: desired.sourceType,
          sourceId: desired.sourceId,
        });
      } else {
        await writer.deleteAssignment(input.workspaceId, userId);
      }
      outcomes.push({
        ...base,
        status: desired ? "applied" : "cleared",
        error: null,
      });
    } catch (error) {
      outcomes.push({
        ...base,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
}

const databaseWriter: MemberLimitPolicyWriter = {
  setMemberLimit: setReplitMemberBudget,
  async saveAssignment(assignment) {
    await db
      .insert(memberLimitPolicyAssignmentsTable)
      .values(assignment)
      .onConflictDoUpdate({
        target: [
          memberLimitPolicyAssignmentsTable.workspaceId,
          memberLimitPolicyAssignmentsTable.userId,
        ],
        set: {
          lastAmountUsd: assignment.lastAmountUsd,
          sourceType: assignment.sourceType,
          sourceId: assignment.sourceId,
          updatedAt: new Date(),
        },
      });
  },
  async deleteAssignment(workspaceId, userId) {
    await db
      .delete(memberLimitPolicyAssignmentsTable)
      .where(
        and(
          eq(memberLimitPolicyAssignmentsTable.workspaceId, workspaceId),
          eq(memberLimitPolicyAssignmentsTable.userId, userId),
        ),
      );
  },
};

function activeWorkspaceUserIds(
  directory: DirectoryCache,
  workspaceId: string,
): string[] {
  return [...directory.members.values()]
    .filter(
      (member: EnterpriseMember) =>
        member.workspaces.get(workspaceId)?.isDisabled === false,
    )
    .map((member) => member.userId)
    .sort();
}

export async function loadMemberLimitPolicyState(): Promise<{
  policies: MemberLimitPolicy[];
  assignments: MemberLimitPolicyAssignment[];
}> {
  const [groups, defaults, assignments] = await Promise.all([
    db.select().from(groupUserLimitPoliciesTable),
    db.select().from(workspaceDefaultLimitTargetsTable),
    db.select().from(memberLimitPolicyAssignmentsTable),
  ]);
  return {
    policies: [
      ...groups.map((policy) => ({
        workspaceId: policy.workspaceId,
        sourceType: "group" as const,
        sourceId: policy.groupId,
        amountUsd: policy.amountUsd,
        isEnabled: policy.isEnabled,
      })),
      ...defaults.map((policy) => ({
        workspaceId: policy.workspaceId,
        sourceType: "workspace_default" as const,
        sourceId: policy.workspaceId,
        amountUsd: policy.monthlyLimitUsd,
        isEnabled: policy.isEnabled,
      })),
    ],
    assignments,
  };
}

async function applyWorkspaceMembers(
  directory: DirectoryCache,
  workspaceId: string,
  userIds: readonly string[],
  state: Awaited<ReturnType<typeof loadMemberLimitPolicyState>>,
): Promise<MemberLimitPolicyOutcome[]> {
  const snapshot = await listReplitMemberBudgets(workspaceId);
  if (snapshot.status !== "available") {
    return userIds.map((userId) => ({
      workspaceId,
      userId,
      desired: resolveMemberBaseline(
        workspaceId,
        userId,
        state.policies,
        directory.groupMembers,
      ),
      previousAmountUsd: null,
      state: "no_limit",
      status: "failed",
      error: snapshot.error ?? "Unable to read current Replit member limits",
    }));
  }
  return applyMemberLimitPlan(
    {
      workspaceId,
      userIds,
      policies: state.policies,
      groupMembers: directory.groupMembers,
      currentLimits: new Map(
        [...snapshot.budgets].map(([userId, budget]) => [
          userId,
          budget.budgetUsd,
        ]),
      ),
      assignments: new Map(
        state.assignments
          .filter((row) => row.workspaceId === workspaceId)
          .map((row) => [row.userId, row]),
      ),
    },
    databaseWriter,
  );
}

/** Recalculate members of one group against every policy that applies to them. */
export async function applyGroupMemberLimitPolicy(
  workspaceId: string,
  groupId: string,
): Promise<MemberLimitPolicyOutcome[]> {
  const [directory, state] = await Promise.all([
    getCachedDirectory(),
    loadMemberLimitPolicyState(),
  ]);
  const active = new Set(activeWorkspaceUserIds(directory, workspaceId));
  const userIds = (directory.groupMembers.get(groupId) ?? [])
    .filter((userId) => active.has(userId))
    .sort();
  return applyWorkspaceMembers(directory, workspaceId, userIds, state);
}

/** Recalculate every active member after changing a workspace default. */
export async function applyWorkspaceDefaultMemberLimitPolicy(
  workspaceId: string,
): Promise<MemberLimitPolicyOutcome[]> {
  const [directory, state] = await Promise.all([
    getCachedDirectory(),
    loadMemberLimitPolicyState(),
  ]);
  return applyWorkspaceMembers(
    directory,
    workspaceId,
    activeWorkspaceUserIds(directory, workspaceId),
    state,
  );
}

/** End-of-ingest entry point: enforce new joiners and reconcile removed policy rows. */
export async function applyAllMemberLimitPolicies(): Promise<
  MemberLimitPolicyOutcome[]
> {
  const [directory, state] = await Promise.all([
    getCachedDirectory(),
    loadMemberLimitPolicyState(),
  ]);
  const workspaceIds = new Set([
    ...state.policies.map((policy) => policy.workspaceId),
    ...state.assignments.map((assignment) => assignment.workspaceId),
  ]);
  const outcomes: MemberLimitPolicyOutcome[] = [];
  for (const workspaceId of [...workspaceIds].sort()) {
    outcomes.push(
      ...(await applyWorkspaceMembers(
        directory,
        workspaceId,
        activeWorkspaceUserIds(directory, workspaceId),
        state,
      )),
    );
  }
  return outcomes;
}

export async function getWorkspaceMemberLimitPolicyViews(
  workspaceId: string,
  currentLimits: ReadonlyMap<string, number | null>,
  directory?: DirectoryCache,
): Promise<Map<string, MemberLimitPolicyMemberView>> {
  const resolvedDirectory = directory ?? await getCachedDirectory();
  const state = await loadMemberLimitPolicyState();
  const assignments = new Map(
    state.assignments
      .filter((row) => row.workspaceId === workspaceId)
      .map((row) => [row.userId, row]),
  );
  return new Map(
    activeWorkspaceUserIds(resolvedDirectory, workspaceId).map((userId) => {
      const assignment = assignments.get(userId) ?? null;
      const current = currentLimits.get(userId) ?? null;
      return [userId, {
        effectiveBaseline: resolveMemberBaseline(
          workspaceId,
          userId,
          state.policies,
          resolvedDirectory.groupMembers,
        ),
        isHandSetOverride:
          classifyCurrentMemberLimit(current, assignment).kind === "hand_set_override",
        assignment,
      }];
    }),
  );
}

export async function markMemberLimitAsHandSet(
  workspaceId: string,
  userId: string,
): Promise<void> {
  await databaseWriter.deleteAssignment(workspaceId, userId);
}

export async function setGroupMemberLimitPolicy(input: {
  workspaceId: string;
  groupId: string;
  amountUsd: number | null;
}): Promise<MemberLimitPolicyOutcome[]> {
  const directory = await getCachedDirectory();
  const group = directory.groups.find((candidate) =>
    candidate.workspaceId === input.workspaceId && candidate.id === input.groupId
  );
  if (!group) throw new Error("Group not found in workspace");
  if (
    input.amountUsd !== null &&
    (!Number.isFinite(input.amountUsd) || input.amountUsd <= 0)
  ) {
    throw new TypeError("amountUsd must be null or greater than zero");
  }
  await db.insert(groupUserLimitPoliciesTable).values({
    workspaceId: input.workspaceId,
    groupId: input.groupId,
    amountUsd: input.amountUsd,
    isEnabled: input.amountUsd !== null,
  }).onConflictDoUpdate({
    target: [
      groupUserLimitPoliciesTable.workspaceId,
      groupUserLimitPoliciesTable.groupId,
    ],
    set: {
      amountUsd: input.amountUsd,
      isEnabled: input.amountUsd !== null,
      updatedAt: new Date(),
    },
  });
  return applyGroupMemberLimitPolicy(input.workspaceId, input.groupId);
}

export async function setWorkspaceDefaultMemberLimitPolicy(input: {
  workspaceId: string;
  displayName: string;
  amountUsd: number | null;
}): Promise<MemberLimitPolicyOutcome[]> {
  if (
    input.amountUsd !== null &&
    (!Number.isFinite(input.amountUsd) || input.amountUsd <= 0)
  ) {
    throw new TypeError("amountUsd must be null or greater than zero");
  }
  await db.insert(workspaceDefaultLimitTargetsTable).values({
    workspaceId: input.workspaceId,
    displayName: input.displayName,
    monthlyLimitUsd: input.amountUsd ?? 1,
    isEnabled: input.amountUsd !== null,
  }).onConflictDoUpdate({
    target: workspaceDefaultLimitTargetsTable.workspaceId,
    set: {
      displayName: input.displayName,
      ...(input.amountUsd === null ? {} : { monthlyLimitUsd: input.amountUsd }),
      isEnabled: input.amountUsd !== null,
    },
  });
  return applyWorkspaceDefaultMemberLimitPolicy(input.workspaceId);
}