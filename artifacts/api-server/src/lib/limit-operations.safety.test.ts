import { afterEach, describe, expect, it, vi } from "vitest";
import {
  db,
  groupUserLimitPoliciesTable,
  limitOperationsTable,
  limitOperationTargetsTable,
  memberLimitPolicyAssignmentsTable,
  workspaceDefaultLimitTargetsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { buildAuthorization } from "./authz";
import {
  commitLimitChanges,
  disableFrozenClearPolicies,
  enabledClearPolicySnapshot,
  finishVerified,
  retryLimitChanges,
  retryLimitTargets,
  setLimitLocalRepairForTests,
  canWriteChange,
} from "./limit-operations";
import { reconcileClearedLimitPolicy } from "./member-limit-policies";
import {
  setBudget,
  setReplitBudgetTransportForTests,
} from "./replit-budgets";

const operationIds: string[] = [];

function admin(workspaceIds = ["ws1", "ws2"]) {
  return buildAuthorization({
    userId: "9001",
    roles: ["account"],
    isTrueAccountAdmin: true,
    allWorkspaceIds: workspaceIds,
  });
}

async function prepared(kind: "change" | "clear_all" = "change") {
  const id = crypto.randomUUID();
  operationIds.push(id);
  await db.insert(limitOperationsTable).values({
    id,
    workspaceId: "ws1",
    kind,
    idempotencyKey: `test-${id}`,
    requestFingerprint: "a".repeat(64),
    actorUserId: "9001",
    state: "prepared",
  });
  if (kind === "change") {
    await db.insert(limitOperationTargetsTable).values({
      operationId: id,
      workspaceId: "ws1",
      targetType: "workspace_user_limit",
      targetId: "42",
      userId: "42",
      oldAmountUsdCents: 1000,
      newAmountUsdCents: 2000,
      state: "failed",
    });
  }
  return id;
}

afterEach(async () => {
  setLimitLocalRepairForTests(null);
  setReplitBudgetTransportForTests(null);
  for (const id of operationIds.splice(0)) {
    await db.delete(limitOperationsTable).where(eq(limitOperationsTable.id, id));
  }
  for (const workspaceId of ["policyWs"]) {
    await db.delete(memberLimitPolicyAssignmentsTable)
      .where(eq(memberLimitPolicyAssignmentsTable.workspaceId, workspaceId));
    await db.delete(groupUserLimitPoliciesTable)
      .where(eq(groupUserLimitPoliciesTable.workspaceId, workspaceId));
    await db.delete(workspaceDefaultLimitTargetsTable)
      .where(eq(workspaceDefaultLimitTargetsTable.workspaceId, workspaceId));
  }
});

describe("durable limit safety gates", () => {
  it("uses account-admin write coverage, not personal workspace membership, for group limits", () => {
    const change = { type: "workspace_group_limit" as const, workspaceId: "ws2", targetId: "g2", amountUsd: 100 };
    expect(admin().workspaceIds).toEqual([]);
    expect(canWriteChange(admin(), change)).toBe(true);
    expect(canWriteChange(admin(["ws1"]), change)).toBe(false);
    expect(canWriteChange({ ...admin(), isPreview: true }, change)).toBe(false);
    expect(canWriteChange(buildAuthorization({
      userId: "reader", roles: ["account"], allWorkspaceIds: ["ws2"],
    }), change)).toBe(false);
  });

  it("never lets either retry route activate an uncommitted review", async () => {
    const id = await prepared();
    await expect(retryLimitTargets({
      operationId: id,
      authz: admin(),
      userIds: ["42"],
      idempotencyKey: "retry-key",
    })).rejects.toMatchObject({ status: 409 });
    await expect(retryLimitChanges({
      operationId: id,
      authz: admin(),
      targets: [{ workspaceId: "ws1", type: "workspace_user_limit", targetId: "42" }],
      idempotencyKey: "retry-key",
    })).rejects.toMatchObject({ status: 409 });
  });

  it("enforces typed confirmation at the backend for a clear-all commit", async () => {
    const id = await prepared("clear_all");
    await expect(commitLimitChanges({
      operationId: id,
      authz: admin(),
      reviewFingerprint: "a".repeat(64),
      changes: [],
      confirmation: "clear limits",
    })).rejects.toThrow("Type CLEAR LIMITS");
  });

  it("uses workspace plus type plus id so one user can occur in two workspaces", async () => {
    const id = await prepared("clear_all");
    await expect(db.insert(limitOperationTargetsTable).values([
      {
        operationId: id, workspaceId: "ws1", targetType: "workspace_user_limit",
        targetId: "42", userId: "42", newAmountUsdCents: null, state: "failed",
      },
      {
        operationId: id, workspaceId: "ws2", targetType: "workspace_user_limit",
        targetId: "42", userId: "42", newAmountUsdCents: null, state: "failed",
      },
    ])).resolves.toBeDefined();
  });

  it("blocks a direct writer while the canonical target has active durable work", async () => {
    const id = await prepared();
    await db.update(limitOperationsTable).set({ state: "queued", committedAt: new Date() })
      .where(eq(limitOperationsTable.id, id));
    await db.update(limitOperationTargetsTable).set({ state: "queued" })
      .where(eq(limitOperationTargetsTable.operationId, id));
    const transport = vi.fn();
    setReplitBudgetTransportForTests(transport);
    await expect(setBudget({
      type: "workspace_user_limit",
      workspaceId: "ws1",
      userId: "42",
      amountUsd: 30,
    })).rejects.toMatchObject({ upstreamStatus: 409 });
    expect(transport).not.toHaveBeenCalled();
  });

  it("removes persisted policy intent for every cleared target type", async () => {
    await db.insert(groupUserLimitPoliciesTable).values({
      workspaceId: "policyWs", groupId: "group1", amountUsd: 12, isEnabled: true,
    });
    await db.insert(workspaceDefaultLimitTargetsTable).values({
      workspaceId: "policyWs", displayName: "Policy", monthlyLimitUsd: 15, isEnabled: true,
    });
    await db.insert(memberLimitPolicyAssignmentsTable).values({
      workspaceId: "policyWs", userId: "42", lastAmountUsd: 12,
      sourceType: "group", sourceId: "group1",
    });
    await reconcileClearedLimitPolicy({
      type: "workspace_user_limit", workspaceId: "policyWs", userId: "42",
    });
    await reconcileClearedLimitPolicy({
      type: "workspace_group_limit", workspaceId: "policyWs", groupId: "group1",
    });
    await reconcileClearedLimitPolicy({
      type: "workspace_default_user_limit", workspaceId: "policyWs",
    });
    expect(await db.select().from(memberLimitPolicyAssignmentsTable)
      .where(eq(memberLimitPolicyAssignmentsTable.workspaceId, "policyWs"))).toEqual([]);
    expect((await db.select().from(groupUserLimitPoliciesTable)
      .where(eq(groupUserLimitPoliciesTable.workspaceId, "policyWs")))[0])
      .toMatchObject({ amountUsd: null, isEnabled: false });
    expect((await db.select().from(workspaceDefaultLimitTargetsTable)
      .where(eq(workspaceDefaultLimitTargetsTable.workspaceId, "policyWs")))[0])
      .toMatchObject({ isEnabled: false });
  });

  it("keeps the active reservation until local repair succeeds, then resumes", async () => {
    const id = await prepared();
    await db.update(limitOperationsTable).set({ state: "running", committedAt: new Date() })
      .where(eq(limitOperationsTable.id, id));
    await db.update(limitOperationTargetsTable).set({
      state: "verification_pending",
      errorStage: "verification",
    }).where(eq(limitOperationTargetsTable.operationId, id));
    const [operation] = await db.select().from(limitOperationsTable)
      .where(eq(limitOperationsTable.id, id));
    const [target] = await db.select().from(limitOperationTargetsTable)
      .where(eq(limitOperationTargetsTable.operationId, id));
    if (!operation || !target) throw new Error("Missing test operation");

    setLimitLocalRepairForTests(async () => {
      throw new Error("simulated local repair crash");
    });
    await finishVerified(target, operation, "reconcile", "already_desired");
    expect((await db.select().from(limitOperationTargetsTable)
      .where(eq(limitOperationTargetsTable.operationId, id)))[0])
      .toMatchObject({ state: "verification_pending", verifiedAt: null });

    setLimitLocalRepairForTests(async () => undefined);
    const [pending] = await db.select().from(limitOperationTargetsTable)
      .where(eq(limitOperationTargetsTable.operationId, id));
    await finishVerified(pending!, operation, "reconcile", "already_desired");
    expect((await db.select().from(limitOperationTargetsTable)
      .where(eq(limitOperationTargetsTable.operationId, id)))[0]?.state).toBe("verified");
  });

  it("disables frozen local enforcement intent even when upstream inventory is empty", async () => {
    await db.insert(groupUserLimitPoliciesTable).values({
      workspaceId: "policyWs", groupId: "group1", amountUsd: 12, isEnabled: true,
    });
    await db.insert(workspaceDefaultLimitTargetsTable).values({
      workspaceId: "policyWs", displayName: "Policy", monthlyLimitUsd: 15, isEnabled: true,
    });
    const frozen = await enabledClearPolicySnapshot();
    expect(frozen.filter((row) => row.workspaceId === "policyWs")).toHaveLength(2);
    await db.transaction((tx) => disableFrozenClearPolicies(tx, frozen));
    expect((await db.select().from(groupUserLimitPoliciesTable)
      .where(eq(groupUserLimitPoliciesTable.workspaceId, "policyWs")))[0]?.isEnabled).toBe(false);
    expect((await db.select().from(workspaceDefaultLimitTargetsTable)
      .where(eq(workspaceDefaultLimitTargetsTable.workspaceId, "policyWs")))[0]?.isEnabled).toBe(false);
  });

  it("fails closed when local policy intent changes after the clear review", async () => {
    await db.insert(groupUserLimitPoliciesTable).values({
      workspaceId: "policyWs", groupId: "group1", amountUsd: 12, isEnabled: true,
    });
    const frozen = await enabledClearPolicySnapshot();
    await db.update(groupUserLimitPoliciesTable).set({ amountUsd: 13 }).where(and(
      eq(groupUserLimitPoliciesTable.workspaceId, "policyWs"),
      eq(groupUserLimitPoliciesTable.groupId, "group1"),
    ));
    await expect(db.transaction((tx) => disableFrozenClearPolicies(tx, frozen)))
      .rejects.toMatchObject({ status: 409 });
    expect((await db.select().from(groupUserLimitPoliciesTable).where(and(
      eq(groupUserLimitPoliciesTable.workspaceId, "policyWs"),
      eq(groupUserLimitPoliciesTable.groupId, "group1"),
    )))[0]).toMatchObject({ amountUsd: 13, isEnabled: true });
  });
});