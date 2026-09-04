import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { db } from "@workspace/db";
import {
  apiBillingPeriodCacheTable,
  apiBillingPeriodObservationTable,
  apiDirectoryCacheTable,
  apiProjectMetadataStateTable,
  apiProjectMetadataTable,
} from "@workspace/db/schema";
import {
  applyFamilyMappingBackfill,
  type DiscoveredFamilyMapping,
} from "@workspace/db/seed-teams";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import {
  buildCanonicalAccountDirectory,
  isCustomGroup,
  isInternalReplitEmail,
  LEGACY_WORKSPACE_ID,
  parseDirectoryGroupName,
  persistCanonicalFamilyFinancialRows,
  type CanonicalAccountDirectory,
  type EnterpriseGroup,
  type EnterpriseMember,
  type EnterpriseWorkspace,
  type FamilyMapping,
} from "./enterprise-directory";
export {
  buildCanonicalAccountDirectory,
  buildCanonicalEffectiveTeams,
  isInternalReplitEmail,
  isInternalReplitMember,
  isCustomGroup,
  LEGACY_WORKSPACE_ID,
  normalizeFamilyKey,
  parseDirectoryGroupName,
  persistCanonicalFamilyFinancialRows,
  type CanonicalAccountDirectory,
  type CanonicalEffectiveTeams,
  type CanonicalFamily,
  type CanonicalRoleGroup,
  type CanonicalTeamTarget,
  type CanonicalWorkspace,
  type DirectoryRole,
  type EnterpriseGroup,
  type EnterpriseMember,
  type EnterpriseWorkspace,
} from "./enterprise-directory";
export {
  buildCanonicalGroupMergePlan,
  resolveCanonicalMergedGroupBudget,
  type CanonicalGroupMergePlan,
  type CanonicalMergedGroupBudget,
} from "./enterprise-directory-merge";
import {
  resolveUsageWindow,
  USAGE_DATA_CUTOFF_ISO,
  USAGE_DATA_CUTOFF_MS,
  type UsageWindowSelection,
} from "./usage-window";
import { ENTERPRISE_USAGE_REQUESTS_PER_MINUTE } from "./enterprise-rate-limit";

const BASE_URL = "https://api.replit.com/v1";
const DIRECTORY_TTL_MS = 15 * 60_000;
const BILLING_PERIOD_REFRESH_MS = 24 * 60 * 60_000;
const PROJECT_INFO_TTL_MS = 15 * 60_000;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT = 100;

export const ENTERPRISE_REQUEST_TIMEOUT_MS = 30_000;
export const SPEND_DATA_CUTOFF_ISO = USAGE_DATA_CUTOFF_ISO;
export const SPEND_DATA_CUTOFF_MS = USAGE_DATA_CUTOFF_MS;
export const SPEND_DATA_CUTOFF_LABEL = "May 2026-present";
export const FULL_TERM_RANGE_KEY = "full-term:from-cutoff";
export const PACE_FALLBACK_END_ISO = "2027-05-17T00:00:00.000Z";

export type EnterpriseWorkload = "interactive" | "scheduled" | "backfill";
const ingestContext = new AsyncLocalStorage<boolean>();
const limitValidationContext = new AsyncLocalStorage<boolean>();
const workloadContext = new AsyncLocalStorage<EnterpriseWorkload>();
let lastApiError: string | null = null;
let lastApiOk = false;

export function isConfigured(): boolean {
  return !!process.env["REPLIT_ENTERPRISE_API_KEY"];
}

export function withEnterpriseIngestAccess<T>(work: () => Promise<T>): Promise<T> {
  return ingestContext.run(true, work);
}

export function getApiHealth(): { ok: boolean; error: string | null } {
  return { ok: lastApiOk, error: lastApiError };
}

class EnterpriseApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function nextFixedMinute(now = Date.now()): number {
  return (Math.floor(now / DEFAULT_WINDOW_MS) + 1) * DEFAULT_WINDOW_MS;
}

function rateHeader(headers: Headers, names: string[]): number | null {
  for (const name of names) {
    const raw = headers.get(name);
    const value = raw === null ? NaN : Number(raw);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function resetTimestamp(value: number, now: number): number {
  if (value > 10_000_000_000) return value;
  if (value > 1_000_000_000) return value * 1000;
  return now + value * 1000;
}

class EnterpriseRateBudget {
  private limit = DEFAULT_RATE_LIMIT;
  private remaining = DEFAULT_RATE_LIMIT;
  private resetAt = Date.now() + DEFAULT_WINDOW_MS;
  private localWindowResetAt = nextFixedMinute();
  private localTotalUsed = 0;
  private localUsageUsed = 0;
  private embargoUntil = 0;

  private roll(now: number): void {
    if (now >= this.localWindowResetAt) {
      this.localWindowResetAt = nextFixedMinute(now);
      this.localTotalUsed = 0;
      this.localUsageUsed = 0;
    }
    if (now >= this.resetAt) {
      this.remaining = this.limit;
      this.resetAt = now + DEFAULT_WINDOW_MS;
    }
  }

  async admit(isUsage: boolean): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.roll(now);
      if (
        now >= this.embargoUntil &&
        this.remaining > 0 &&
        this.localTotalUsed < 600 &&
        (!isUsage || this.localUsageUsed < ENTERPRISE_USAGE_REQUESTS_PER_MINUTE)
      ) {
        this.remaining--;
        this.localTotalUsed++;
        if (isUsage) this.localUsageUsed++;
        return;
      }
      const wakeAt = now < this.embargoUntil
        ? this.embargoUntil
        : this.remaining <= 0
          ? this.resetAt
          : this.localWindowResetAt;
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, wakeAt - now)));
    }
  }

  observe(headers: Headers, status: number): void {
    const now = Date.now();
    this.roll(now);
    const limit = rateHeader(headers, ["X-RateLimit-Limit", "RateLimit-Limit"]);
    const remaining = rateHeader(headers, ["X-RateLimit-Remaining", "RateLimit-Remaining"]);
    const reset = rateHeader(headers, ["X-RateLimit-Reset", "RateLimit-Reset"]);
    const retryAfter = rateHeader(headers, ["Retry-After"]);
    if (limit !== null) this.limit = Math.max(1, Math.floor(limit));
    if (remaining !== null) this.remaining = Math.floor(remaining);
    if (reset !== null) this.resetAt = Math.max(now + 1, resetTimestamp(reset, now));
    if (status === 429 || status === 409 || status === 503) {
      if (status === 429) this.remaining = 0;
      const retryDelay = retryAfter == null
        ? (status === 429
            ? reset === null
              ? 5_000
              : Math.max(0, resetTimestamp(reset, now) - now)
            : 0)
        : retryAfter * 1_000;
      this.embargoUntil = Math.max(
        this.embargoUntil,
        now + retryDelay,
      );
      if (status === 429 && reset === null) {
        this.resetAt = this.embargoUntil;
      } else {
        this.resetAt = Math.max(this.resetAt, this.embargoUntil);
      }
    }
  }
}

const enterpriseBudget = new EnterpriseRateBudget();

/** Shared admission lane for non-usage Admin API transports such as budgets. */
export async function admitEnterpriseAdminRequest(): Promise<void> {
  await enterpriseBudget.admit(false);
}

/** Feed every Admin API response back into the account-scoped rate scheduler. */
export function observeEnterpriseAdminResponse(response: Response): void {
  enterpriseBudget.observe(response.headers, response.status);
}

async function rawFetch(
  path: string,
  params: Record<string, string | undefined>,
): Promise<{ body: unknown; headers: Headers }> {
  if (
    process.env.NODE_ENV !== "test" &&
    !ingestContext.getStore() &&
    !limitValidationContext.getStore()
  ) {
    throw new EnterpriseApiError(
      0,
      "Enterprise API access is restricted to the usage ingestion scheduler",
    );
  }
  const key = process.env["REPLIT_ENTERPRISE_API_KEY"];
  if (!key) throw new EnterpriseApiError(0, "REPLIT_ENTERPRISE_API_KEY is not set");
  const url = new URL(BASE_URL + path);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(name, value);
  }
  await enterpriseBudget.admit(path === "/usage");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(ENTERPRISE_REQUEST_TIMEOUT_MS),
  });
  enterpriseBudget.observe(response.headers, response.status);
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("Retry-After") ?? "5");
    throw Object.assign(new EnterpriseApiError(429, "rate limited"), {
      retryAfterMs: Math.max(1000, retryAfter * 1000),
    });
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new EnterpriseApiError(
      response.status,
      `Enterprise API ${path} failed (${response.status}): ${text.slice(0, 300)}`,
    );
  }
  return { body: await response.json(), headers: response.headers };
}

export function fetchEnterpriseForIngest(
  path: string,
  params: Record<string, string | undefined>,
): Promise<{ body: unknown; headers: Headers }> {
  return workloadContext.run("scheduled", () => rawFetch(path, params));
}

interface Pagination {
  cursor?: string | null;
  nextCursor?: string | null;
  hasMore: boolean;
}

async function paginate<T>(
  path: string,
  params: Record<string, string | undefined>,
  maxPages = 200,
): Promise<T[]> {
  const result: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    let response: { body: unknown; headers: Headers } | undefined;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        response = await rawFetch(path, { ...params, limit: "100", cursor });
        break;
      } catch (error) {
        if (!(error instanceof EnterpriseApiError) || error.status !== 429 || attempt === 5) {
          throw error;
        }
      }
    }
    const payload = response!.body as { data?: T[]; pagination?: Pagination };
    if (!Array.isArray(payload.data)) {
      throw new Error(`Enterprise API ${path} response omitted data`);
    }
    lastApiOk = true;
    lastApiError = null;
    result.push(...payload.data);
    if (!payload.pagination?.hasMore) return result;
    cursor = payload.pagination.nextCursor ?? payload.pagination.cursor ?? undefined;
    if (!cursor) throw new Error(`Enterprise API ${path} pagination omitted cursor`);
  }
  throw new Error(`Enterprise API ${path} exceeded ${maxPages} pages`);
}

export interface UsageRange {
  key: string;
  label: string;
  params: Record<string, string>;
}

function formatPeriodLabel(startIso: string, endIso: string): string {
  const format = (iso: string) => new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return `${format(startIso)} – ${format(endIso)}`;
}

interface StoredBillingPeriod {
  start: string;
  end: string;
  fetchedAt: number;
}
let billingPeriodCache: StoredBillingPeriod | null = null;

function getActiveBillingPeriod(now = Date.now()): StoredBillingPeriod | null {
  if (!billingPeriodCache) return null;
  const start = Date.parse(billingPeriodCache.start);
  const end = Date.parse(billingPeriodCache.end);
  return Number.isFinite(start) && Number.isFinite(end) && end > start && end > now
    ? billingPeriodCache
    : null;
}

export interface BillingPeriodMetadata {
  start: string;
  end: string;
  fetchedAt: string | null;
  isFresh: boolean;
  isFallback: boolean;
  differsFromReportingCutoff: boolean;
  label: string;
}

export function getBillingPeriodMetadata(): BillingPeriodMetadata {
  const cached = getActiveBillingPeriod();
  const start = cached?.start ?? SPEND_DATA_CUTOFF_ISO;
  const end = cached?.end ?? PACE_FALLBACK_END_ISO;
  return {
    start,
    end,
    fetchedAt: cached ? new Date(cached.fetchedAt).toISOString() : null,
    isFresh: !!cached && Date.now() - cached.fetchedAt < BILLING_PERIOD_REFRESH_MS,
    isFallback: !cached,
    differsFromReportingCutoff:
      Math.max(Date.parse(start), SPEND_DATA_CUTOFF_MS) !== SPEND_DATA_CUTOFF_MS,
    label: formatPeriodLabel(start, end),
  };
}

export function getBillingPeriod(): { start: string; end: string; label: string } {
  const period = getBillingPeriodMetadata();
  return { start: period.start, end: period.end, label: period.label };
}

export function resolvePostgresUsageWindow(
  rangeType: string | undefined,
  startDate?: string,
  endDate?: string,
  now = new Date(),
): UsageWindowSelection {
  const active = getActiveBillingPeriod(now.getTime());
  return resolveUsageWindow({
    rangeType,
    startDate,
    endDate,
    now,
    billingPeriod: active ? { start: active.start, end: active.end } : null,
  });
}

export async function refreshBillingPeriodMetadata(force = false): Promise<boolean> {
  if (!isConfigured()) return false;
  if (
    !force &&
    billingPeriodCache &&
    Date.now() - billingPeriodCache.fetchedAt < BILLING_PERIOD_REFRESH_MS
  ) return false;
  const { body } = await rawFetch("/usage", { billingPeriod: "current" });
  const interval = (body as {
    data?: { interval?: { startTime?: string; endTime?: string } };
  }).data?.interval;
  const start = new Date(interval?.startTime ?? "");
  const end = new Date(interval?.endTime ?? "");
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    throw new Error("Enterprise API returned an invalid current billing interval");
  }
  const period = { start: start.toISOString(), end: end.toISOString(), fetchedAt: Date.now() };
  const [observation] = await db.select().from(apiBillingPeriodObservationTable)
    .where(eq(apiBillingPeriodObservationTable.id, "current"));
  const same = observation?.periodStart.toISOString() === period.start &&
    observation.periodEnd.toISOString() === period.end;
  const count = same ? observation.consecutiveCount + 1 : 1;
  await db.insert(apiBillingPeriodObservationTable).values({
    id: "current",
    periodStart: start,
    periodEnd: end,
    consecutiveCount: count,
    observedAt: new Date(period.fetchedAt),
  }).onConflictDoUpdate({
    target: apiBillingPeriodObservationTable.id,
    set: {
      periodStart: start,
      periodEnd: end,
      consecutiveCount: count,
      observedAt: new Date(period.fetchedAt),
    },
  });
  const alreadyAdopted = billingPeriodCache?.start === period.start &&
    billingPeriodCache.end === period.end;
  if (!alreadyAdopted && count < 2) return true;
  await db.insert(apiBillingPeriodCacheTable).values({
    id: "current",
    periodStart: start,
    periodEnd: end,
    fetchedAt: new Date(period.fetchedAt),
  }).onConflictDoUpdate({
    target: apiBillingPeriodCacheTable.id,
    set: { periodStart: start, periodEnd: end, fetchedAt: new Date(period.fetchedAt) },
  });
  billingPeriodCache = period;
  return true;
}

interface RawMember {
  user: {
    id: string;
    username: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    isAccountAdmin?: boolean;
    is_account_admin?: boolean;
  };
  isAccountAdmin?: boolean;
  user_is_account_admin?: boolean;
  role?: string;
  organizationRole?: string;
  accountRole?: string;
  workspaces: { id: string; role: string; isDisabled: boolean }[];
}
const RAW_ADMIN_ROLES = new Set(["admin", "owner", "account_admin"]);
export function parseIsAccountAdmin(member: RawMember): boolean {
  return member.isAccountAdmin === true ||
    member.user_is_account_admin === true ||
    member.user.isAccountAdmin === true ||
    member.user.is_account_admin === true ||
    [member.role, member.organizationRole, member.accountRole]
      .some((role) => typeof role === "string" && RAW_ADMIN_ROLES.has(role.trim().toLowerCase()));
}

export interface PlatformBudgets {
  groupLimits: Map<string, Map<string, number>>;
  userLimits: Map<string, Map<string, number>>;
  workspaceDefaults: Map<string, number>;
  observation: LimitObservation;
}
export type LimitObservationStatus =
  | "complete"
  | "failed"
  | "unavailable"
  | "refreshing";
export interface LimitObservation {
  status: LimitObservationStatus;
  /** Time of the most recent attempt, retained for backwards compatibility. */
  observedAt: number | null;
  /** Time of the last authoritative complete result, including an empty result. */
  lastSuccessfulAt: number | null;
  lastAttemptAt: number | null;
  refreshStartedAt: number | null;
  generation: string | null;
  error: string | null;
}
export type PersistedLimitWrite =
  | { type: "workspace_user_limit"; workspaceId: string; userId: string; amountUsd: number | null }
  | { type: "workspace_group_limit"; workspaceId: string; groupId: string; amountUsd: number | null }
  | { type: "workspace_default_user_limit"; workspaceId: string; amountUsd: number | null };
export interface RawBudget {
  type: string;
  workspaceId?: string;
  groupId?: string;
  userId?: string;
  amountUsd?: number;
}
export interface DirectoryCache {
  fetchedAt: number;
  workspaces: Map<string, EnterpriseWorkspace>;
  groups: EnterpriseGroup[];
  allGroups: EnterpriseGroup[];
  groupMembers: Map<string, string[]>;
  members: Map<string, EnterpriseMember>;
  internalUserIds: Set<string>;
  budgets: PlatformBudgets;
  account: CanonicalAccountDirectory;
}
export interface DirectoryFreshness {
  dataAsOf: string | null;
  isStale: boolean;
  isRefreshing: boolean;
}

export interface DirectoryHydrationState {
  status: "pending" | "ready" | "unavailable";
  reason: "not_started" | "hydrated" | "not_found" | "lookup_failed";
}

export interface SerializedDirectory {
  fetchedAt: number;
  workspaces: Record<string, EnterpriseWorkspace>;
  groups: EnterpriseGroup[];
  allGroups?: EnterpriseGroup[];
  groupMembers: Record<string, string[]>;
  members: Record<string, Omit<EnterpriseMember, "workspaces"> & {
    workspaces: Record<string, { role: string; isDisabled: boolean }>;
  }>;
  budgets: {
    groupLimits: Record<string, Record<string, number>>;
    userLimits: Record<string, Record<string, number>>;
    workspaceDefaults: Record<string, number>;
    observation?: Partial<LimitObservation> & {
      status: LimitObservationStatus;
      observedAt: number | null;
      error: string | null;
    };
  };
  familyMappings?: FamilyMapping[];
}

let directoryCache: DirectoryCache | null = null;
let directoryPromise: Promise<DirectoryCache> | null = null;
let directoryHydrationState: DirectoryHydrationState = {
  status: "pending",
  reason: "not_started",
};
let limitCommitQueue: Promise<void> = Promise.resolve();
let activeLimitRefresh: { acknowledgedWrites: PersistedLimitWrite[] } | null = null;

function unavailableLimitObservation(): LimitObservation {
  return {
    status: "unavailable",
    observedAt: null,
    lastSuccessfulAt: null,
    lastAttemptAt: null,
    refreshStartedAt: null,
    generation: null,
    error: null,
  };
}

function normalizeLimitObservation(
  value: SerializedDirectory["budgets"]["observation"],
): LimitObservation {
  if (!value) return unavailableLimitObservation();
  const legacySuccess = value.status === "complete" ? value.observedAt : null;
  const lastSuccessfulAt = value.lastSuccessfulAt ?? legacySuccess;
  const interrupted = value.status === "refreshing";
  return {
    status: interrupted ? "failed" : value.status,
    observedAt: value.observedAt,
    lastSuccessfulAt,
    lastAttemptAt: value.lastAttemptAt ?? value.observedAt,
    refreshStartedAt: interrupted
      ? null
      : (value.refreshStartedAt ?? null),
    generation: value.generation ??
      (lastSuccessfulAt === null ? null : `legacy-${lastSuccessfulAt}`),
    error: interrupted
      ? "Limit observation refresh was interrupted before completion"
      : value.error,
  };
}

export function hasSuccessfulLimitObservation(
  budgets: Pick<PlatformBudgets, "observation">,
): boolean {
  return budgets.observation.lastSuccessfulAt !== null &&
    budgets.observation.generation !== null;
}

function cloneLimitMaps(
  budgets: PlatformBudgets | null | undefined = undefined,
): PlatformBudgets {
  return {
    groupLimits: new Map([...(budgets?.groupLimits ?? [])].map(([workspaceId, limits]) =>
      [workspaceId, new Map(limits)])),
    userLimits: new Map([...(budgets?.userLimits ?? [])].map(([workspaceId, limits]) =>
      [workspaceId, new Map(limits)])),
    workspaceDefaults: new Map(budgets?.workspaceDefaults ?? []),
    observation: budgets
      ? { ...budgets.observation }
      : unavailableLimitObservation(),
  };
}

function limitGeneration(budgets: PlatformBudgets, observedAt: number): string {
  const canonical = {
    groupLimits: [...budgets.groupLimits].sort(([a], [b]) => a.localeCompare(b))
      .map(([workspaceId, limits]) => [
        workspaceId,
        [...limits].sort(([a], [b]) => a.localeCompare(b)),
      ]),
    userLimits: [...budgets.userLimits].sort(([a], [b]) => a.localeCompare(b))
      .map(([workspaceId, limits]) => [
        workspaceId,
        [...limits].sort(([a], [b]) => a.localeCompare(b)),
      ]),
    workspaceDefaults: [...budgets.workspaceDefaults]
      .sort(([a], [b]) => a.localeCompare(b)),
    observedAt,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 24);
}

function applyLimitWrite(
  budgets: PlatformBudgets,
  write: PersistedLimitWrite,
): void {
  if (write.type === "workspace_default_user_limit") {
    if (write.amountUsd === null) budgets.workspaceDefaults.delete(write.workspaceId);
    else budgets.workspaceDefaults.set(write.workspaceId, write.amountUsd);
    return;
  }
  const source = write.type === "workspace_user_limit"
    ? budgets.userLimits
    : budgets.groupLimits;
  const id = write.type === "workspace_user_limit" ? write.userId : write.groupId;
  const limits = new Map(source.get(write.workspaceId) ?? []);
  if (write.amountUsd === null) limits.delete(id);
  else limits.set(id, write.amountUsd);
  if (limits.size === 0) source.delete(write.workspaceId);
  else source.set(write.workspaceId, limits);
}

export function mergeCompletedBudgetsWithAcknowledgedWrites(
  completed: PlatformBudgets,
  writes: readonly PersistedLimitWrite[],
): PlatformBudgets {
  const merged = cloneLimitMaps(completed);
  for (const write of writes) applyLimitWrite(merged, write);
  if (merged.observation.lastSuccessfulAt !== null) {
    merged.observation.generation = limitGeneration(
      merged,
      merged.observation.lastSuccessfulAt,
    );
  }
  return merged;
}

export function buildCompletePlatformBudgets(
  observedBudgets: readonly RawBudget[],
  observedAt = Date.now(),
): PlatformBudgets {
  const budgets = cloneLimitMaps();
  for (const budget of observedBudgets) {
    if (!budget.workspaceId || budget.amountUsd == null) continue;
    if (budget.type === "workspace_group_limit" && budget.groupId) {
      const limits = budgets.groupLimits.get(budget.workspaceId) ?? new Map();
      limits.set(budget.groupId, budget.amountUsd);
      budgets.groupLimits.set(budget.workspaceId, limits);
    } else if (budget.type === "workspace_user_limit" && budget.userId) {
      const limits = budgets.userLimits.get(budget.workspaceId) ?? new Map();
      limits.set(budget.userId, budget.amountUsd);
      budgets.userLimits.set(budget.workspaceId, limits);
    } else if (budget.type === "workspace_default_user_limit") {
      budgets.workspaceDefaults.set(budget.workspaceId, budget.amountUsd);
    }
  }
  budgets.observation = {
    status: "complete",
    observedAt,
    lastSuccessfulAt: observedAt,
    lastAttemptAt: observedAt,
    refreshStartedAt: null,
    generation: limitGeneration(budgets, observedAt),
    error: null,
  };
  return budgets;
}

export function buildFailedPlatformBudgets(
  previous: PlatformBudgets | null | undefined,
  error: unknown,
  attemptedAt = Date.now(),
): PlatformBudgets {
  const budgets = cloneLimitMaps(previous);
  const message = error instanceof Error ? error.message : String(error);
  budgets.observation = {
    status: "failed",
    observedAt: attemptedAt,
    lastSuccessfulAt: budgets.observation.lastSuccessfulAt,
    lastAttemptAt: attemptedAt,
    refreshStartedAt: null,
    generation: budgets.observation.generation,
    error: message.slice(0, 1000),
  };
  return budgets;
}

async function persistDirectoryUnlocked(directory: DirectoryCache): Promise<void> {
  await db.insert(apiDirectoryCacheTable).values({
    id: "singleton",
    directoryJson: serializeDirectory(directory),
    fetchedAt: new Date(directory.fetchedAt),
  }).onConflictDoUpdate({
    target: apiDirectoryCacheTable.id,
    set: {
      directoryJson: serializeDirectory(directory),
      fetchedAt: new Date(directory.fetchedAt),
    },
  });
}

function withLimitCommit<T>(work: () => Promise<T>): Promise<T> {
  const result = limitCommitQueue.then(work, work);
  limitCommitQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function persistDirectory(directory: DirectoryCache): Promise<void> {
  await withLimitCommit(() => persistDirectoryUnlocked(directory));
}

async function commitRefreshedDirectory(
  directory: DirectoryCache,
): Promise<void> {
  await withLimitCommit(async () => {
    // Overlay every verified write acknowledged while this upstream snapshot
    // was in flight. The completed refresh remains terminal and authoritative
    // for every other value, including an authoritative empty result.
    directory.budgets = mergeCompletedBudgetsWithAcknowledgedWrites(
      directory.budgets,
      activeLimitRefresh?.acknowledgedWrites ?? [],
    );
    await persistDirectoryUnlocked(directory);
    directoryCache = directory;
    activeLimitRefresh = null;
  });
}

export function serializeDirectory(directory: DirectoryCache): SerializedDirectory {
  return {
    fetchedAt: directory.fetchedAt,
    workspaces: Object.fromEntries(directory.workspaces),
    groups: directory.groups,
    allGroups: directory.allGroups,
    groupMembers: Object.fromEntries(directory.groupMembers),
    members: Object.fromEntries([...directory.members].map(([id, member]) => [
      id,
      { ...member, workspaces: Object.fromEntries(member.workspaces) },
    ])),
    budgets: {
      groupLimits: Object.fromEntries([...directory.budgets.groupLimits].map(([id, limits]) => [
        id,
        Object.fromEntries(limits),
      ])),
      userLimits: Object.fromEntries([...directory.budgets.userLimits].map(([id, limits]) => [
        id,
        Object.fromEntries(limits),
      ])),
      workspaceDefaults: Object.fromEntries(directory.budgets.workspaceDefaults),
      observation: directory.budgets.observation,
    },
    familyMappings: [...directory.account.familiesById.values()].map((family) => ({
      workspaceId: family.workspaceId,
      familyKey: family.key,
      familyName: family.name,
      teamName: family.teamName,
      isLegacy: family.isLegacy,
    })),
  };
}

export function deserializeDirectory(serialized: SerializedDirectory): DirectoryCache {
  const workspaces = new Map(Object.entries(serialized.workspaces));
  const allGroups = serialized.allGroups ?? serialized.groups;
  const groupMembers = new Map(Object.entries(serialized.groupMembers));
  const members = new Map(Object.entries(serialized.members).map(([id, member]) => [
    id,
    {
      ...member,
      isInternalReplitUser: isInternalReplitEmail(member.email),
      isAccountAdmin: member.isAccountAdmin ?? false,
      workspaces: new Map(Object.entries(member.workspaces)),
    },
  ]));
  const budgets: PlatformBudgets = {
    groupLimits: new Map(Object.entries(serialized.budgets.groupLimits)
      .map(([id, limits]) => [id, new Map(Object.entries(limits))])),
    userLimits: new Map(Object.entries(serialized.budgets.userLimits)
      .map(([id, limits]) => [id, new Map(Object.entries(limits))])),
    workspaceDefaults: new Map(Object.entries(serialized.budgets.workspaceDefaults)),
    observation: normalizeLimitObservation(serialized.budgets.observation),
  };
  const groups = allGroups.filter(isCustomGroup);
  return {
    fetchedAt: serialized.fetchedAt,
    workspaces,
    groups,
    allGroups,
    groupMembers,
    members,
    internalUserIds: new Set(
      [...members.values()]
        .filter((member) => member.isInternalReplitUser)
        .map((member) => member.userId),
    ),
    budgets,
    account: buildCanonicalAccountDirectory({
      workspaces,
      groups,
      groupMembers,
      members,
      mappings: serialized.familyMappings,
    }),
  };
}

async function refreshDirectory(): Promise<DirectoryCache> {
  if (directoryPromise) return directoryPromise;
  directoryPromise = (async () => {
    const refreshStartedAt = Date.now();
    activeLimitRefresh = { acknowledgedWrites: [] };
    if (directoryCache) {
      await withLimitCommit(async () => {
        if (!directoryCache) return;
        directoryCache.budgets.observation = {
          ...directoryCache.budgets.observation,
          status: "refreshing",
          observedAt: refreshStartedAt,
          lastAttemptAt: refreshStartedAt,
          refreshStartedAt,
          error: null,
        };
        await persistDirectoryUnlocked(directoryCache);
      });
    }
    try {
      const workspaces = await paginate<EnterpriseWorkspace>("/workspaces", {});
      const workspaceMap = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
      const allGroups = (await Promise.all(workspaces.map(async (workspace) =>
        (await paginate<EnterpriseGroup>("/groups", { workspaceId: workspace.id }))
          .map((group) => ({ ...group, workspaceId: group.workspaceId || workspace.id }))
      ))).flat();
      const groups = allGroups.filter(isCustomGroup);
      const memberships = await Promise.all(groups.map(async (group) => [
        group.id,
        (await paginate<{ userId: string }>(
          `/groups/${encodeURIComponent(group.id)}/users`,
          {},
        )).map((entry) => entry.userId),
      ] as const));
      const groupMembers = new Map(memberships);
      const members = new Map((await paginate<RawMember>("/members", {})).map((raw) => [
        raw.user.id,
        {
          userId: raw.user.id,
          username: raw.user.username,
          email: raw.user.email,
          isInternalReplitUser: isInternalReplitEmail(raw.user.email),
          name: [raw.user.firstName, raw.user.lastName].filter(Boolean).join(" ") || null,
          isAccountAdmin: parseIsAccountAdmin(raw),
          workspaces: new Map(raw.workspaces.map((workspace) => [
            workspace.id,
            { role: workspace.role, isDisabled: workspace.isDisabled },
          ])),
        },
      ]));
      let budgets: PlatformBudgets;
      try {
        const observedBudgets = await paginate<RawBudget>("/budgets", {});
        // A successful empty response is authoritative, so prior maps are replaced.
        budgets = buildCompletePlatformBudgets(observedBudgets);
      } catch (error) {
        if (limitValidationContext.getStore()) throw error;
        budgets = buildFailedPlatformBudgets(directoryCache?.budgets, error);
        logger.warn({ err: error }, "Failed to observe Enterprise budget limits");
      }
      const discovered = new Map<string, DiscoveredFamilyMapping>();
      for (const group of groups) {
        const parsed = parseDirectoryGroupName(group.name);
        const identity = `${group.workspaceId}\0${parsed.familyKey}`;
        discovered.set(identity, {
          workspaceId: group.workspaceId,
          familyKey: parsed.familyKey,
          familyName: parsed.familyName,
          isLegacy: group.workspaceId === LEGACY_WORKSPACE_ID,
          groupIds: [...(discovered.get(identity)?.groupIds ?? []), group.id],
        });
      }
      const mappings = await applyFamilyMappingBackfill([...discovered.values()]);
      const account = buildCanonicalAccountDirectory({
        workspaces: workspaceMap,
        groups,
        groupMembers,
        members,
        mappings,
      });
      const directory: DirectoryCache = {
        fetchedAt: Date.now(),
        workspaces: workspaceMap,
        groups,
        allGroups,
        groupMembers,
        members,
        internalUserIds: new Set(
          [...members.values()]
            .filter((member) => member.isInternalReplitUser)
            .map((member) => member.userId),
        ),
        budgets,
        account,
      };
      await commitRefreshedDirectory(directory);
      await persistCanonicalFamilyFinancialRows(account);
      return directory;
    } catch (error) {
      if (directoryCache) {
        const message = error instanceof Error ? error.message : String(error);
        directoryCache.budgets.observation = {
          ...directoryCache.budgets.observation,
          status: "failed",
          observedAt: Date.now(),
          lastAttemptAt: Date.now(),
          refreshStartedAt: null,
          error: message.slice(0, 1000),
        };
        await persistDirectory(directoryCache).catch((persistError) =>
          logger.warn({ err: persistError }, "Failed to persist failed limit observation"));
      }
      throw error;
    } finally {
      activeLimitRefresh = null;
      directoryPromise = null;
    }
  })();
  return directoryPromise;
}

export function getCachedDirectory(): Promise<DirectoryCache> {
  return directoryCache
    ? Promise.resolve(directoryCache)
    : Promise.reject(new Error("Enterprise directory has not been hydrated yet"));
}

export function getDirectoryFreshness(now = Date.now()): DirectoryFreshness {
  return {
    dataAsOf: directoryCache ? new Date(directoryCache.fetchedAt).toISOString() : null,
    isStale: !!directoryCache && now - directoryCache.fetchedAt >= DIRECTORY_TTL_MS,
    isRefreshing: directoryPromise !== null,
  };
}

export function getDirectoryHydrationState(): DirectoryHydrationState {
  return { ...directoryHydrationState };
}

export async function getDirectory(force = false): Promise<DirectoryCache> {
  if (force) return refreshDirectory();
  if (directoryCache) return directoryCache;
  throw new EnterpriseApiError(503, "Directory has not been hydrated yet");
}

export function refreshDirectoryForIngest(): Promise<DirectoryCache> {
  return refreshDirectory();
}

export function getFreshDirectoryForLimitValidation(): Promise<DirectoryCache> {
  return limitValidationContext.run(true, refreshDirectory);
}

export async function reconcilePersistedLimitWrite(
  write: PersistedLimitWrite,
): Promise<void> {
  await withLimitCommit(async () => {
    if (!directoryCache) {
      throw new Error("Cannot persist acknowledged limit write before directory hydration");
    }
    const targetDirectory = directoryCache;
    const previousBudgets = targetDirectory.budgets;
    const budgets = cloneLimitMaps(previousBudgets);
    applyLimitWrite(budgets, write);
    if (hasSuccessfulLimitObservation(budgets)) {
      budgets.observation.generation = limitGeneration(budgets, Date.now());
    }
    targetDirectory.budgets = budgets;
    try {
      await persistDirectoryUnlocked(targetDirectory);
      activeLimitRefresh?.acknowledgedWrites.push(write);
    } catch (error) {
      if (directoryCache === targetDirectory) {
        targetDirectory.budgets = previousBudgets;
      }
      throw error;
    }
  });
}

export function assertCompleteRosterDirectory(directory: DirectoryCache): DirectoryCache {
  const missing = directory.groups.filter((group) => !directory.groupMembers.has(group.id));
  if (missing.length > 0) {
    throw new Error(`Roster directory refresh incomplete for ${missing.length} group(s)`);
  }
  return directory;
}

export async function getCompleteDirectoryForRosterSnapshot(): Promise<DirectoryCache> {
  return assertCompleteRosterDirectory(await getFreshDirectoryForLimitValidation());
}

export function __setDirectoryCacheForTests(
  fixture: {
    workspaces?: Map<string, EnterpriseWorkspace>;
    groups: EnterpriseGroup[];
    groupMembers?: Map<string, string[]>;
    members: Map<string, EnterpriseMember>;
    fetchedAt?: number;
    mappings?: readonly FamilyMapping[];
    budgets?: PlatformBudgets;
  } | null,
): void {
  if (!fixture) {
    directoryCache = null;
    directoryHydrationState = { status: "unavailable", reason: "not_found" };
    return;
  }
  const workspaces = fixture.workspaces ?? new Map();
  const groupMembers = fixture.groupMembers ?? new Map();
  const members = new Map(
    [...fixture.members].map(([userId, member]) => [
      userId,
      {
        ...member,
        isInternalReplitUser: isInternalReplitEmail(member.email),
      },
    ]),
  );
  directoryCache = {
    fetchedAt: fixture.fetchedAt ?? Date.now(),
    workspaces,
    groups: fixture.groups,
    allGroups: fixture.groups,
    groupMembers,
    members,
    internalUserIds: new Set(
      [...members.values()]
        .filter((member) => member.isInternalReplitUser)
        .map((member) => member.userId),
    ),
    budgets: fixture.budgets ?? {
      groupLimits: new Map(),
      userLimits: new Map(),
      workspaceDefaults: new Map(),
      observation: unavailableLimitObservation(),
    },
    account: buildCanonicalAccountDirectory({
      workspaces,
      groups: fixture.groups,
      groupMembers,
      members,
      mappings: fixture.mappings,
    }),
  };
  directoryHydrationState = { status: "ready", reason: "hydrated" };
}

export interface ProjectInfo {
  title: string | null;
  creatorId: string | null;
}
interface RawProject {
  id: string;
  title?: string | null;
  creatorId?: string | null;
}
const projectInfoCache = new Map<string, Map<string, ProjectInfo>>();
const projectInfoFetchedAt = new Map<string, number>();

export function getProjectTitles(workspaceId: string): Map<string, string> {
  return new Map(
    [...(projectInfoCache.get(workspaceId) ?? [])]
      .flatMap(([id, info]) => info.title ? [[id, info.title] as const] : []),
  );
}

export function getProjectInfo(workspaceId: string, projectId: string): ProjectInfo | undefined {
  const projects = projectInfoCache.get(workspaceId);
  return projects ? projects.get(projectId) ?? { title: null, creatorId: null } : undefined;
}

export function hasProjectInfo(workspaceId: string): boolean {
  return projectInfoCache.has(workspaceId);
}

export async function refreshProjectMetadata(
  workspaceId: string,
  force = false,
): Promise<boolean> {
  const fetchedAt = projectInfoFetchedAt.get(workspaceId);
  if (!force && fetchedAt !== undefined && Date.now() - fetchedAt < PROJECT_INFO_TTL_MS) {
    return false;
  }
  const startedAt = new Date();
  await db.insert(apiProjectMetadataStateTable).values({
    workspaceId,
    status: "syncing",
    errorMessage: null,
    startedAt,
    completedAt: startedAt,
  }).onConflictDoUpdate({
    target: apiProjectMetadataStateTable.workspaceId,
    set: { status: "syncing", errorMessage: null, startedAt },
  });
  try {
    const projects = await paginate<RawProject>("/projects", { workspaceId });
    const completedAt = new Date();
    await db.transaction(async (tx) => {
      await tx.delete(apiProjectMetadataTable)
        .where(eq(apiProjectMetadataTable.workspaceId, workspaceId));
      if (projects.length > 0) {
        await tx.insert(apiProjectMetadataTable).values(projects.map((project) => ({
          workspaceId,
          projectId: project.id,
          title: project.title ?? null,
          creatorId: project.creatorId ?? null,
          fetchedAt: completedAt,
        })));
      }
      await tx.insert(apiProjectMetadataStateTable).values({
        workspaceId,
        status: "success",
        errorMessage: null,
        startedAt,
        completedAt,
      }).onConflictDoUpdate({
        target: apiProjectMetadataStateTable.workspaceId,
        set: { status: "success", errorMessage: null, startedAt, completedAt },
      });
    });
    projectInfoCache.set(workspaceId, new Map(projects.map((project) => [
      project.id,
      { title: project.title ?? null, creatorId: project.creatorId ?? null },
    ])));
    projectInfoFetchedAt.set(workspaceId, completedAt.getTime());
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.insert(apiProjectMetadataStateTable).values({
      workspaceId,
      status: "failed",
      errorMessage: message.slice(0, 1000),
      startedAt,
      completedAt: new Date(),
    }).onConflictDoUpdate({
      target: apiProjectMetadataStateTable.workspaceId,
      set: { status: "failed", errorMessage: message.slice(0, 1000), completedAt: new Date() },
    });
    throw error;
  }
}

export interface GroupSpend {
  spendUsd: number;
  fetchedAt: number;
  periodStart: string;
  periodEnd: string;
}

export async function initCache(
  _options: { revalidateOnStartup?: boolean } = {},
): Promise<void> {
  directoryHydrationState = { status: "pending", reason: "not_started" };
  try {
    const directory = await db.query.apiDirectoryCacheTable.findFirst({
      where: eq(apiDirectoryCacheTable.id, "singleton"),
    });
    if (directory) {
      directoryCache = deserializeDirectory(directory.directoryJson as SerializedDirectory);
      if (
        (directory.directoryJson as SerializedDirectory).budgets.observation?.status ===
          "refreshing"
      ) {
        await persistDirectory(directoryCache);
      }
      directoryHydrationState = { status: "ready", reason: "hydrated" };
    } else {
      directoryCache = null;
      directoryHydrationState = { status: "unavailable", reason: "not_found" };
    }
  } catch (error) {
    directoryCache = null;
    directoryHydrationState = { status: "unavailable", reason: "lookup_failed" };
    logger.warn({ err: error }, "Failed to hydrate Enterprise directory");
  }

  try {
    const [billing, projects, projectStates] = await Promise.all([
      db.query.apiBillingPeriodCacheTable.findFirst({
        where: eq(apiBillingPeriodCacheTable.id, "current"),
      }),
      db.select().from(apiProjectMetadataTable),
      db.select().from(apiProjectMetadataStateTable),
    ]);
    if (billing) {
      billingPeriodCache = {
        start: billing.periodStart.toISOString(),
        end: billing.periodEnd.toISOString(),
        fetchedAt: billing.fetchedAt.getTime(),
      };
    }
    for (const row of projects) {
      const workspace = projectInfoCache.get(row.workspaceId) ?? new Map();
      workspace.set(row.projectId, { title: row.title, creatorId: row.creatorId });
      projectInfoCache.set(row.workspaceId, workspace);
    }
    for (const state of projectStates) {
      if (state.status === "success") {
        projectInfoFetchedAt.set(state.workspaceId, state.completedAt.getTime());
        if (!projectInfoCache.has(state.workspaceId)) projectInfoCache.set(state.workspaceId, new Map());
      }
    }
  } catch (error) {
    logger.warn({ err: error }, "Failed to hydrate non-directory Enterprise metadata");
  }
}
