import { ReplitConnectors } from "@replit/connectors-sdk";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  db,
  groupTeamsTable,
  teamBudgetAdjustmentsTable,
  teamBudgetSyncStateTable,
  teamBudgetsTable,
} from "@workspace/db";
import { logger } from "./logger";

const AIRTABLE_CONNECTOR = "airtable";
const BASE_NAMES = [
  "Project Management",
  "LIFT Labs Master Project Management",
] as const;
const TABLE_NAME = "Replit Order Forms";
const SYNC_STATE_ID = 1;
export const TEAM_BUDGET_SYNC_INTERVAL_MS = 60 * 60 * 1000;
const LEGACY_EXACT_MATCHES = new Map([
  ["Growth Strategy & Operations", "DXP"],
  ["Growth Strategy & Operations DXP", "DXP"],
  ["Growth Strategy & Operations Non-DXP", "Non-DXP"],
]);

export interface AirtableBudgetRecord {
  id: string;
  createdTime?: string;
  fields: Record<string, unknown>;
}

export type AirtableBudgetFetcher = () => Promise<AirtableBudgetRecord[]>;
let fetchOverride: AirtableBudgetFetcher | null = null;
let refreshInFlight: ReturnType<typeof performTeamBudgetSnapshotRefresh> | null = null;

/** Test-only seam. */
export function setAirtableBudgetFetcherForTests(fetcher: AirtableBudgetFetcher | null): void {
  fetchOverride = fetcher;
}

function valueAsString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") {
    return value[0].trim() || null;
  }
  return null;
}

function parseAmount(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const parsed = Number(value.replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Produces YYYY-MM for stable chronological ordering without guessing invalid dates. */
export function parseSubmissionPeriod(value: unknown): string | null {
  const raw = valueAsString(value);
  if (!raw) return null;
  const iso = /^(\d{4})-(0[1-9]|1[0-2])(?:-\d{2})?$/.exec(raw);
  if (iso) return `${iso[1]}-${iso[2]}`;
  const named = /^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[,\s]+(\d{4})$/i.exec(raw);
  if (!named) return null;
  const month = new Map([
    ["jan", 1], ["feb", 2], ["mar", 3], ["apr", 4], ["may", 5], ["jun", 6],
    ["jul", 7], ["aug", 8], ["sep", 9], ["oct", 10], ["nov", 11], ["dec", 12],
  ]).get(named[1]!.slice(0, 3).toLowerCase());
  if (!month) return null;
  return `${named[2]}-${String(month).padStart(2, "0")}`;
}

async function readConnectorError(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return `${response.status} ${response.statusText}`.trim();
  try {
    const body = JSON.parse(text) as { error?: { message?: string } | string };
    return typeof body.error === "string" ? body.error : body.error?.message ?? text;
  } catch {
    return text;
  }
}

async function getJson(connectors: ReplitConnectors, path: string): Promise<any> {
  const response = await connectors.proxy(AIRTABLE_CONNECTOR, path, { method: "GET" });
  if (!response.ok) throw new Error(`Airtable ${path} failed: ${await readConnectorError(response)}`);
  return response.json();
}

async function fetchAirtableBudgetRecords(): Promise<AirtableBudgetRecord[]> {
  const connectors = new ReplitConnectors();
  const bases = await getJson(connectors, "/v0/meta/bases");
  const base = BASE_NAMES
    .map((name) => (bases.bases ?? []).find((candidate: any) => candidate.name === name))
    .find((candidate) => candidate?.id);
  if (!base?.id) {
    throw new Error(`Airtable base was not found (expected one of: ${BASE_NAMES.join(", ")})`);
  }
  const schema = await getJson(connectors, `/v0/meta/bases/${encodeURIComponent(base.id)}/tables`);
  const table = (schema.tables ?? []).find((candidate: any) => candidate.name === TABLE_NAME);
  if (!table?.id) throw new Error(`Airtable table "${TABLE_NAME}" was not found in "${base.name}"`);

  const records: AirtableBudgetRecord[] = [];
  let offset: string | undefined;
  do {
    const query = new URLSearchParams({ pageSize: "100" });
    if (offset) query.set("offset", offset);
    const page = await getJson(
      connectors,
      `/v0/${encodeURIComponent(base.id)}/${encodeURIComponent(table.id)}?${query}`,
    );
    if (!Array.isArray(page.records)) throw new Error("Airtable returned an invalid records page");
    records.push(...page.records);
    offset = typeof page.offset === "string" ? page.offset : undefined;
  } while (offset);
  return records;
}

type ParsedAdjustment = typeof teamBudgetAdjustmentsTable.$inferInsert;

export function parseAirtableBudgetRecord(
  record: AirtableBudgetRecord,
  existingTeams: ReadonlySet<string>,
  acceptedNewTeamsByRecordId: ReadonlyMap<string, string> = new Map(),
): ParsedAdjustment {
  const fields = record.fields ?? {};
  const status = valueAsString(fields["Team Status"]);
  const normalizedStatus = status?.toLowerCase() ?? null;
  const existingName = valueAsString(fields["Existing Team Name"]);
  const newName = valueAsString(fields["New Team Name"]);
  const amount = parseAmount(fields["Total Credit Amount"]);
  const period = parseSubmissionPeriod(fields["Submission Month/Year"]);
  const selectedName =
    normalizedStatus === "existing" && existingName
      ? (LEGACY_EXACT_MATCHES.get(existingName) ?? existingName)
      : normalizedStatus === "new"
        ? newName
        : null;
  const errors: string[] = [];

  if (!record.id) errors.push("Missing Airtable record identity");
  if (!status) errors.push("Missing Team Status");
  if (status && normalizedStatus !== "existing" && normalizedStatus !== "new") {
    errors.push('Team Status must be exactly "Existing" or "New"');
  } else if (normalizedStatus === "existing") {
    if (!existingName || newName) {
      errors.push('Existing records require only Existing Team Name');
    }
  } else if (normalizedStatus === "new") {
    if (!newName || existingName) {
      errors.push('New records require only New Team Name');
    } else if (
      existingTeams.has(newName) &&
      acceptedNewTeamsByRecordId.get(record.id) !== newName
    ) {
      errors.push(`New Team Name "${newName}" already exists`);
    }
  }
  if (amount == null || amount <= 0) errors.push("Total Credit Amount must be a positive number");
  if (!period) errors.push("Submission Month/Year must be a valid month and year");
  if (existingName && selectedName && !existingTeams.has(selectedName)) {
    errors.push(`Existing Team Name "${existingName}" has no exact match`);
  }

  return {
    source: "airtable",
    sourceRecordId: record.id || "(missing)",
    sourceTeamStatus: status,
    sourceTeamName: existingName ?? newName,
    teamName: errors.length === 0 ? selectedName : null,
    amountUsd: amount,
    submissionPeriod: period,
    matchState: errors.length === 0 ? "accepted" : (existingName ? "unmatched" : "invalid"),
    errorMessage: errors.length ? errors.join("; ") : null,
    sourceUpdatedAt:
      record.createdTime && Number.isFinite(new Date(record.createdTime).getTime())
        ? new Date(record.createdTime)
        : null,
    syncedAt: new Date(),
  };
}

/** Last occurrence wins if a connector page is replayed, keyed by durable Airtable record ID. */
export function buildSnapshotRows(
  records: readonly AirtableBudgetRecord[],
  existingTeams: ReadonlySet<string>,
  acceptedNewTeamsByRecordId: ReadonlyMap<string, string> = new Map(),
): ParsedAdjustment[] {
  const byIdentity = new Map<string, AirtableBudgetRecord>();
  for (const record of records) byIdentity.set(record.id, record);
  return [...byIdentity.values()].map((record) =>
    parseAirtableBudgetRecord(record, existingTeams, acceptedNewTeamsByRecordId),
  );
}

async function performTeamBudgetSnapshotRefresh(): Promise<{
  ok: boolean;
  recordCount: number;
  acceptedCount: number;
  issueCount: number;
  error: string | null;
}> {
  const attemptedAt = new Date();
  try {
    const records = await (fetchOverride ?? fetchAirtableBudgetRecords)();
    const [current, priorAdjustments, groupAssignments] = await Promise.all([
      db.select().from(teamBudgetsTable),
      db.select().from(teamBudgetAdjustmentsTable),
      db.select({ teamName: groupTeamsTable.teamName }).from(groupTeamsTable),
    ]);
    const existingTeams = new Set(current.map((row) => row.teamName));
    const acceptedNewTeamsByRecordId = new Map(
      priorAdjustments
        .filter((row) =>
          row.source === "airtable" &&
          row.matchState === "accepted" &&
          row.teamName &&
          row.sourceTeamStatus?.toLowerCase() === "new",
        )
        .map((row) => [row.sourceRecordId, row.teamName!]),
    );
    const parsed = buildSnapshotRows(records, existingTeams, acceptedNewTeamsByRecordId);
    const acceptedNewTeams = [
      ...new Set(
        parsed
          .filter((row) =>
            row.matchState === "accepted" &&
            row.teamName &&
            row.sourceTeamStatus?.toLowerCase() === "new",
          )
          .map((row) => row.teamName!),
      ),
    ];
    const acceptedCount = parsed.filter((row) => row.matchState === "accepted").length;
    const issueCount = parsed.length - acceptedCount;
    const nextReferencedTeams = new Set([
      ...parsed
        .filter((row) => row.matchState === "accepted" && row.teamName)
        .map((row) => row.teamName!),
      ...priorAdjustments
        .filter((row) => row.source !== "airtable" && row.matchState === "accepted" && row.teamName)
        .map((row) => row.teamName!),
    ]);
    const assignedTeams = new Set(groupAssignments.map((row) => row.teamName));
    const staleSourceCreatedTeams = [
      ...new Set(acceptedNewTeamsByRecordId.values()),
    ].filter((teamName) =>
      !nextReferencedTeams.has(teamName) && !assignedTeams.has(teamName),
    );

    await db.transaction(async (tx) => {
      if (acceptedNewTeams.length) {
        await tx.insert(teamBudgetsTable).values(
          acceptedNewTeams.map((teamName) => ({
            teamName,
            amountUsd: 0,
            originalAmountUsd: 0,
          })),
        ).onConflictDoNothing();
      }
      await tx.delete(teamBudgetAdjustmentsTable).where(eq(teamBudgetAdjustmentsTable.source, "airtable"));
      if (parsed.length) await tx.insert(teamBudgetAdjustmentsTable).values(parsed);
      if (staleSourceCreatedTeams.length) {
        await tx.delete(teamBudgetsTable).where(and(
          inArray(teamBudgetsTable.teamName, staleSourceCreatedTeams),
          eq(teamBudgetsTable.originalAmountUsd, 0),
          eq(teamBudgetsTable.amountUsd, 0),
        ));
      }
      await tx.insert(teamBudgetSyncStateTable).values({
        id: SYNC_STATE_ID,
        lastAttemptAt: attemptedAt,
        lastSuccessfulAt: new Date(),
        lastError: null,
        recordCount: parsed.length,
        acceptedCount,
        issueCount,
      }).onConflictDoUpdate({
        target: teamBudgetSyncStateTable.id,
        set: {
          lastAttemptAt: attemptedAt,
          lastSuccessfulAt: new Date(),
          lastError: null,
          recordCount: parsed.length,
          acceptedCount,
          issueCount,
        },
      });
    });
    return { ok: true, recordCount: parsed.length, acceptedCount, issueCount, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Airtable synchronization error";
    await db.insert(teamBudgetSyncStateTable).values({
      id: SYNC_STATE_ID,
      lastAttemptAt: attemptedAt,
      lastError: message,
    }).onConflictDoUpdate({
      target: teamBudgetSyncStateTable.id,
      set: { lastAttemptAt: attemptedAt, lastError: message },
    });
    const [state] = await db.select().from(teamBudgetSyncStateTable)
      .where(eq(teamBudgetSyncStateTable.id, SYNC_STATE_ID));
    return {
      ok: false,
      recordCount: state?.recordCount ?? 0,
      acceptedCount: state?.acceptedCount ?? 0,
      issueCount: state?.issueCount ?? 0,
      error: message,
    };
  }
}

export function refreshTeamBudgetSnapshot(): ReturnType<typeof performTeamBudgetSnapshotRefresh> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = performTeamBudgetSnapshotRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/**
 * Run the read-only Airtable synchronization hourly. The next attempt is
 * scheduled only after the current one completes, and manual refreshes share
 * the same in-flight promise, so connector requests never overlap.
 */
export function startTeamBudgetSyncJob(): void {
  const schedule = (): void => {
    const timer = setTimeout(() => {
      void refreshTeamBudgetSnapshot()
        .then((result) => {
          if (result.ok) {
            logger.info({
              recordCount: result.recordCount,
              acceptedCount: result.acceptedCount,
              issueCount: result.issueCount,
            }, "Hourly team budget synchronization completed");
          } else {
            logger.warn({ error: result.error }, "Hourly team budget synchronization failed");
          }
        })
        .catch((err) => {
          logger.error({ err }, "Hourly team budget synchronization crashed");
        })
        .finally(schedule);
    }, TEAM_BUDGET_SYNC_INTERVAL_MS);
    timer.unref();
  };

  schedule();
}

export async function getEffectiveTeamBudgets() {
  const [teams, adjustments, states] = await Promise.all([
    db.select().from(teamBudgetsTable).orderBy(asc(teamBudgetsTable.teamName)),
    db.select().from(teamBudgetAdjustmentsTable)
      .orderBy(asc(teamBudgetAdjustmentsTable.submissionPeriod), asc(teamBudgetAdjustmentsTable.id)),
    db.select().from(teamBudgetSyncStateTable).where(eq(teamBudgetSyncStateTable.id, SYNC_STATE_ID)),
  ]);
  const acceptedByTeam = new Map<string, number>();
  for (const adjustment of adjustments) {
    if (adjustment.matchState !== "accepted" || !adjustment.teamName || adjustment.amountUsd == null) continue;
    acceptedByTeam.set(
      adjustment.teamName,
      (acceptedByTeam.get(adjustment.teamName) ?? 0) + adjustment.amountUsd,
    );
  }
  return {
    teams: teams.map((team) => {
      // `amountUsd` is retained through the rolling migration and remains the
      // compatibility base for rows created before schema-push environments
      // have run the idempotent original-allocation seed.
      const originalAmountUsd =
        team.originalAmountUsd === 0 && team.amountUsd !== 0
          ? team.amountUsd
          : team.originalAmountUsd;
      return {
        ...team,
        originalAmountUsd,
        effectiveAmountUsd:
          originalAmountUsd + (acceptedByTeam.get(team.teamName) ?? 0),
      };
    }),
    adjustments,
    sync: states[0] ?? null,
  };
}

export async function getVisibleEffectiveTeamBudgetMap(): Promise<Map<string, number>> {
  const snapshot = await getEffectiveTeamBudgets();
  return new Map(
    snapshot.teams
      .filter((team) => !team.isHidden)
      .map((team) => [team.teamName, team.effectiveAmountUsd]),
  );
}