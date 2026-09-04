import { ReplitConnectors } from "@replit/connectors-sdk";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  teamLimitTargetsTable,
  teamBudgetAdjustmentsTable,
  teamBudgetAllocationAuditsTable,
  teamBudgetSyncStateTable,
  teamBudgetUpstreamSyncTable,
  teamBudgetsTable,
  workspaceDefaultLimitTargetsTable,
} from "@workspace/db";
import {
  listBudgets,
  listReplitGroupBudgets,
  setReplitGroupBudget,
  setWorkspaceDefaultUserLimit,
} from "./replit-budgets";
import {
  getFreshDirectoryForLimitValidation,
  reconcilePersistedLimitWrite,
  buildCanonicalAccountDirectory,
  buildCanonicalEffectiveTeams,
  type CanonicalRoleGroup,
  type DirectoryCache,
  type EnterpriseGroup,
} from "./enterprise";
import { logger } from "./logger";

const AIRTABLE_CONNECTOR = "airtable";
export const TEAM_BUDGET_SOURCE = "airtable-finance-approval";
export const TEAM_BUDGET_SOURCE_TABLE = "Replit Finance Approval";
export const TEAM_BUDGET_REQUIRED_APPROVAL_STATUS = "Approved";
const AIRTABLE_CONFIG_ENV = {
  baseId: "AIRTABLE_TEAM_BUDGET_BASE_ID",
  tableId: "AIRTABLE_TEAM_BUDGET_TABLE_ID",
  approvalStatus: "AIRTABLE_TEAM_BUDGET_APPROVAL_STATUS_FIELD_ID",
  teamStatus: "AIRTABLE_TEAM_BUDGET_TEAM_STATUS_FIELD_ID",
  existingTeamName: "AIRTABLE_TEAM_BUDGET_EXISTING_TEAM_FIELD_ID",
  newTeamName: "AIRTABLE_TEAM_BUDGET_NEW_TEAM_FIELD_ID",
  amount: "AIRTABLE_TEAM_BUDGET_AMOUNT_FIELD_ID",
  period: "AIRTABLE_TEAM_BUDGET_PERIOD_FIELD_ID",
} as const;
const SYNC_STATE_ID = 1;
const LEGACY_EXACT_MATCHES = new Map([
  ["Growth Strategy & Operations", "DXP"],
  ["Growth Strategy & Operations DXP", "DXP"],
  ["Growth Strategy & Operations Non-DXP", "Non-DXP"],
]);

export interface AirtableBudgetRecord {
  id: string;
  createdTime?: string;
  updatedTime?: string;
  fields: Record<string, unknown>;
}

export type AirtableBudgetFetcher = () => Promise<AirtableBudgetRecord[]>;
export type AirtableBudgetTransport = (path: string) => Promise<Response>;
let fetchOverride: AirtableBudgetFetcher | null = null;
let transportOverride: AirtableBudgetTransport | null = null;
let refreshInFlight: ReturnType<typeof performTeamBudgetSnapshotRefresh> | null = null;
let upstreamReconciliationInFlight:
  ReturnType<typeof performTeamBudgetUpstreamReconciliation> | null = null;
type TeamBudgetDirectoryFetcher = () => Promise<
  Pick<DirectoryCache, "allGroups"> & Partial<Pick<DirectoryCache, "account">>
>;
let directoryFetchOverride: TeamBudgetDirectoryFetcher | null = null;

/** Test-only seam. */
export function setAirtableBudgetFetcherForTests(fetcher: AirtableBudgetFetcher | null): void {
  fetchOverride = fetcher;
}

/** Test-only seam for schema, pagination, and transport failure coverage. */
export function setAirtableBudgetTransportForTests(
  transport: AirtableBudgetTransport | null,
): void {
  transportOverride = transport;
}

/** Test-only seam; production always forces a fresh Enterprise directory. */
export function setTeamBudgetDirectoryFetcherForTests(
  fetcher: TeamBudgetDirectoryFetcher | null,
): void {
  directoryFetchOverride = fetcher;
}

async function fetchFreshLimitDirectory(): Promise<
  Pick<DirectoryCache, "allGroups" | "account">
> {
  const directory = await (directoryFetchOverride ?? getFreshDirectoryForLimitValidation)();
  return {
    allGroups: directory.allGroups,
    account: directory.account ?? buildCanonicalAccountDirectory({
      workspaces: new Map(),
      groups: directory.allGroups,
      groupMembers: new Map(),
      members: new Map(),
    }),
  };
}

function validateConfiguredTarget(
  target: Pick<typeof teamLimitTargetsTable.$inferSelect, "workspaceId" | "groupId">,
  directory: Pick<DirectoryCache, "allGroups" | "account">,
): { group: EnterpriseGroup | null; reason: string | null } {
  const group = directory.allGroups.find((candidate) =>
    candidate.workspaceId === target.workspaceId && candidate.id === target.groupId
  );
  if (!group) {
    return {
      group: null,
      reason: `Group ${target.groupId} is missing from workspace ${target.workspaceId}`,
    };
  }
  const roleGroup = directory.account.roleGroupsById.get(group.id);
  if (!roleGroup || !isAssignableTeamLimitGroup(roleGroup)) {
    return {
      group,
      reason: `Group ${target.groupId} in workspace ${target.workspaceId} is no longer an eligible nonlegacy member target`,
    };
  }
  return { group, reason: null };
}

export async function getFreshEligibleTeamLimitGroup(
  workspaceId: string,
  groupId: string,
): Promise<EnterpriseGroup | null> {
  const validation = validateConfiguredTarget(
    { workspaceId, groupId },
    await fetchFreshLimitDirectory(),
  );
  return validation.reason ? null : validation.group;
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
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = transportOverride
      ? await transportOverride(path)
      : await connectors.proxy(AIRTABLE_CONNECTOR, path, { method: "GET" });
    if (response.ok) {
      try {
        return await response.json();
      } catch {
        throw new Error(`Airtable ${path} returned invalid JSON`);
      }
    }
    if (response.status !== 429 || attempt === 2) {
      throw new Error(`Airtable ${path} failed: ${await readConnectorError(response)}`);
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    await new Promise((resolve) =>
      setTimeout(resolve, Number.isFinite(retryAfter) ? Math.max(0, retryAfter * 1000) : 250),
    );
  }
  throw new Error(`Airtable ${path} failed after retry`);
}

export interface AirtableSourceConfig {
  baseId: string;
  tableId: string;
  fields: {
    approvalStatus: string;
    teamStatus: string;
    existingTeamName: string;
    newTeamName: string;
    amount: string;
    period: string;
  };
}

function configuredAirtableSource(): AirtableSourceConfig {
  const missing = Object.entries(AIRTABLE_CONFIG_ENV)
    .filter(([, envName]) => !process.env[envName]?.trim())
    .map(([, envName]) => envName);
  if (missing.length) {
    throw new Error(
      `Airtable allocation source unavailable: missing stable source configuration ${missing.join(", ")}`,
    );
  }
  return {
    baseId: process.env[AIRTABLE_CONFIG_ENV.baseId]!.trim(),
    tableId: process.env[AIRTABLE_CONFIG_ENV.tableId]!.trim(),
    fields: {
      approvalStatus: process.env[AIRTABLE_CONFIG_ENV.approvalStatus]!.trim(),
      teamStatus: process.env[AIRTABLE_CONFIG_ENV.teamStatus]!.trim(),
      existingTeamName: process.env[AIRTABLE_CONFIG_ENV.existingTeamName]!.trim(),
      newTeamName: process.env[AIRTABLE_CONFIG_ENV.newTeamName]!.trim(),
      amount: process.env[AIRTABLE_CONFIG_ENV.amount]!.trim(),
      period: process.env[AIRTABLE_CONFIG_ENV.period]!.trim(),
    },
  };
}

export function getAirtableSourceConfigurationStatus(): {
  configured: boolean;
  baseId: string | null;
  tableId: string | null;
  reason: string | null;
} {
  try {
    const config = configuredAirtableSource();
    return {
      configured: true,
      baseId: config.baseId,
      tableId: config.tableId,
      reason: null,
    };
  } catch (error) {
    return {
      configured: false,
      baseId: null,
      tableId: null,
      reason: error instanceof Error ? error.message : "Airtable allocation source unavailable",
    };
  }
}

const FIELD_TYPE_CONTRACT: Record<keyof AirtableSourceConfig["fields"], ReadonlySet<string>> = {
  approvalStatus: new Set(["singleSelect", "singleLineText", "formula"]),
  teamStatus: new Set(["singleSelect", "singleLineText", "formula"]),
  existingTeamName: new Set(["singleLineText", "multilineText", "formula", "multipleRecordLinks"]),
  newTeamName: new Set(["singleLineText", "multilineText", "formula"]),
  amount: new Set(["number", "currency", "formula"]),
  period: new Set(["date", "dateTime", "singleLineText", "formula"]),
};

export function validateAirtableBudgetSchema(
  schema: unknown,
  config: AirtableSourceConfig,
): void {
  const tables = (schema as { tables?: unknown })?.tables;
  if (!Array.isArray(tables)) throw new Error("Airtable schema response is missing tables");
  const table = tables.find((candidate) =>
    candidate && typeof candidate === "object" &&
    (candidate as { id?: unknown }).id === config.tableId
  ) as { id: string; name?: string; fields?: unknown } | undefined;
  if (!table) throw new Error(`Configured Airtable table ${config.tableId} is unavailable`);
  if (!Array.isArray(table.fields)) {
    throw new Error(`Configured Airtable table ${config.tableId} has no readable field schema`);
  }
  const fieldsById = new Map(
    table.fields
      .filter((field): field is { id: string; name?: string; type?: string } =>
        !!field && typeof field === "object" && typeof (field as { id?: unknown }).id === "string")
      .map((field) => [field.id, field]),
  );
  for (const [kind, fieldId] of Object.entries(config.fields) as [
    keyof AirtableSourceConfig["fields"],
    string,
  ][]) {
    const field = fieldsById.get(fieldId);
    if (!field) throw new Error(`Configured Airtable ${kind} field ${fieldId} is unavailable`);
    if (!field.type || !FIELD_TYPE_CONTRACT[kind].has(field.type)) {
      throw new Error(
        `Configured Airtable ${kind} field ${fieldId} has unsupported type ${field.type ?? "(missing)"}`,
      );
    }
  }
}

export interface FetchedAirtableSnapshot {
  records: AirtableBudgetRecord[];
  baseId: string;
  tableId: string;
}

export async function fetchAirtableBudgetRecords(): Promise<FetchedAirtableSnapshot> {
  const config = configuredAirtableSource();
  const connectors = new ReplitConnectors();
  const schema = await getJson(
    connectors,
    `/v0/meta/bases/${encodeURIComponent(config.baseId)}/tables`,
  );
  validateAirtableBudgetSchema(schema, config);

  const records: AirtableBudgetRecord[] = [];
  let offset: string | undefined;
  const seenOffsets = new Set<string>();
  do {
    const query = new URLSearchParams({
      pageSize: "100",
      returnFieldsByFieldId: "true",
    });
    if (offset) query.set("offset", offset);
    const page = await getJson(
      connectors,
      `/v0/${encodeURIComponent(config.baseId)}/${encodeURIComponent(config.tableId)}?${query}`,
    );
    if (!Array.isArray(page.records)) throw new Error("Airtable returned an invalid records page");
    for (const raw of page.records) {
      if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.fields ||
        typeof raw.fields !== "object" || Array.isArray(raw.fields)) {
        throw new Error("Airtable returned an invalid record");
      }
      records.push({
        id: raw.id,
        createdTime: typeof raw.createdTime === "string" ? raw.createdTime : undefined,
        updatedTime: typeof raw.updatedTime === "string" ? raw.updatedTime : undefined,
        fields: {
          "Approval Status": raw.fields[config.fields.approvalStatus],
          "Team Status": raw.fields[config.fields.teamStatus],
          "Existing Team Name": raw.fields[config.fields.existingTeamName],
          "New Team Name": raw.fields[config.fields.newTeamName],
          "Total Credit Amount": raw.fields[config.fields.amount],
          "Submission Month/Year": raw.fields[config.fields.period],
        },
      });
    }
    if (page.offset != null && typeof page.offset !== "string") {
      throw new Error("Airtable returned an invalid pagination offset");
    }
    offset = page.offset;
    if (offset && seenOffsets.has(offset)) {
      throw new Error("Airtable returned a repeated pagination offset");
    }
    if (offset) seenOffsets.add(offset);
  } while (offset);
  return { records, baseId: config.baseId, tableId: config.tableId };
}

type ParsedAdjustment = typeof teamBudgetAdjustmentsTable.$inferInsert;

export function parseAirtableBudgetRecord(
  record: AirtableBudgetRecord,
  existingTeams: ReadonlySet<string>,
  acceptedNewTeamsByRecordId: ReadonlyMap<string, string> = new Map(),
  provenance: { baseId?: string; tableId?: string } = {},
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
    source: TEAM_BUDGET_SOURCE,
    sourceKind: "approved_credit",
    sourceBaseId: provenance.baseId ?? null,
    sourceTableId: provenance.tableId ?? null,
    sourceRecordId: record.id || "(missing)",
    sourceRecordUrl: provenance.baseId && provenance.tableId && record.id
      ? `https://airtable.com/${encodeURIComponent(provenance.baseId)}/${encodeURIComponent(provenance.tableId)}/${encodeURIComponent(record.id)}`
      : null,
    sourceTeamStatus: status,
    sourceTeamName: existingName ?? newName,
    teamName: errors.length === 0 ? selectedName : null,
    amountUsd: amount,
    submissionPeriod: period,
    matchState: errors.length === 0 ? "accepted" : (existingName ? "unmatched" : "invalid"),
    errorMessage: errors.length ? errors.join("; ") : null,
    isActive: true,
    retiredAt: null,
    retirementReason: null,
    sourceCreatedAt:
      record.createdTime && Number.isFinite(new Date(record.createdTime).getTime())
        ? new Date(record.createdTime)
        : null,
    sourceUpdatedAt:
      record.updatedTime && Number.isFinite(new Date(record.updatedTime).getTime())
        ? new Date(record.updatedTime)
        : null,
    ingestedAt: new Date(),
    syncedAt: new Date(),
  };
}

/** Last occurrence wins if a connector page is replayed, keyed by durable Airtable record ID. */
export function buildSnapshotRows(
  records: readonly AirtableBudgetRecord[],
  existingTeams: ReadonlySet<string>,
  acceptedNewTeamsByRecordId: ReadonlyMap<string, string> = new Map(),
  provenance: { baseId?: string; tableId?: string } = {},
): ParsedAdjustment[] {
  const byIdentity = new Map<string, AirtableBudgetRecord>();
  for (const record of records) {
    const approvalStatus = valueAsString(record.fields?.["Approval Status"]);
    if (approvalStatus?.toLowerCase() !== TEAM_BUDGET_REQUIRED_APPROVAL_STATUS.toLowerCase()) {
      continue;
    }
    byIdentity.set(record.id, record);
  }
  return [...byIdentity.values()].map((record) =>
    parseAirtableBudgetRecord(record, existingTeams, acceptedNewTeamsByRecordId, provenance),
  );
}

async function performTeamBudgetSnapshotRefresh(): Promise<{
  ok: boolean;
  recordCount: number;
  fetchedCount: number;
  approvedCount: number;
  acceptedCount: number;
  unmatchedCount: number;
  invalidCount: number;
  issueCount: number;
  error: string | null;
}> {
  const attemptedAt = new Date();
  try {
    const fetched = fetchOverride
      ? {
          records: await fetchOverride(),
          baseId: "test-configured-base",
          tableId: "test-configured-table",
        }
      : await fetchAirtableBudgetRecords();
    const { records, baseId, tableId } = fetched;
    const [current, priorAdjustments, groupAssignments] = await Promise.all([
      db.select().from(teamBudgetsTable),
      db.select().from(teamBudgetAdjustmentsTable),
      db.select({ teamName: teamLimitTargetsTable.teamName }).from(teamLimitTargetsTable),
    ]);
    const existingTeams = new Set(current.map((row) => row.teamName));
    const acceptedNewTeamsByRecordId = new Map(
      priorAdjustments
        .filter((row) =>
          row.source === TEAM_BUDGET_SOURCE &&
          row.matchState === "accepted" &&
          row.teamName &&
          row.sourceTeamStatus?.toLowerCase() === "new",
        )
        .map((row) => [row.sourceRecordId, row.teamName!]),
    );
    const parsed = buildSnapshotRows(
      records,
      existingTeams,
      acceptedNewTeamsByRecordId,
      { baseId, tableId },
    );
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
    const unmatchedCount = parsed.filter((row) => row.matchState === "unmatched").length;
    const invalidCount = parsed.filter((row) => row.matchState === "invalid").length;
    const issueCount = parsed.length - acceptedCount;
    const nextReferencedTeams = new Set([
      ...parsed
        .filter((row) => row.matchState === "accepted" && row.teamName)
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
      const retiredAt = new Date();
      await tx.update(teamBudgetAdjustmentsTable).set({
        isActive: false,
        retiredAt,
        retirementReason: "Record was removed or is no longer approved in the complete source snapshot",
      }).where(and(
        eq(teamBudgetAdjustmentsTable.source, TEAM_BUDGET_SOURCE),
        eq(teamBudgetAdjustmentsTable.isActive, true),
      ));
      await tx.update(teamBudgetAdjustmentsTable).set({
        isActive: false,
        retiredAt,
        retirementReason:
          "Legacy Airtable source retired; relationship to Finance Approval has not been verified",
      }).where(and(
        eq(teamBudgetAdjustmentsTable.source, "airtable"),
        eq(teamBudgetAdjustmentsTable.isActive, true),
      ));
      for (const row of parsed) {
        await tx.insert(teamBudgetAdjustmentsTable).values(row).onConflictDoUpdate({
          target: [
            teamBudgetAdjustmentsTable.source,
            teamBudgetAdjustmentsTable.sourceRecordId,
          ],
          set: row,
        });
      }
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
        sourceBaseId: baseId,
        sourceTableId: tableId,
        sourceAvailable: true,
        unavailableReason: null,
        fetchedCount: records.length,
        approvedCount: parsed.length,
        recordCount: parsed.length,
        acceptedCount,
        unmatchedCount,
        invalidCount,
        issueCount,
      }).onConflictDoUpdate({
        target: teamBudgetSyncStateTable.id,
        set: {
          lastAttemptAt: attemptedAt,
          lastSuccessfulAt: new Date(),
          lastError: null,
          sourceBaseId: baseId,
          sourceTableId: tableId,
          sourceAvailable: true,
          unavailableReason: null,
          fetchedCount: records.length,
          approvedCount: parsed.length,
          recordCount: parsed.length,
          acceptedCount,
          unmatchedCount,
          invalidCount,
          issueCount,
        },
      });
    });
    logger.info({
      event: "airtable_allocation_sync",
      outcome: "complete",
      source: TEAM_BUDGET_SOURCE,
      baseId,
      tableId,
      fetchedCount: records.length,
      approvedCount: parsed.length,
      acceptedCount,
      unmatchedCount,
      invalidCount,
    }, "Airtable allocation snapshot published");
    return {
      ok: true,
      recordCount: parsed.length,
      fetchedCount: records.length,
      approvedCount: parsed.length,
      acceptedCount,
      unmatchedCount,
      invalidCount,
      issueCount,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Airtable synchronization error";
    await db.insert(teamBudgetSyncStateTable).values({
      id: SYNC_STATE_ID,
      lastAttemptAt: attemptedAt,
      lastError: message,
      sourceAvailable: false,
      unavailableReason: message,
    }).onConflictDoUpdate({
      target: teamBudgetSyncStateTable.id,
      set: {
        lastAttemptAt: attemptedAt,
        lastError: message,
        sourceAvailable: false,
        unavailableReason: message,
      },
    });
    logger.error({
      event: "airtable_allocation_sync",
      outcome: "failed",
      source: TEAM_BUDGET_SOURCE,
      err: error,
    }, "Airtable allocation snapshot was not published");
    const [state] = await db.select().from(teamBudgetSyncStateTable)
      .where(eq(teamBudgetSyncStateTable.id, SYNC_STATE_ID));
    return {
      ok: false,
      recordCount: state?.recordCount ?? 0,
      fetchedCount: state?.fetchedCount ?? 0,
      approvedCount: state?.approvedCount ?? 0,
      acceptedCount: state?.acceptedCount ?? 0,
      unmatchedCount: state?.unmatchedCount ?? 0,
      invalidCount: state?.invalidCount ?? 0,
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

export async function getEffectiveTeamBudgets() {
  const [teams, adjustments, states] = await Promise.all([
    db.select().from(teamBudgetsTable).orderBy(asc(teamBudgetsTable.teamName)),
    db.select().from(teamBudgetAdjustmentsTable)
      .orderBy(asc(teamBudgetAdjustmentsTable.submissionPeriod), asc(teamBudgetAdjustmentsTable.id)),
    db.select().from(teamBudgetSyncStateTable).where(eq(teamBudgetSyncStateTable.id, SYNC_STATE_ID)),
  ]);
  const acceptedByTeam = new Map<string, number>();
  for (const adjustment of adjustments) {
    if (
      adjustment.source !== TEAM_BUDGET_SOURCE ||
      !adjustment.isActive ||
      adjustment.matchState !== "accepted" ||
      !adjustment.teamName ||
      adjustment.amountUsd == null
    ) continue;
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
      const monthlyLimitSource =
        team.monthlyLimitSource === "manual" && team.monthlyLimitUsd != null
          ? "manual"
          : "derived";
      return {
        ...team,
        originalAmountUsd,
        effectiveAmountUsd: originalAmountUsd + (acceptedByTeam.get(team.teamName) ?? 0),
        annualAllocationUsd: originalAmountUsd + (acceptedByTeam.get(team.teamName) ?? 0),
        monthlyLimitUsd: monthlyLimitSource === "manual"
          ? team.monthlyLimitUsd
          : Math.round(
              (originalAmountUsd + (acceptedByTeam.get(team.teamName) ?? 0)) / 12 * 100,
            ) / 100,
        monthlyLimitSource,
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

export async function updateTeamMonthlyLimit(
  teamName: string,
  monthlyLimitUsd: number | null,
) {
  const [updated] = await db.update(teamBudgetsTable).set({
    monthlyLimitUsd,
    monthlyLimitSource: monthlyLimitUsd == null ? "derived" : "manual",
  }).where(eq(teamBudgetsTable.teamName, teamName)).returning();
  if (!updated) return null;
  const snapshot = await getEffectiveTeamBudgets();
  return snapshot.teams.find((team) => team.teamName === teamName) ?? null;
}

export async function updateTeamAnnualAllocation(
  teamName: string,
  annualAllocationUsd: number,
  actorUserId: string,
) {
  const changed = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(teamBudgetsTable)
      .where(eq(teamBudgetsTable.teamName, teamName))
      .for("update");
    if (!current) return null;
    const currentAllocation =
      current.originalAmountUsd === 0 && current.amountUsd !== 0
        ? current.amountUsd
        : current.originalAmountUsd;
    if (currentAllocation === annualAllocationUsd) return current;
    const [updated] = await tx.update(teamBudgetsTable).set({
      originalAmountUsd: annualAllocationUsd,
      amountUsd: annualAllocationUsd,
    }).where(eq(teamBudgetsTable.teamName, teamName)).returning();
    await tx.insert(teamBudgetAllocationAuditsTable).values({
      teamName,
      field: "annualAllocationUsd",
      oldValue: currentAllocation,
      newValue: annualAllocationUsd,
      actorUserId,
    });
    return updated ?? null;
  });
  if (!changed) return null;
  const snapshot = await getEffectiveTeamBudgets();
  return snapshot.teams.find((team) => team.teamName === teamName) ?? null;
}

export async function updateTeamVisibility(
  teamName: string,
  isHidden: boolean,
  actorUserId: string,
) {
  const changed = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(teamBudgetsTable)
      .where(eq(teamBudgetsTable.teamName, teamName))
      .for("update");
    if (!current) return null;
    if (current.isHidden === isHidden) return current;
    const [updated] = await tx.update(teamBudgetsTable).set({ isHidden })
      .where(eq(teamBudgetsTable.teamName, teamName)).returning();
    await tx.insert(teamBudgetAllocationAuditsTable).values({
      teamName,
      field: "isHidden",
      oldValue: current.isHidden,
      newValue: isHidden,
      actorUserId,
    });
    return updated ?? null;
  });
  if (!changed) return null;
  const snapshot = await getEffectiveTeamBudgets();
  return snapshot.teams.find((team) => team.teamName === teamName) ?? null;
}

export async function getTeamAllocationAudits(teamName?: string) {
  const query = db.select().from(teamBudgetAllocationAuditsTable);
  return teamName
    ? query.where(eq(teamBudgetAllocationAuditsTable.teamName, teamName))
      .orderBy(desc(teamBudgetAllocationAuditsTable.createdAt), desc(teamBudgetAllocationAuditsTable.id))
    : query.orderBy(desc(teamBudgetAllocationAuditsTable.createdAt), desc(teamBudgetAllocationAuditsTable.id));
}

export async function assignTeamLimitTarget(input: {
  teamName: string;
  workspaceId: string;
  groupId: string;
  groupName: string;
}) {
  const [row] = await db.insert(teamLimitTargetsTable).values({
    ...input,
    assignmentSource: "manual",
  })
    .onConflictDoUpdate({
      target: [teamLimitTargetsTable.workspaceId, teamLimitTargetsTable.groupId],
      set: {
        teamName: input.teamName,
        groupName: input.groupName,
        assignmentSource: "manual",
        isEnabled: true,
      },
    }).returning();
  return row!;
}

export async function updateTeamLimitTargetOverride(
  workspaceId: string,
  groupId: string,
  monthlyLimitUsd: number | null,
) {
  const [row] = await db.update(teamLimitTargetsTable)
    .set({ monthlyLimitUsd })
    .where(and(
      eq(teamLimitTargetsTable.workspaceId, workspaceId),
      eq(teamLimitTargetsTable.groupId, groupId),
    )).returning();
  return row ?? null;
}

export async function updateLegacyWorkspaceLimit(monthlyLimitUsd: number | null) {
  const [row] = await db.update(workspaceDefaultLimitTargetsTable)
    .set({ monthlyLimitUsd: monthlyLimitUsd ?? 1 })
    .where(eq(workspaceDefaultLimitTargetsTable.workspaceId, "1awqan"))
    .returning();
  return row ?? null;
}

export async function getTeamLimitTargetConfiguration() {
  const [snapshot, storedTargets, legacy, directory] = await Promise.all([
    getEffectiveTeamBudgets(),
    db.select().from(teamLimitTargetsTable),
    db.select().from(workspaceDefaultLimitTargetsTable),
    fetchFreshLimitDirectory(),
  ]);
  const effectiveTeams = buildCanonicalEffectiveTeams(directory.account, storedTargets);
  const targets = storedTargets.map((target) => ({
    ...target,
    teamName: effectiveTeams.byRoleGroupId.get(target.groupId) ?? target.teamName,
  }));
  const teamLimits = new Map(snapshot.teams.map((team) => [team.teamName, team.monthlyLimitUsd]));
  const validationByIdentity = new Map(targets.map((target) => [
    `${target.workspaceId}\0${target.groupId}`,
    validateConfiguredTarget(target, directory),
  ]));
  const enabledCount = new Map<string, number>();
  for (const target of targets) {
    if (
      target.isEnabled &&
      !validationByIdentity.get(`${target.workspaceId}\0${target.groupId}`)?.reason
    ) {
      enabledCount.set(target.teamName, (enabledCount.get(target.teamName) ?? 0) + 1);
    }
  }
  const configured = targets.map((target) => {
    const teamMonthlyLimitUsd = teamLimits.get(target.teamName) ?? 0;
    const targetAmountUsd = calculateTeamTargetAmount(
      teamMonthlyLimitUsd,
      enabledCount.get(target.teamName) ?? 1,
      target.monthlyLimitUsd,
    );
    return { ...target, teamMonthlyLimitUsd, targetAmountUsd };
  });
  const sums = new Map<string, number>();
  for (const target of configured.filter((row) =>
    row.isEnabled &&
    !validationByIdentity.get(`${row.workspaceId}\0${row.groupId}`)?.reason
  )) {
    sums.set(target.teamName, (sums.get(target.teamName) ?? 0) + target.targetAmountUsd);
  }
  const assigned = new Set(targets.map((target) => `${target.workspaceId}\0${target.groupId}`));
  return {
    targets: configured,
    teams: snapshot.teams.filter((team) => !team.isHidden).map((team) => ({
      teamName: team.teamName,
      monthlyLimitUsd: team.monthlyLimitUsd,
      targetAmountSumUsd: Math.round((sums.get(team.teamName) ?? 0) * 100) / 100,
      differenceUsd: Math.round(
        ((sums.get(team.teamName) ?? 0) - (team.monthlyLimitUsd ?? 0)) * 100,
      ) / 100,
    })),
    legacy,
    unassignedGroups: [...directory.account.roleGroupsById.values()]
      .filter((roleGroup) =>
        isAssignableTeamLimitGroup(roleGroup) &&
        !assigned.has(`${roleGroup.workspaceId}\0${roleGroup.id}`)
      )
      .map((roleGroup) =>
        directory.allGroups.find((group) =>
          group.workspaceId === roleGroup.workspaceId && group.id === roleGroup.id
        )!
      ),
  };
}

export function isAssignableTeamLimitGroup(group: CanonicalRoleGroup): boolean {
  return !group.isLegacy && group.role === "member";
}

type UpstreamSyncInsert = typeof teamBudgetUpstreamSyncTable.$inferInsert;

async function persistUpstreamSync(row: UpstreamSyncInsert): Promise<void> {
  const mutable = {
    teamName: row.teamName,
    workspaceId: row.workspaceId,
    targetGroupId: row.targetGroupId,
    targetGroupName: row.targetGroupName,
    targetType: row.targetType,
    desiredAmountUsd: row.desiredAmountUsd,
    upstreamAmountUsd: row.upstreamAmountUsd,
    status: row.status,
    reason: row.reason,
    lastAttemptAt: row.lastAttemptAt,
  };
  try {
    await db.insert(teamBudgetUpstreamSyncTable).values(row).onConflictDoUpdate({
      target: [
        teamBudgetUpstreamSyncTable.workspaceId,
        teamBudgetUpstreamSyncTable.targetType,
        teamBudgetUpstreamSyncTable.targetGroupId,
      ],
      set: mutable,
    });
  } catch (error) {
    // Rolling-migration compatibility for processes that start before the
    // corrective exact-identity index DDL is applied.
    const cause = (error as { cause?: { code?: string } }).cause;
    if (cause?.code !== "42P10") throw error;
    await db.insert(teamBudgetUpstreamSyncTable).values(row).onConflictDoUpdate({
      target: [
        teamBudgetUpstreamSyncTable.teamName,
        teamBudgetUpstreamSyncTable.targetGroupId,
      ],
      set: mutable,
    });
  }
}

function amountsMatch(desired: number, upstream: number | null): boolean {
  const desiredCents = Math.round(desired * 100);
  if (desiredCents === 0) {
    return upstream == null || Math.round(upstream * 100) === 0;
  }
  return upstream != null && desiredCents === Math.round(upstream * 100);
}

function readBudgetAmount(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["budgetUsd", "amountUsd", "limitUsd", "amount", "limit"]) {
    const candidate = record[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  for (const nested of Object.values(record)) {
    if (nested && typeof nested === "object") {
      const candidate = readBudgetAmount(nested);
      if (candidate != null) return candidate;
    }
  }
  return null;
}

export function calculateTeamTargetAmount(
  teamMonthlyLimitUsd: number,
  enabledTargetCount: number,
  targetOverrideUsd: number | null,
): number {
  if (targetOverrideUsd != null) return targetOverrideUsd;
  return Math.round(teamMonthlyLimitUsd / Math.max(1, enabledTargetCount) * 100) / 100;
}

async function performTeamBudgetUpstreamReconciliation(): Promise<void> {
  const attemptedAt = new Date();
  const [budgetSnapshot, storedTargets, legacyTargets, directory] = await Promise.all([
    getEffectiveTeamBudgets(),
    db.select().from(teamLimitTargetsTable),
    db.select().from(workspaceDefaultLimitTargetsTable),
    fetchFreshLimitDirectory(),
  ]);
  const effectiveTeams = buildCanonicalEffectiveTeams(directory.account, storedTargets);
  const targets = storedTargets.map((target) => ({
    ...target,
    teamName: effectiveTeams.byRoleGroupId.get(target.groupId) ?? target.teamName,
  }));
  const validationByIdentity = new Map(targets.map((target) => [
    `${target.workspaceId}\0${target.groupId}`,
    validateConfiguredTarget(target, directory),
  ]));
  const budgetMap = new Map(
    budgetSnapshot.teams
      .filter((team) => !team.isHidden)
      .map((team) => [team.teamName, team.monthlyLimitUsd]),
  );
  const enabledByTeam = new Map<string, number>();
  for (const target of targets) {
    if (
      target.isEnabled &&
      !validationByIdentity.get(`${target.workspaceId}\0${target.groupId}`)?.reason
    ) {
      enabledByTeam.set(target.teamName, (enabledByTeam.get(target.teamName) ?? 0) + 1);
    }
  }
  const resolvedByWorkspace = new Map<string, Array<{
    target: typeof teamLimitTargetsTable.$inferSelect;
    desiredAmountUsd: number;
  }>>();
  for (const target of targets.filter((row) => row.isEnabled)) {
    const validation = validationByIdentity.get(`${target.workspaceId}\0${target.groupId}`)!;
    if (validation.reason) {
      const teamLimit = budgetMap.get(target.teamName) ?? 0;
      await persistUpstreamSync({
        teamName: target.teamName,
        workspaceId: target.workspaceId,
        targetGroupId: target.groupId,
        targetGroupName: target.groupName,
        targetType: "group",
        desiredAmountUsd: calculateTeamTargetAmount(
          teamLimit,
          enabledByTeam.get(target.teamName) ?? 1,
          target.monthlyLimitUsd,
        ),
        upstreamAmountUsd: null,
        status: "failed",
        reason: validation.reason,
        lastAttemptAt: attemptedAt,
      });
      continue;
    }
    const teamLimit = budgetMap.get(target.teamName);
    if (teamLimit == null) continue;
    const desiredAmountUsd = calculateTeamTargetAmount(
      teamLimit,
      enabledByTeam.get(target.teamName) ?? 1,
      target.monthlyLimitUsd,
    );
    const rows = resolvedByWorkspace.get(target.workspaceId) ?? [];
    rows.push({ target, desiredAmountUsd });
    resolvedByWorkspace.set(target.workspaceId, rows);
  }

  for (const [workspaceId, teams] of resolvedByWorkspace) {
    const snapshot = await listReplitGroupBudgets(workspaceId);
    if (snapshot.status !== "available") {
      for (const { target, desiredAmountUsd } of teams) {
        await persistUpstreamSync({
          teamName: target.teamName,
          workspaceId,
          targetGroupId: target.groupId,
          targetGroupName: target.groupName,
          targetType: "group",
          desiredAmountUsd,
          upstreamAmountUsd: null,
          status: "failed",
          reason: snapshot.error ?? "The Replit group budget feed could not be read",
          lastAttemptAt: attemptedAt,
        });
      }
      continue;
    }

    for (const team of teams) {
      const { target, desiredAmountUsd } = team;
      const current = snapshot.budgets.get(target.groupId)?.budgetUsd ?? null;
      const baseRow = {
        teamName: target.teamName,
        workspaceId,
        targetGroupId: target.groupId,
        targetGroupName: target.groupName,
        targetType: "group" as const,
        desiredAmountUsd,
        upstreamAmountUsd: current,
        lastAttemptAt: attemptedAt,
      };
      if (amountsMatch(desiredAmountUsd, current)) {
        await persistUpstreamSync({
          ...baseRow,
          status: "synced",
          reason: null,
        });
      } else {
        await persistUpstreamSync({
          ...baseRow,
          status: "drift",
          reason: null,
        });
      }
    }
  }

  for (const legacy of legacyTargets.filter((row) => row.isEnabled)) {
    try {
      const raw = await listBudgets("workspace_default_user_limit", legacy.workspaceId);
      const upstreamAmountUsd = raw.length ? readBudgetAmount(raw[0]) : null;
      await persistUpstreamSync({
        teamName: legacy.displayName,
        workspaceId: legacy.workspaceId,
        targetGroupId: null,
        targetGroupName: legacy.displayName,
        targetType: "workspace_default",
        desiredAmountUsd: legacy.monthlyLimitUsd,
        upstreamAmountUsd,
        status: amountsMatch(legacy.monthlyLimitUsd, upstreamAmountUsd) ? "synced" : "drift",
        reason: null,
        lastAttemptAt: attemptedAt,
      });
    } catch (error) {
      await persistUpstreamSync({
        teamName: legacy.displayName,
        workspaceId: legacy.workspaceId,
        targetGroupId: null,
        targetGroupName: legacy.displayName,
        targetType: "workspace_default",
        desiredAmountUsd: legacy.monthlyLimitUsd,
        upstreamAmountUsd: null,
        status: "failed",
        reason: error instanceof Error ? error.message : "Workspace default budget read failed",
        lastAttemptAt: attemptedAt,
      });
    }
  }

  // Remove only identities that are no longer enabled/configured. Unlike a
  // table-wide pre-delete, this cannot erase rows inserted by a concurrent
  // reconciliation process.
  await db.execute(sql`
    DELETE FROM ${teamBudgetUpstreamSyncTable} AS sync
    WHERE NOT (
      (
        sync.target_type = 'group'
        AND EXISTS (
          SELECT 1
          FROM ${teamLimitTargetsTable} AS target
          WHERE target.workspace_id = sync.workspace_id
            AND target.group_id = sync.target_group_id
            AND target.is_enabled = true
        )
      )
      OR
      (
        sync.target_type = 'workspace_default'
        AND EXISTS (
          SELECT 1
          FROM ${workspaceDefaultLimitTargetsTable} AS target
          WHERE target.workspace_id = sync.workspace_id
            AND target.is_enabled = true
        )
      )
    )
  `);
}

/** A process-local single flight shared by direct and queued reconciliations. */
export function reconcileTeamBudgetsUpstream(): Promise<void> {
  if (upstreamReconciliationInFlight) return upstreamReconciliationInFlight;
  upstreamReconciliationInFlight = performTeamBudgetUpstreamReconciliation().finally(() => {
    upstreamReconciliationInFlight = null;
  });
  return upstreamReconciliationInFlight;
}

/** Queue reconciliation without delaying the successful local snapshot response. */
export function queueTeamBudgetUpstreamReconciliation(): void {
  void reconcileTeamBudgetsUpstream().catch((err) => {
    logger.error({ err }, "Team budget upstream reconciliation failed");
  });
}

export async function getTeamBudgetUpstreamSyncRows() {
  return db.select().from(teamBudgetUpstreamSyncTable)
    .orderBy(
      asc(teamBudgetUpstreamSyncTable.teamName),
      asc(teamBudgetUpstreamSyncTable.targetGroupName),
    );
}

export interface ApplyTeamBudgetTargetOutcome {
  workspaceId: string;
  targetGroupId: string | null;
  targetGroupName: string;
  desiredAmountUsd: number;
  outcome: "success" | "failed";
  error: string | null;
}

export async function applyTeamBudgetLimits(
  selection:
    | { all: true }
    | { teamNames: string[] }
    | { targets: Array<{ workspaceId: string; groupId?: string | null }> },
) {
  const [allRows, groupTargets, legacyTargets] = await Promise.all([
    getTeamBudgetUpstreamSyncRows(),
    db.select().from(teamLimitTargetsTable),
    db.select().from(workspaceDefaultLimitTargetsTable),
  ]);
  const enabledGroups = new Set(
    groupTargets
      .filter((target) => target.isEnabled)
      .map((target) => `${target.workspaceId}\0${target.groupId}`),
  );
  const enabledDefaults = new Set(
    legacyTargets
      .filter((target) => target.isEnabled)
      .map((target) => target.workspaceId),
  );
  const rows = allRows.filter((row) =>
    row.targetType === "workspace_default"
      ? !!row.workspaceId && enabledDefaults.has(row.workspaceId)
      : !!row.workspaceId && !!row.targetGroupId &&
        enabledGroups.has(`${row.workspaceId}\0${row.targetGroupId}`)
  );
  const selectedRows = "all" in selection
    ? rows.filter((row) => row.status === "drift")
    : "teamNames" in selection
      ? rows.filter((row) =>
          row.status === "drift" && new Set(selection.teamNames).has(row.teamName)
        )
      : rows.filter((row) => selection.targets.some((target) =>
          target.workspaceId === row.workspaceId &&
          (target.groupId ?? null) === row.targetGroupId
        ));
  const requested = new Set(selectedRows.map((row) => row.teamName));
  const byTeam = new Map<string, ApplyTeamBudgetTargetOutcome[]>();
  for (const teamName of requested) {
    const targets = selectedRows.filter((row) =>
      row.teamName === teamName &&
      row.workspaceId &&
      row.targetGroupName
    );
    const outcomes: ApplyTeamBudgetTargetOutcome[] = [];
    for (const target of targets) {
      try {
        if (target.targetType === "workspace_default") {
          await setWorkspaceDefaultUserLimit(
            target.workspaceId!,
            Math.round(target.desiredAmountUsd * 100) === 0 ? null : target.desiredAmountUsd,
          );
          await reconcilePersistedLimitWrite({
            type: "workspace_default_user_limit",
            workspaceId: target.workspaceId!,
            amountUsd: Math.round(target.desiredAmountUsd * 100) === 0
              ? null
              : target.desiredAmountUsd,
          });
        } else {
          const validation = validateConfiguredTarget(
            {
              workspaceId: target.workspaceId!,
              groupId: target.targetGroupId!,
            },
            await fetchFreshLimitDirectory(),
          );
          if (validation.reason) {
            if ("targets" in selection) {
              outcomes.push({
                workspaceId: target.workspaceId!,
                targetGroupId: target.targetGroupId,
                targetGroupName: target.targetGroupName!,
                desiredAmountUsd: target.desiredAmountUsd,
                outcome: "failed",
                error: validation.reason,
              });
            }
            continue;
          }
          await setReplitGroupBudget(
            target.workspaceId!,
            target.targetGroupId!,
            Math.round(target.desiredAmountUsd * 100) === 0 ? null : target.desiredAmountUsd,
          );
          await reconcilePersistedLimitWrite({
            type: "workspace_group_limit",
            workspaceId: target.workspaceId!,
            groupId: target.targetGroupId!,
            amountUsd: Math.round(target.desiredAmountUsd * 100) === 0
              ? null
              : target.desiredAmountUsd,
          });
        }
        outcomes.push({
          workspaceId: target.workspaceId!,
          targetGroupId: target.targetGroupId,
          targetGroupName: target.targetGroupName!,
          desiredAmountUsd: target.desiredAmountUsd,
          outcome: "success",
          error: null,
        });
      } catch (error) {
        outcomes.push({
          workspaceId: target.workspaceId!,
          targetGroupId: target.targetGroupId,
          targetGroupName: target.targetGroupName!,
          desiredAmountUsd: target.desiredAmountUsd,
          outcome: "failed",
          error: error instanceof Error ? error.message : "Group budget mutation failed",
        });
      }
    }
    if (outcomes.length > 0) byTeam.set(teamName, outcomes);
  }
  await reconcileTeamBudgetsUpstream();
  return {
    teams: [...byTeam].map(([teamName, targets]) => ({
      teamName,
      outcome: targets.length > 0 && targets.every((target) => target.outcome === "success")
        ? "success" as const
        : "failed" as const,
      targets,
    })),
  };
}