import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { getDirectory, withEnterpriseIngestAccess } from "./lib/enterprise";
import {
  listReplitMemberBudgets,
  ReplitBudgetConnectorError,
  ReversibleBudgetCanaryError,
  runReversibleMemberBudgetCanary,
} from "./lib/replit-budgets";

function sanitize(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

const directory = await withEnterpriseIngestAccess(() => getDirectory(true));
let completed: {
  workspaceId: string;
  userId: string;
  result: Awaited<ReturnType<typeof runReversibleMemberBudgetCanary>>;
} | null = null;

for (const workspaceId of [...directory.workspaces.keys()].sort()) {
  const snapshot = await listReplitMemberBudgets(workspaceId);
  if (snapshot.status !== "available" || !snapshot.canWrite) continue;
  const members = [...directory.members.values()]
    .filter((candidate) =>
      /^[1-9]\d*$/.test(candidate.userId) &&
      candidate.workspaces.get(workspaceId)?.isDisabled === false
    )
    .sort((left, right) => {
      const leftExisting = snapshot.budgets.has(left.userId) ? 0 : 1;
      const rightExisting = snapshot.budgets.has(right.userId) ? 0 : 1;
      return leftExisting - rightExisting || left.userId.localeCompare(right.userId);
    });
  for (const member of members) {
    const previousAmountUsd = snapshot.budgets.get(member.userId)?.budgetUsd ?? null;
    const temporaryAmountUsd = Math.max(1_000_000, (previousAmountUsd ?? 0) + 0.01);
    try {
      completed = {
        workspaceId,
        userId: member.userId,
        result: await runReversibleMemberBudgetCanary(
          workspaceId,
          member.userId,
          temporaryAmountUsd,
        ),
      };
      break;
    } catch (error) {
      // A missing upstream target means this directory member cannot be used as
      // the canary. No temporary write occurred, so trying the next member is safe.
      const mutationError = error instanceof ReversibleBudgetCanaryError
        ? error.mutationError
        : error;
      if (
        mutationError instanceof ReplitBudgetConnectorError &&
        mutationError.upstreamStatus === 404 &&
        (!(error instanceof ReversibleBudgetCanaryError) ||
          error.restorationError === null)
      ) {
        continue;
      }
      throw error;
    }
  }
  if (completed) break;
}

if (!completed) {
  throw new Error("No active member with readable, write-capable budget state was available");
}

const evidence = {
  performedAt: new Date().toISOString(),
  workspaceRef: sanitize(completed.workspaceId),
  userRef: sanitize(completed.userId),
  priorState: completed.result.previousAmountUsd === null ? "unset" : "set",
  temporaryWriteConfirmed: true,
  restorationConfirmed:
    completed.result.restoredAmountUsd === completed.result.previousAmountUsd,
  restoredState: completed.result.restoredAmountUsd === null ? "unset" : "set",
};
await mkdir("evidence", { recursive: true });
await writeFile(
  "evidence/usage-limit-canary.json",
  `${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(JSON.stringify(evidence));