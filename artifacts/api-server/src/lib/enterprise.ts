import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { db } from "@workspace/db";
import {
  apiBillingPeriodCacheTable,
  apiBillingPeriodObservationTable,
  apiDirectoryCacheTable,
  apiProjectMetadataStateTable,
  apiProjectMetadataTable,
  familyTeamMappingsTable,
} from "@workspace/db/schema";
import {
  applyFamilyMappingBackfill,
  type DiscoveredFamilyMapping,
} from "@workspace/db/seed-teams";
import { eq, inArray } from "drizzle-orm";
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
const PROJECT_METADATA_ATOMIC_MAX_REQUESTS = 1_000;
const PROJECT_METADATA_SLICE_MAX_MS = 60_000;
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
const projectMetadataSliceContext = new AsyncLocalStorage<AbortSignal>();
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

  async admit(isUsage: boolean, signal?: AbortSignal): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
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
      await sleep(Math.max(1, wakeAt - now), undefined, { signal });
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
  onRequest?: () => void,
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
  const sliceSignal = projectMetadataSliceContext.getStore();
  await enterpriseBudget.admit(path === "/usage", sliceSignal);
  onRequest?.();
  const requestTimeout = AbortSignal.timeout(ENTERPRISE_REQUEST_TIMEOUT_MS);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${key}` },
    signal: sliceSignal
      ? AbortSignal.any([sliceSignal, requestTimeout])
      : requestTimeout,
  });
  enterpriseBudget.observe(response.headers, response.status);
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("Retry-After") ?? "5");
    throw Object.assign(new EnterpriseApiError(429, "rate limited"), {
      retryAfterMs: Math.max(1000, retryAfter * 1000),
    });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new EnterpriseApiError(
      response.status,
      `Enterprise API ${path} failed (${response.status})`,
    );
  }
  try {
    return { body: await response.json(), headers: response.headers };
  } catch {
    throw new EnterpriseApiError(
      response.status,
      `Enterprise API ${path} returned invalid JSON`,
    );
  }
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

export function validateProviderPage<T>(
  path: string,
  body: unknown,
  validateRow?: (row: T, index: number) => void,
): { data: T[]; pagination: Pagination } {
  if (!body || typeof body !== "object") {
    throw new Error(`Enterprise API ${path} response was not an object`);
  }
  const payload = body as { data?: T[]; pagination?: Pagination };
  if (!Array.isArray(payload.data)) {
    throw new Error(`Enterprise API ${path} response omitted data`);
  }
  if (
    !payload.pagination ||
    typeof payload.pagination !== "object" ||
    typeof payload.pagination.hasMore !== "boolean"
  ) {
    throw new Error(`Enterprise API ${path} response omitted pagination completeness`);
  }
  payload.data.forEach((row, index) => validateRow?.(row, index));
  return { data: payload.data, pagination: payload.pagination };
}

async function paginate<T>(
  path: string,
  params: Record<string, string | undefined>,
  maxPages = 200,
  onRequest?: () => void,
  validateRow?: (row: T, index: number) => void,
): Promise<T[]> {
  const result: T[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (let page = 0; page < maxPages; page++) {
    let response: { body: unknown; headers: Headers } | undefined;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        response = await rawFetch(path, { ...params, limit: "100", cursor }, onRequest);
        break;
      } catch (error) {
        if (!(error instanceof EnterpriseApiError) || error.status !== 429 || attempt === 5) {
          throw error;
        }
      }
    }
    const payload = validateProviderPage<T>(path, response!.body, validateRow);
    lastApiOk = true;
    lastApiError = null;
    result.push(...payload.data);
    if (!payload.pagination?.hasMore) return result;
    cursor = payload.pagination.nextCursor ?? payload.pagination.cursor ?? undefined;
    if (!cursor) throw new Error(`Enterprise API ${path} pagination omitted cursor`);
    if (seenCursors.has(cursor)) {
      throw new Error(`Enterprise API ${path} pagination repeated cursor`);
    }
    seenCursors.add(cursor);
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
  return Number.isFinite(start) && Number.isFinite(end) && start <= now && end > now
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
  const observedAt = Date.now();
  if (start.getTime() > observedAt || end.getTime() <= observedAt) {
    throw new Error("Enterprise API current billing interval does not contain the observation time");
  }
  const period = { start: start.toISOString(), end: end.toISOString(), fetchedAt: observedAt };
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
let directoryPromiseDataOnly: boolean | null = null;
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

async function refreshDirectory(
  options: { dataOnly?: boolean } = {},
): Promise<DirectoryCache> {
  const dataOnly = options.dataOnly ?? false;
  if (directoryPromise) {
    if (directoryPromiseDataOnly === dataOnly) return directoryPromise;
    const active = directoryPromise;
    return active.then(
      () => refreshDirectory({ dataOnly }),
      () => refreshDirectory({ dataOnly }),
    );
  }
  directoryPromiseDataOnly = dataOnly;
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
      const workspaces = await paginate<EnterpriseWorkspace>(
        "/workspaces", {}, 200, undefined, validateWorkspace,
      );
      const workspaceMap = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
      const allGroups = (await Promise.all(workspaces.map(async (workspace) =>
        (await paginate<EnterpriseGroup>(
          "/groups", { workspaceId: workspace.id }, 200, undefined, validateGroup,
        ))
          .map((group) => ({ ...group, workspaceId: group.workspaceId || workspace.id }))
      ))).flat();
      const groups = allGroups.filter(isCustomGroup);
      const memberships = await Promise.all(groups.map(async (group) => [
        group.id,
        (await paginate<{ userId: string }>(
          `/groups/${encodeURIComponent(group.id)}/users`,
          {},
          200,
          undefined,
          (entry) => requiredString(
            entry?.userId,
            `/groups/${encodeURIComponent(group.id)}/users`,
            "userId",
          ),
        )).map((entry) => entry.userId),
      ] as const));
      const groupMembers = new Map(memberships);
      const members = new Map((await paginate<RawMember>(
        "/members", {}, 200, undefined, validateMember,
      )).map((raw) => [
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
        const observedBudgets = await paginate<RawBudget>(
          "/budgets", {}, 200, undefined, validateBudget,
        );
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
      const mappings = dataOnly
        ? await db.select().from(familyTeamMappingsTable)
        : await applyFamilyMappingBackfill([...discovered.values()]);
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
      if (!dataOnly) await persistCanonicalFamilyFinancialRows(account);
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
      directoryPromiseDataOnly = null;
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

export function refreshDirectoryForIngest(dataOnly = false): Promise<DirectoryCache> {
  return refreshDirectory({ dataOnly });
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
  hasDeployment: boolean | null;
}
interface RawProject {
  id: string;
  title?: string | null;
  creatorId?: string | null;
  workspace?: { id?: string | null } | null;
}
class ProjectMetadataDeferredError extends Error {}
const projectInfoCache = new Map<string, Map<string, ProjectInfo>>();
const projectInfoFetchedAt = new Map<string, number>();

function requiredString(value: unknown, path: string, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Enterprise API ${path} row omitted required ${field}`);
  }
}

function validateWorkspace(row: EnterpriseWorkspace): void {
  requiredString(row?.id, "/workspaces", "id");
  requiredString(row?.name, "/workspaces", "name");
  requiredString(row?.slug, "/workspaces", "slug");
  if (!Number.isInteger(row?.memberCount) || row.memberCount < 0) {
    throw new Error("Enterprise API /workspaces row has invalid memberCount");
  }
}

function validateGroup(row: EnterpriseGroup): void {
  requiredString(row?.id, "/groups", "id");
  requiredString(row?.name, "/groups", "name");
  requiredString(row?.type, "/groups", "type");
}

function validateMember(row: RawMember): void {
  requiredString(row?.user?.id, "/members", "user.id");
  requiredString(row?.user?.username, "/members", "user.username");
  requiredString(row?.user?.email, "/members", "user.email");
  if (!Array.isArray(row?.workspaces)) {
    throw new Error("Enterprise API /members row omitted required workspaces");
  }
  for (const workspace of row.workspaces) {
    requiredString(workspace?.id, "/members", "workspaces.id");
    requiredString(workspace?.role, "/members", "workspaces.role");
    if (typeof workspace?.isDisabled !== "boolean") {
      throw new Error("Enterprise API /members row has invalid workspaces.isDisabled");
    }
  }
}

function validateBudget(row: RawBudget): void {
  requiredString(row?.type, "/budgets", "type");
  const scopedTypes = new Set([
    "workspace_group_limit",
    "workspace_user_limit",
    "workspace_default_user_limit",
  ]);
  if (!scopedTypes.has(row.type)) return;
  requiredString(row.workspaceId, "/budgets", "workspaceId");
  if (!Number.isFinite(row.amountUsd) || row.amountUsd! < 0) {
    throw new Error("Enterprise API /budgets row has invalid amountUsd");
  }
  if (row.type === "workspace_group_limit") {
    requiredString(row.groupId, "/budgets", "groupId");
  }
  if (row.type === "workspace_user_limit") {
    requiredString(row.userId, "/budgets", "userId");
  }
}

function validateProject(row: RawProject): void {
  requiredString(row?.id, "/projects", "id");
  if (row.title !== undefined && row.title !== null && typeof row.title !== "string") {
    throw new Error("Enterprise API /projects row has invalid title");
  }
  if (row.creatorId !== undefined && row.creatorId !== null &&
      (typeof row.creatorId !== "string" || row.creatorId.trim() === "")) {
    throw new Error("Enterprise API /projects row has invalid creatorId");
  }
}

function validateAccountProject(row: RawProject): void {
  validateProject(row);
  requiredString(row.workspace?.id, "/projects", "workspace.id");
}

function dedupeAccountProjects(
  rows: readonly RawProject[],
  path: string,
): RawProject[] {
  const byProjectId = new Map<string, RawProject>();
  for (const row of rows) {
    const existing = byProjectId.get(row.id);
    if (!existing) {
      byProjectId.set(row.id, row);
      continue;
    }
    const identical = existing.workspace!.id === row.workspace!.id &&
      (existing.creatorId ?? null) === (row.creatorId ?? null) &&
      (existing.title ?? null) === (row.title ?? null);
    if (!identical) {
      throw new Error(
        `Enterprise API ${path} repeated a project with conflicting workspace, owner, or title`,
      );
    }
  }
  return [...byProjectId.values()];
}

export function getProjectTitles(workspaceId: string): Map<string, string> {
  return new Map(
    [...(projectInfoCache.get(workspaceId) ?? [])]
      .flatMap(([id, info]) => info.title ? [[id, info.title] as const] : []),
  );
}

export function getProjectInfo(workspaceId: string, projectId: string): ProjectInfo | undefined {
  return projectInfoCache.get(workspaceId)?.get(projectId);
}

export function hasProjectInfo(workspaceId: string, now = Date.now()): boolean {
  const fetchedAt = projectInfoFetchedAt.get(workspaceId);
  return projectInfoCache.has(workspaceId) &&
    fetchedAt !== undefined &&
    now - fetchedAt >= 0 &&
    now - fetchedAt < PROJECT_INFO_TTL_MS;
}

export async function refreshProjectMetadata(
  workspaceId: string,
  force = false,
  onRequest?: () => void,
): Promise<boolean> {
  const fetchedAt = projectInfoFetchedAt.get(workspaceId);
  if (!force && fetchedAt !== undefined && Date.now() - fetchedAt < PROJECT_INFO_TTL_MS) {
    return false;
  }
  const startedAt = new Date();
  const sliceSignal = projectMetadataSliceContext.getStore();
  let transactionStarted = false;
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
    const projects = await paginate<RawProject>(
      "/projects",
      { workspaceId },
      PROJECT_METADATA_ATOMIC_MAX_REQUESTS / 10,
      onRequest,
      validateProject,
    );
    // The documented hasDeployment filter is the authoritative current
    // deployment observation. Do not infer this state from hosting spend.
    const deployedProjects = await paginate<RawProject>(
      "/projects",
      { workspaceId, hasDeployment: "true" },
      PROJECT_METADATA_ATOMIC_MAX_REQUESTS / 10,
      onRequest,
      validateProject,
    );
    const projectIds = new Set(projects.map((project) => project.id));
    const deployedProjectIds = new Set(
      deployedProjects.map((project) => project.id),
    );
    for (const projectId of deployedProjectIds) {
      if (!projectIds.has(projectId)) {
        throw new Error(
          "Enterprise API /projects?hasDeployment=true returned a project absent from the workspace project listing",
        );
      }
    }
    sliceSignal?.throwIfAborted();
    const completedAt = new Date();
    transactionStarted = true;
    await db.transaction(async (tx) => {
      await tx.delete(apiProjectMetadataTable)
        .where(eq(apiProjectMetadataTable.workspaceId, workspaceId));
      if (projects.length > 0) {
        await tx.insert(apiProjectMetadataTable).values(projects.map((project) => ({
          workspaceId,
          projectId: project.id,
          title: project.title ?? null,
          creatorId: project.creatorId ?? null,
           hasDeployment: deployedProjectIds.has(project.id),
          fetchedAt: completedAt,
        })));
      }
      await tx.insert(apiProjectMetadataStateTable).values({
        workspaceId,
        status: "success",
         deploymentStatusObserved: true,
        errorMessage: null,
        startedAt,
        completedAt,
        lastSuccessfulAt: completedAt,
      }).onConflictDoUpdate({
        target: apiProjectMetadataStateTable.workspaceId,
        set: {
          status: "success",
           deploymentStatusObserved: true,
          errorMessage: null,
          startedAt,
          completedAt,
          lastSuccessfulAt: completedAt,
        },
      });
    });
    projectInfoCache.set(workspaceId, new Map(projects.map((project) => [
      project.id,
      {
        title: project.title ?? null,
        creatorId: project.creatorId ?? null,
        hasDeployment: deployedProjectIds.has(project.id),
      },
    ])));
    projectInfoFetchedAt.set(workspaceId, completedAt.getTime());
    return true;
  } catch (error) {
    const deferred = !transactionStarted && sliceSignal?.aborted;
    const message = deferred
      ? "Project metadata refresh deferred by slice deadline"
      : error instanceof Error ? error.message : String(error);
    await db.insert(apiProjectMetadataStateTable).values({
      workspaceId,
      status: deferred ? "unavailable" : "failed",
      errorMessage: message.slice(0, 1000),
      startedAt,
      completedAt: new Date(),
    }).onConflictDoUpdate({
      target: apiProjectMetadataStateTable.workspaceId,
      set: {
        status: deferred ? "unavailable" : "failed",
        errorMessage: message.slice(0, 1000),
        completedAt: new Date(),
      },
    });
    if (deferred) throw new ProjectMetadataDeferredError(message);
    throw error;
  }
}

/**
 * Refreshes the account project catalog and live-deployment projection with
 * two complete paginated listings. Publishing is atomic across workspaces, so
 * neither a first page nor a failed deployment listing can replace last-good
 * catalog/deployment facts.
 */
async function refreshAccountProjectMetadata(
  expectedWorkspaceIds: readonly string[],
  onRequest?: () => void,
): Promise<number> {
  const expectedIds = [...new Set(expectedWorkspaceIds.filter(Boolean))];
  const startedAt = new Date();
  if (expectedIds.length === 0) return 0;
  await db.insert(apiProjectMetadataStateTable).values(expectedIds.map(
    (workspaceId) => ({
      workspaceId,
      status: "syncing",
      errorMessage: null,
      startedAt,
      completedAt: startedAt,
    }),
  )).onConflictDoUpdate({
    target: apiProjectMetadataStateTable.workspaceId,
    set: { status: "syncing", errorMessage: null, startedAt },
  });
  try {
    const projects = dedupeAccountProjects(await paginate<RawProject>(
      "/projects",
      {},
      PROJECT_METADATA_ATOMIC_MAX_REQUESTS / 10,
      onRequest,
      validateAccountProject,
    ), "/projects");
    const deployedProjects = dedupeAccountProjects(await paginate<RawProject>(
      "/projects",
      { hasDeployment: "true" },
      PROJECT_METADATA_ATOMIC_MAX_REQUESTS / 10,
      onRequest,
      validateAccountProject,
    ), "/projects?hasDeployment=true");
    const projectsById = new Map(projects.map((project) =>
      [project.id, project] as const));
    const deployedProjectKeys = new Set(deployedProjects.map((project) =>
      `${project.workspace!.id!}\0${project.id}`));
    for (const deployedProject of deployedProjects) {
      const catalogProject = projectsById.get(deployedProject.id);
      if (
        !catalogProject ||
        catalogProject.workspace!.id !== deployedProject.workspace!.id ||
        (catalogProject.creatorId ?? null) !==
          (deployedProject.creatorId ?? null)
      ) {
        throw new Error(
          "Enterprise API /projects?hasDeployment=true returned a project inconsistent with the account project listing",
        );
      }
    }
    projectMetadataSliceContext.getStore()?.throwIfAborted();
    const completedAt = new Date();
    const observedWorkspaceIds = new Set([
      ...expectedIds,
      ...projects.map((project) => project.workspace!.id!),
    ]);
    await db.transaction(async (tx) => {
      await tx.delete(apiProjectMetadataTable)
        .where(inArray(apiProjectMetadataTable.workspaceId,
          [...observedWorkspaceIds]));
      if (projects.length > 0) {
        await tx.insert(apiProjectMetadataTable).values(projects.map((project) => ({
          workspaceId: project.workspace!.id!,
          projectId: project.id,
          title: project.title ?? null,
          creatorId: project.creatorId ?? null,
          hasDeployment: deployedProjectKeys.has(
            `${project.workspace!.id!}\0${project.id}`),
          fetchedAt: completedAt,
        })));
      }
      await tx.insert(apiProjectMetadataStateTable).values(
        [...observedWorkspaceIds].map((workspaceId) => ({
          workspaceId,
          status: "success",
          deploymentStatusObserved: true,
          errorMessage: null,
          startedAt,
          completedAt,
          lastSuccessfulAt: completedAt,
        })),
      ).onConflictDoUpdate({
        target: apiProjectMetadataStateTable.workspaceId,
        set: {
          status: "success",
          deploymentStatusObserved: true,
          errorMessage: null,
          startedAt,
          completedAt,
          lastSuccessfulAt: completedAt,
        },
      });
    });
    for (const workspaceId of observedWorkspaceIds) {
      projectInfoCache.set(workspaceId, new Map());
      projectInfoFetchedAt.set(workspaceId, completedAt.getTime());
    }
    for (const project of projects) {
      const workspaceId = project.workspace!.id!;
      projectInfoCache.get(workspaceId)!.set(project.id, {
        title: project.title ?? null,
        creatorId: project.creatorId ?? null,
        hasDeployment: deployedProjectKeys.has(`${workspaceId}\0${project.id}`),
      });
    }
    return observedWorkspaceIds.size;
  } catch (error) {
    const completedAt = new Date();
    const deferred = projectMetadataSliceContext.getStore()?.aborted === true;
    const message = deferred
      ? "Project metadata refresh deferred by slice deadline"
      : error instanceof Error ? error.message : String(error);
    await db.insert(apiProjectMetadataStateTable).values(expectedIds.map(
      (workspaceId) => ({
        workspaceId,
        status: deferred ? "unavailable" : "failed",
        errorMessage: message.slice(0, 1000),
        startedAt,
        completedAt,
      }),
    )).onConflictDoUpdate({
      target: apiProjectMetadataStateTable.workspaceId,
      set: {
        status: deferred ? "unavailable" : "failed",
        errorMessage: message.slice(0, 1000),
        completedAt,
      },
    });
    if (deferred) throw new ProjectMetadataDeferredError(message);
    throw error;
  }
}

export interface ProjectMetadataSliceCounters {
  considered: number;
  attempted: number;
  succeeded: number;
  failed: number;
  deferred: number;
  requests: number;
  remaining: number;
}

export interface ProjectMetadataProgress {
  remaining: number;
  fresh: number;
  deferred: number;
  failed: number;
}

/**
 * Reads durable completion state for the expected workspace set. Only a
 * currently-successful observation inside the TTL is complete; a failed or
 * unavailable attempt remains incomplete even when it retained last-good data.
 */
export async function getProjectMetadataProgress(
  workspaceIds: readonly string[],
  now = Date.now(),
): Promise<ProjectMetadataProgress> {
  const ids = [...new Set(workspaceIds.filter(Boolean))];
  if (ids.length === 0) {
    return { remaining: 0, fresh: 0, deferred: 0, failed: 0 };
  }
  const states = await db.select().from(apiProjectMetadataStateTable)
    .where(inArray(apiProjectMetadataStateTable.workspaceId, ids));
  const byWorkspace = new Map(states.map((state) => [state.workspaceId, state]));
  let fresh = 0;
  let deferred = 0;
  let failed = 0;
  for (const workspaceId of ids) {
    const state = byWorkspace.get(workspaceId);
    const successfulAt = state?.lastSuccessfulAt?.getTime();
    const age = successfulAt === undefined ? undefined : now - successfulAt;
    if (
      state?.status === "success" &&
       state.deploymentStatusObserved &&
      age !== undefined &&
      age >= 0 &&
      age < PROJECT_INFO_TTL_MS
    ) {
      fresh++;
    } else if (state?.status === "unavailable") {
      deferred++;
    } else if (state?.status === "failed") {
      failed++;
    }
  }
  return { remaining: ids.length - fresh, fresh, deferred, failed };
}

/**
 * Refreshes the account catalog when any expected workspace is due. The two
 * account-wide paginated listings converge all workspaces in one bounded,
 * atomically published pass instead of racing a per-workspace TTL.
 */
export async function refreshProjectMetadataSlice(
  workspaceIds: readonly string[],
  options: { retryIncomplete?: boolean } = {},
): Promise<ProjectMetadataSliceCounters> {
  const ids = [...new Set(workspaceIds.filter(Boolean))];
  const counters: ProjectMetadataSliceCounters = {
    considered: ids.length,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    deferred: 0,
    requests: 0,
    remaining: ids.length,
  };
  const finish = async (): Promise<ProjectMetadataSliceCounters> => {
    counters.remaining = (await getProjectMetadataProgress(ids)).remaining;
    return counters;
  };
  if (!isConfigured() || ids.length === 0) return finish();

  const signal = AbortSignal.timeout(PROJECT_METADATA_SLICE_MAX_MS);
  return projectMetadataSliceContext.run(signal, async () => {
    const states = await db.select().from(apiProjectMetadataStateTable)
      .where(inArray(apiProjectMetadataStateTable.workspaceId, ids));
    const byWorkspace = new Map(states.map((state) => [state.workspaceId, state]));
    const now = Date.now();
    const candidates = ids
      .filter((workspaceId) => {
        const state = byWorkspace.get(workspaceId);
        if (!state) return true;
        const successfulAt = state.lastSuccessfulAt?.getTime();
        if (
          state.status === "success" &&
         state.deploymentStatusObserved &&
          successfulAt !== undefined &&
          now - successfulAt >= 0 &&
          now - successfulAt < PROJECT_INFO_TTL_MS
        ) return false;
        if (
          options.retryIncomplete &&
          (state.status === "failed" || state.status === "unavailable")
        ) return true;
        if (state.status === "success") return true;
        const attemptedAt = state.completedAt.getTime();
        return attemptedAt === undefined || now - attemptedAt >= PROJECT_INFO_TTL_MS;
      })
      .sort((a, b) => {
        const aAttempt = byWorkspace.get(a)?.completedAt.getTime() ?? 0;
        const bAttempt = byWorkspace.get(b)?.completedAt.getTime() ?? 0;
        return aAttempt - bAttempt || a.localeCompare(b);
      });

    if (candidates.length > 0 && !signal.aborted) {
      counters.attempted = ids.length;
      try {
        const observed = await refreshAccountProjectMetadata(
          ids,
          () => counters.requests++,
        );
        counters.succeeded = Math.min(ids.length, observed);
      } catch (error) {
        if (error instanceof ProjectMetadataDeferredError) {
          counters.deferred = ids.length;
        } else {
          counters.failed = ids.length;
        }
        const status = error instanceof EnterpriseApiError ? error.status : undefined;
        logger.warn(
          { event: "project_metadata_enrichment_failed", status },
          "Enterprise account project metadata enrichment failed",
        );
      }
    }
    return finish();
  });
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
    const [billing, projectMetadata] = await Promise.all([
      db.query.apiBillingPeriodCacheTable.findFirst({
        where: eq(apiBillingPeriodCacheTable.id, "current"),
      }),
      db.transaction(async (tx) => {
        const projects = await tx.select().from(apiProjectMetadataTable);
        const states = await tx.select().from(apiProjectMetadataStateTable);
        return { projects, states };
      }, { isolationLevel: "repeatable read", accessMode: "read only" }),
    ]);
    if (billing) {
      billingPeriodCache = {
        start: billing.periodStart.toISOString(),
        end: billing.periodEnd.toISOString(),
        fetchedAt: billing.fetchedAt.getTime(),
      };
    }
    projectInfoCache.clear();
    projectInfoFetchedAt.clear();
    const successfulStates = new Map(projectMetadata.states.flatMap((state) =>
      state.lastSuccessfulAt
        ? [[state.workspaceId, state.lastSuccessfulAt.getTime()] as const]
        : []));
    for (const row of projectMetadata.projects) {
      const successfulAt = successfulStates.get(row.workspaceId);
      if (successfulAt === undefined) continue;
      const workspace = projectInfoCache.get(row.workspaceId) ?? new Map();
      workspace.set(row.projectId, {
        title: row.title,
        creatorId: row.creatorId,
        hasDeployment: row.hasDeployment,
      });
      projectInfoCache.set(row.workspaceId, workspace);
    }
    for (const [workspaceId, successfulAt] of successfulStates) {
      projectInfoFetchedAt.set(workspaceId, successfulAt);
      if (!projectInfoCache.has(workspaceId)) projectInfoCache.set(workspaceId, new Map());
    }
  } catch (error) {
    logger.warn({ err: error }, "Failed to hydrate non-directory Enterprise metadata");
  }
}
