import { describe, expect, it, vi } from "vitest";
import {
  applyMemberLimitPlan,
  classifyCurrentMemberLimit,
  resolveMemberBaseline,
  type MemberLimitPolicy,
  type MemberLimitPolicyAssignment,
  type MemberLimitPolicyWriter,
} from "./member-limit-policies";
import { isInternalReplitEmail } from "./enterprise";

const workspaceId = "workspace1";
const defaultPolicy: MemberLimitPolicy = {
  workspaceId,
  sourceType: "workspace_default",
  sourceId: workspaceId,
  amountUsd: 30,
  isEnabled: true,
};
const assignments = new Map<string, MemberLimitPolicyAssignment>();

function writer(
  setMemberLimit: MemberLimitPolicyWriter["setMemberLimit"] = vi.fn(),
): MemberLimitPolicyWriter {
  return {
    setMemberLimit,
    saveAssignment: vi.fn().mockResolvedValue(undefined),
    deleteAssignment: vi.fn().mockResolvedValue(undefined),
  };
}

describe("member limit policy resolution", () => {
  it("classifies trimmed case-insensitive Replit employee addresses", () => {
    expect(isInternalReplitEmail("  Employee@REPL.IT ")).toBe(true);
    expect(isInternalReplitEmail("employee@replit.com")).toBe(false);
    expect(isInternalReplitEmail("employee@notrepl.it")).toBe(false);
  });

  it("chooses the lowest positive policy across overlapping groups", () => {
    const policies: MemberLimitPolicy[] = [
      defaultPolicy,
      {
        workspaceId,
        sourceType: "group",
        sourceId: "group-a",
        amountUsd: 20,
        isEnabled: true,
      },
      {
        workspaceId,
        sourceType: "group",
        sourceId: "group-b",
        amountUsd: 10,
        isEnabled: true,
      },
      {
        workspaceId,
        sourceType: "group",
        sourceId: "disabled",
        amountUsd: 1,
        isEnabled: false,
      },
    ];

    expect(
      resolveMemberBaseline(
        workspaceId,
        "user1",
        policies,
        new Map([
          ["group-a", ["user1"]],
          ["group-b", ["user1"]],
          ["disabled", ["user1"]],
        ]),
      ),
    ).toEqual({
      amountUsd: 10,
      sourceType: "group",
      sourceId: "group-b",
    });
  });

  it("falls back to the workspace default outside configured groups", () => {
    expect(
      resolveMemberBaseline(
        workspaceId,
        "user2",
        [defaultPolicy],
        new Map(),
      ),
    ).toEqual({
      amountUsd: 30,
      sourceType: "workspace_default",
      sourceId: workspaceId,
    });
  });

  it("only regards a current value as managed when it matches tracking", () => {
    const tracked = {
      workspaceId,
      userId: "user1",
      lastAmountUsd: 10,
      sourceType: "group" as const,
      sourceId: "group-a",
    };
    expect(classifyCurrentMemberLimit(null, tracked).kind).toBe("no_limit");
    expect(classifyCurrentMemberLimit(10, tracked).kind).toBe("policy_managed");
    expect(classifyCurrentMemberLimit(11, tracked)).toEqual({
      kind: "hand_set_override",
      amountUsd: 11,
    });
  });
});

describe("member limit policy application", () => {
  it("does not apply or clear policy-managed state for internal members", async () => {
    const policyWriter = writer();
    const internalAssignment: MemberLimitPolicyAssignment = {
      workspaceId,
      userId: "employee",
      lastAmountUsd: 20,
      sourceType: "group",
      sourceId: "old-group",
    };
    const outcomes = await applyMemberLimitPlan(
      {
        workspaceId,
        userIds: ["employee"],
        policies: [defaultPolicy],
        groupMembers: new Map(),
        currentLimits: new Map([["employee", 20]]),
        assignments: new Map([["employee", internalAssignment]]),
        members: new Map([["employee", { email: " EMPLOYEE@REPL.IT " }]]),
      },
      policyWriter,
    );

    expect(outcomes[0]).toMatchObject({
      userId: "employee",
      status: "internal_excluded",
      previousAmountUsd: 20,
    });
    expect(policyWriter.setMemberLimit).not.toHaveBeenCalled();
    expect(policyWriter.deleteAssignment).not.toHaveBeenCalled();
    expect(policyWriter.saveAssignment).not.toHaveBeenCalled();
  });

  it("preserves a hand-set override and applies a baseline to an unset member", async () => {
    const policyWriter = writer();
    const outcomes = await applyMemberLimitPlan(
      {
        workspaceId,
        userIds: ["override", "new"],
        policies: [defaultPolicy],
        groupMembers: new Map(),
        currentLimits: new Map([
          ["override", 99],
          ["new", null],
        ]),
        assignments,
      },
      policyWriter,
    );

    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "override_preserved",
      "applied",
    ]);
    expect(policyWriter.setMemberLimit).toHaveBeenCalledTimes(1);
    expect(policyWriter.setMemberLimit).toHaveBeenCalledWith(
      workspaceId,
      "new",
      30,
    );
    expect(policyWriter.saveAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "new", lastAmountUsd: 30 }),
    );
  });

  it("continues after a per-user failure and returns every outcome", async () => {
    const policyWriter = writer(
      vi.fn(async (_workspaceId, userId) => {
        if (userId === "bad") throw new Error("upstream rejected member");
      }),
    );
    const outcomes = await applyMemberLimitPlan(
      {
        workspaceId,
        userIds: ["first", "bad", "last"],
        policies: [defaultPolicy],
        groupMembers: new Map(),
        currentLimits: new Map(),
        assignments,
      },
      policyWriter,
    );

    expect(outcomes.map(({ userId, status }) => ({ userId, status }))).toEqual([
      { userId: "first", status: "applied" },
      { userId: "bad", status: "failed" },
      { userId: "last", status: "applied" },
    ]);
    expect(outcomes[1]?.error).toBe("upstream rejected member");
    expect(policyWriter.saveAssignment).not.toHaveBeenCalledWith(
      expect.objectContaining({ userId: "bad" }),
    );
  });

  it("awaits each upstream write before starting the next", async () => {
    let activeWrites = 0;
    let maxActiveWrites = 0;
    const order: string[] = [];
    const policyWriter = writer(
      vi.fn(async (_workspaceId, userId) => {
        order.push(`start:${userId}`);
        activeWrites++;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        await Promise.resolve();
        activeWrites--;
        order.push(`end:${userId}`);
      }),
    );

    await applyMemberLimitPlan(
      {
        workspaceId,
        userIds: ["one", "two", "three"],
        policies: [defaultPolicy],
        groupMembers: new Map(),
        currentLimits: new Map(),
        assignments,
      },
      policyWriter,
    );

    expect(maxActiveWrites).toBe(1);
    expect(order).toEqual([
      "start:one",
      "end:one",
      "start:two",
      "end:two",
      "start:three",
      "end:three",
    ]);
  });

  it("recalculates managed values to null when their policy is cleared", async () => {
    const prior: MemberLimitPolicyAssignment = {
      workspaceId,
      userId: "user1",
      lastAmountUsd: 30,
      sourceType: "workspace_default",
      sourceId: workspaceId,
    };
    const policyWriter = writer();
    const [outcome] = await applyMemberLimitPlan(
      {
        workspaceId,
        userIds: ["user1"],
        policies: [],
        groupMembers: new Map(),
        currentLimits: new Map([["user1", 30]]),
        assignments: new Map([["user1", prior]]),
      },
      policyWriter,
    );

    expect(outcome?.status).toBe("cleared");
    expect(policyWriter.setMemberLimit).toHaveBeenCalledWith(
      workspaceId,
      "user1",
      null,
    );
    expect(policyWriter.deleteAssignment).toHaveBeenCalledWith(
      workspaceId,
      "user1",
    );
  });
});