import { asc } from "drizzle-orm";
import {
  configurationRevisionTable,
  db,
  familyTeamMappingsTable,
  fundingGroupOverridesTable,
  groupBudgetsTable,
  teamBudgetAdjustmentsTable,
  teamBudgetsTable,
  teamLimitTargetsTable,
} from "@workspace/db";

type GroupBudget = typeof groupBudgetsTable.$inferSelect;
type TeamLimitTarget = typeof teamLimitTargetsTable.$inferSelect;
type TeamBudget = typeof teamBudgetsTable.$inferSelect;
type TeamBudgetAdjustment = typeof teamBudgetAdjustmentsTable.$inferSelect;
type FamilyTeamMapping = typeof familyTeamMappingsTable.$inferSelect;
type FundingGroupOverride = typeof fundingGroupOverridesTable.$inferSelect;

export interface ConfigurationSnapshot {
  /** Decimal bigint text; keep opaque rather than coercing it to a JS number. */
  revision: string;
  groupBudgets: readonly Readonly<GroupBudget>[];
  teamLimitTargets: readonly Readonly<TeamLimitTarget>[];
  teamBudgets: readonly Readonly<TeamBudget>[];
  teamBudgetAdjustments: readonly Readonly<TeamBudgetAdjustment>[];
  familyTeamMappings: readonly Readonly<FamilyTeamMapping>[];
  fundingGroupOverrides: readonly Readonly<FundingGroupOverride>[];
}

let revisionReadInFlight: Promise<string> | null = null;
let cachedSnapshot: ConfigurationSnapshot | null = null;
const snapshotLoads = new Map<string, Promise<ConfigurationSnapshot>>();

function immutableRows<Row extends Record<string, unknown>>(
  rows: readonly Row[],
): readonly Readonly<Row>[] {
  return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
}

/**
 * Reads only the singleton revision row. Concurrent callers share the query,
 * but the result is never TTL-cached, so a commit by another process is
 * visible to the next non-overlapping call.
 */
export function getConfigurationRevision(): Promise<string> {
  if (revisionReadInFlight) return revisionReadInFlight;
  const read = db
    .select({ revision: configurationRevisionTable.revision })
    .from(configurationRevisionTable)
    .then((rows) => {
      const revision = rows[0]?.revision;
      if (revision == null) {
        throw new Error("Configuration revision singleton is missing");
      }
      return revision.toString();
    });
  revisionReadInFlight = read;
  void read.then(
    () => {
      if (revisionReadInFlight === read) revisionReadInFlight = null;
    },
    () => {
      if (revisionReadInFlight === read) revisionReadInFlight = null;
    },
  );
  return read;
}

async function loadConsistentSnapshot(): Promise<ConfigurationSnapshot> {
  return db.transaction(async (tx) => {
    // This revision and all rows below share one repeatable-read database
    // snapshot. Reading the clock here also closes the race between the
    // lightweight preflight read and a concurrent commit.
    const revisionRows = await tx
      .select({ revision: configurationRevisionTable.revision })
      .from(configurationRevisionTable);
    const revision = revisionRows[0]?.revision;
    if (revision == null) {
      throw new Error("Configuration revision singleton is missing");
    }

    // A transaction is pinned to one pg client. Keep its statements ordered;
    // concurrency belongs at the pool level, not within a checked-out client.
    const groupBudgets = await tx.select().from(groupBudgetsTable)
      .orderBy(asc(groupBudgetsTable.groupId));
    const teamLimitTargets = await tx.select().from(teamLimitTargetsTable)
      .orderBy(
        asc(teamLimitTargetsTable.workspaceId),
        asc(teamLimitTargetsTable.groupId),
      );
    const teamBudgets = await tx.select().from(teamBudgetsTable)
      .orderBy(asc(teamBudgetsTable.teamName));
    const teamBudgetAdjustments = await tx.select()
      .from(teamBudgetAdjustmentsTable)
      .orderBy(
        asc(teamBudgetAdjustmentsTable.submissionPeriod),
        asc(teamBudgetAdjustmentsTable.id),
      );
    const familyTeamMappings = await tx.select()
      .from(familyTeamMappingsTable)
      .orderBy(
        asc(familyTeamMappingsTable.workspaceId),
        asc(familyTeamMappingsTable.familyKey),
      );
    const fundingGroupOverrides = await tx.select()
      .from(fundingGroupOverridesTable)
      .orderBy(
        asc(fundingGroupOverridesTable.workspaceId),
        asc(fundingGroupOverridesTable.groupId),
      );

    return Object.freeze({
      revision: revision.toString(),
      groupBudgets: immutableRows(groupBudgets),
      teamLimitTargets: immutableRows(teamLimitTargets),
      teamBudgets: immutableRows(teamBudgets),
      teamBudgetAdjustments: immutableRows(teamBudgetAdjustments),
      familyTeamMappings: immutableRows(familyTeamMappings),
      fundingGroupOverrides: immutableRows(fundingGroupOverrides),
    });
  }, { isolationLevel: "repeatable read" });
}

/**
 * Returns the reusable immutable snapshot for the currently committed
 * revision. Warm calls perform exactly one lightweight revision query.
 */
export async function getConfigurationSnapshot(): Promise<ConfigurationSnapshot> {
  const observedRevision = await getConfigurationRevision();
  if (cachedSnapshot?.revision === observedRevision) return cachedSnapshot;

  const existingLoad = snapshotLoads.get(observedRevision);
  if (existingLoad) return existingLoad;

  const load = loadConsistentSnapshot().then((snapshot) => {
    if (
      !cachedSnapshot ||
      BigInt(snapshot.revision) >= BigInt(cachedSnapshot.revision)
    ) {
      cachedSnapshot = snapshot;
    }
    return snapshot;
  });
  snapshotLoads.set(observedRevision, load);
  void load.then(
    () => snapshotLoads.delete(observedRevision),
    () => snapshotLoads.delete(observedRevision),
  );
  return load;
}

/** Test-only process-local reset; it never changes persisted state. */
export function resetConfigurationSnapshotForTests(): void {
  revisionReadInFlight = null;
  cachedSnapshot = null;
  snapshotLoads.clear();
}