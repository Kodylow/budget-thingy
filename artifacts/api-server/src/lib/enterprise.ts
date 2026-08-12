import { logger } from "./logger";
import { db } from "@workspace/db";
import { apiDirectoryCacheTable, apiSpendCacheTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import {
  computeDedupedMemberCounts,
  computeDedupedUsageRollup,
  type DedupedGroupRollup,
  type DedupedUsageRollup,
} from "./usage-rollup";

const BASE_URL = "https://api.replit.com/v1";

export function isConfigured(): boolean {
  return !!process.env["REPLIT_ENTERPRISE_API_KEY"];
}

let lastApiError: string | null = null;
let lastApiOk = false;

export function getApiHealth(): { ok: boolean; error: string | null } {
  return { ok: lastApiOk, error: lastApiError };
}

class EnterpriseApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function rawFetch(
  path: string,
  params: Record<string, string | undefined>,
): Promise<{ body: unknown; headers: Headers }> {
  const key = process.env["REPLIT_ENTERPRISE_API_KEY"];
  if (!key) throw new EnterpriseApiError(0, "REPLIT_ENTERPRISE_API_KEY is not set");

  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, v);
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${key}` },
  });

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("Retry-After") ?? "5");
    throw Object.assign(new EnterpriseApiError(429, "rate limited"), {
      retryAfterMs: Math.max(1000, retryAfter * 1000),
    });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new EnterpriseApiError(
      res.status,
      `Enterprise API ${path} failed (${res.status}): ${text.slice(0, 300)}`,
    );
  }

  const body = (await res.json()) as unknown;
  return { body, headers: res.headers };
}

// ---------- Date ranges ----------

/** All spend data before this date is excluded from every query. */
export const SPEND_DATA_CUTOFF_ISO = "2026-05-20T00:00:00.000Z";
export const SPEND_DATA_CUTOFF_MS = new Date(SPEND_DATA_CUTOFF_ISO).getTime();
export const SPEND_DATA_CUTOFF_LABEL = "May 2026-present";

export type RangeType = "billing" | "mtd" | "ytd" | "custom";

export interface UsageRange {
  key: string; // cache key
  label: string;
  params: Record<string, string>; // billingPeriod OR startTime/endTime
}

export function resolveRange(
  rangeType: string | undefined,
  startDate?: string,
  endDate?: string,
): UsageRange {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  switch (rangeType) {
    case "mtd": {
      const rawStart = new Date(Date.UTC(y, m, 1)).getTime();
      const effectiveStart = new Date(Math.max(rawStart, SPEND_DATA_CUTOFF_MS));
      return {
        key: `mtd:${effectiveStart.toISOString().slice(0, 10)}`,
        label: `${now.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })} (MTD)`,
        params: { startTime: effectiveStart.toISOString(), endTime: now.toISOString() },
      };
    }
    case "ytd": {
      const rawStart = new Date(Date.UTC(y, 0, 1)).getTime();
      const effectiveStart = new Date(Math.max(rawStart, SPEND_DATA_CUTOFF_MS));
      return {
        key: `ytd:${effectiveStart.toISOString().slice(0, 10)}`,
        label: `${y} year to date`,
        params: { startTime: effectiveStart.toISOString(), endTime: now.toISOString() },
      };
    }
    case "custom": {
      if (!startDate || !endDate) {
        throw new EnterpriseApiError(400, "startDate and endDate are required for a custom range");
      }
      const rawStart = new Date(`${startDate}T00:00:00.000Z`);
      const end = new Date(`${endDate}T00:00:00.000Z`);
      end.setUTCDate(end.getUTCDate() + 1); // inclusive end date -> exclusive boundary
      if (isNaN(rawStart.getTime()) || isNaN(end.getTime()) || end <= rawStart) {
        throw new EnterpriseApiError(400, "Invalid custom date range");
      }
      const effectiveStart = new Date(Math.max(rawStart.getTime(), SPEND_DATA_CUTOFF_MS));
      if (effectiveStart >= end) {
        throw new EnterpriseApiError(
          400,
          `Date range predates available spend data (cutoff: ${SPEND_DATA_CUTOFF_ISO.slice(0, 10)})`,
        );
      }
      const effectiveStartDate = effectiveStart.toISOString().slice(0, 10);
      return {
        key: `custom:${effectiveStartDate}:${endDate}`,
        label: `${effectiveStartDate} to ${endDate}`,
        params: { startTime: effectiveStart.toISOString(), endTime: end.toISOString() },
      };
    }
    default:
      return {
        key: "billing:from-cutoff",
        label: SPEND_DATA_CUTOFF_LABEL,
        params: { startTime: SPEND_DATA_CUTOFF_ISO, endTime: now.toISOString() },
      };
  }
}

export function isBadRangeError(err: unknown): boolean {
  return err instanceof EnterpriseApiError && err.status === 400;
}

// ---------- Serial usage queue (~100 req/min budget) ----------

type QueueTask = {
  run: () => Promise<void>;
  priority: number; // 0 = high (interactive), 1 = low (background)
  key: string;
};

const usageQueue: QueueTask[] = [];
const queuedKeys = new Set<string>();
let queueRunning = false;
let pauseUntil = 0;

function pumpQueue(): void {
  if (queueRunning) return;
  queueRunning = true;
  void (async () => {
    while (usageQueue.length > 0) {
      const now = Date.now();
      if (pauseUntil > now) {
        await new Promise((r) => setTimeout(r, pauseUntil - now));
      }
      usageQueue.sort((a, b) => a.priority - b.priority);
      const task = usageQueue.shift();
      if (!task) break;
      try {
        await task.run();
      } finally {
        // Keep the key registered while the task is active so polling cannot
        // enqueue the same Enterprise API request again.
        queuedKeys.delete(task.key);
      }
      // Gentle pacing: keeps well under 100/min with headroom.
      await new Promise((r) => setTimeout(r, 700));
    }
    queueRunning = false;
  })();
}

function enqueueUsage(key: string, priority: number, run: () => Promise<void>): boolean {
  if (queuedKeys.has(key)) return false;
  queuedKeys.add(key);
  usageQueue.push({ key, priority, run });
  pumpQueue();
  return true;
}

export function pendingUsageCount(): number {
  return usageQueue.length + (queueRunning ? 1 : 0);
}

interface UsageMetricEntry {
  id: string;
  name: string;
  category: string;
  costUsd: number;
}

interface UsageGroupEntry {
  key: { userId?: string; workspaceId?: string; projectId?: string; date?: string };
  totalCostUsd: number;
  metrics?: UsageMetricEntry[];
}

interface UsageData {
  interval: { startTime: string; endTime: string };
  totalCostUsd: number;
  attributableTotalCostUsd: number;
  unattributableTotalCostUsd: number;
  groups: UsageGroupEntry[];
  pagination: { cursor: string | null; hasMore: boolean };
}

async function usageFetch(
  params: Record<string, string | undefined>,
): Promise<UsageData> {
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      const { body, headers } = await rawFetch("/usage", params);
      lastApiOk = true;
      lastApiError = null;
      const remaining = Number(headers.get("X-RateLimit-Remaining") ?? "10");
      if (remaining <= 3) {
        const reset = Number(headers.get("X-RateLimit-Reset") ?? "10");
        // The API may return either seconds-until-reset or a Unix timestamp.
        const resetDelayMs = reset > 1_000_000_000
          ? reset * 1000 - Date.now()
          : reset * 1000;
        pauseUntil = Date.now() + Math.max(2000, resetDelayMs);
        logger.warn({ remaining }, "Usage rate budget low; pausing queue");
      }
      return (body as { data: UsageData }).data;
    } catch (err) {
      const e = err as EnterpriseApiError & { retryAfterMs?: number };
      if (e.status === 429 && attempts <= 5) {
        pauseUntil = Date.now() + (e.retryAfterMs ?? 5000);
        logger.warn({ attempts }, "Usage 429; backing off");
        await new Promise((r) => setTimeout(r, e.retryAfterMs ?? 5000));
        continue;
      }
      lastApiOk = false;
      lastApiError = e.message;
      throw e;
    }
  }
}

// ---------- Directory (workspaces, groups, members, platform budgets) ----------

interface Pagination {
  cursor: string | null;
  hasMore: boolean;
}

async function paginate<T>(
  path: string,
  params: Record<string, string | undefined>,
  maxPages = 200,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const { body } = await rawFetch(path, { ...params, limit: "100", cursor });
    lastApiOk = true;
    lastApiError = null;
    const resp = body as { data: T[]; pagination: Pagination };
    out.push(...resp.data);
    if (!resp.pagination.hasMore || !resp.pagination.cursor) return out;
    cursor = resp.pagination.cursor;
  }
  logger.warn({ path }, "Pagination truncated at maxPages — results may be incomplete");
  return out;
}

export interface EnterpriseWorkspace {
  id: string;
  name: string;
  slug: string;
  memberCount: number;
}

export interface EnterpriseGroup {
  id: string;
  workspaceId: string;
  name: string;
  type: string;
}

const BUILT_IN_GROUP_TYPES = new Set(["admin", "member", "guest"]);

export function isCustomGroup(group: EnterpriseGroup): boolean {
  return !BUILT_IN_GROUP_TYPES.has(group.type.toLowerCase());
}

export interface EnterpriseMember {
  userId: string;
  username: string;
  email: string;
  name: string | null;
  // Whether this member is an account-wide administrator of the Enterprise org.
  isAccountAdmin: boolean;
  // per-workspace role/disabled state
  workspaces: Map<string, { role: string; isDisabled: boolean }>;
}

interface RawMember {
  user: {
    id: string;
    username: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
  };
  // Account-wide admin flag. The Enterprise directory may expose this as a
  // top-level boolean or nested under the user; parse defensively.
  isAccountAdmin?: boolean;
  user_is_account_admin?: boolean;
  workspaces: { id: string; role: string; isDisabled: boolean }[];
}

/** Extract the account-admin flag from a raw directory member, tolerating
 * a few plausible field placements without weakening the closed-by-default
 * posture (anything unrecognized resolves to false). */
export function parseIsAccountAdmin(rm: RawMember): boolean {
  const user = rm.user as unknown as Record<string, unknown> | undefined;
  return (
    rm.isAccountAdmin === true ||
    rm.user_is_account_admin === true ||
    (user?.["isAccountAdmin"] === true) ||
    (user?.["is_account_admin"] === true)
  );
}
export interface PlatformBudgets {
  // workspaceId -> group limits (groupId -> amountUsd)
  groupLimits: Map<string, Map<string, number>>;
  // workspaceId -> user limits (userId -> amountUsd)
  userLimits: Map<string, Map<string, number>>;
  // workspaceId -> default per-user limit
  workspaceDefaults: Map<string, number>;
}

interface RawBudget {
  type: string;
  workspaceId?: string;
  groupId?: string;
  userId?: string;
  amountUsd?: number;
}

const DIRECTORY_TTL_MS = 15 * 60 * 1000;
const USAGE_TTL_MS = 10 * 60 * 1000;

// ---------- DB serialisation helpers ----------

interface SerializedDirectory {
  fetchedAt: number;
  workspaces: Record<string, EnterpriseWorkspace>;
  groups: EnterpriseGroup[];
  allGroups?: EnterpriseGroup[];
  groupMembers: Record<string, string[]>;
  members: Record<
    string,
    {
      userId: string;
      username: string;
      email: string;
      name: string | null;
      isAccountAdmin?: boolean;
      workspaces: Record<string, { role: string; isDisabled: boolean }>;
    }
  >;
  budgets: {
    groupLimits: Record<string, Record<string, number>>;
    userLimits: Record<string, Record<string, number>>;
    workspaceDefaults: Record<string, number>;
  };
}

function serializeDirectory(d: DirectoryCache): SerializedDirectory {
  const workspaces: Record<string, EnterpriseWorkspace> = {};
  for (const [k, v] of d.workspaces) workspaces[k] = v;

  const groupMembers: Record<string, string[]> = {};
  for (const [k, v] of d.groupMembers) groupMembers[k] = v;

  const members: SerializedDirectory["members"] = {};
  for (const [k, v] of d.members) {
    const ws: Record<string, { role: string; isDisabled: boolean }> = {};
    for (const [wk, wv] of v.workspaces) ws[wk] = wv;
    members[k] = { userId: v.userId, username: v.username, email: v.email, name: v.name, isAccountAdmin: v.isAccountAdmin, workspaces: ws };
  }

  const groupLimits: Record<string, Record<string, number>> = {};
  for (const [wsId, m] of d.budgets.groupLimits) {
    groupLimits[wsId] = {};
    for (const [gId, amt] of m) groupLimits[wsId]![gId] = amt;
  }
  const userLimits: Record<string, Record<string, number>> = {};
  for (const [wsId, m] of d.budgets.userLimits) {
    userLimits[wsId] = {};
    for (const [uId, amt] of m) userLimits[wsId]![uId] = amt;
  }
  const workspaceDefaults: Record<string, number> = {};
  for (const [wsId, amt] of d.budgets.workspaceDefaults) workspaceDefaults[wsId] = amt;

  return {
    fetchedAt: d.fetchedAt,
    workspaces,
    groups: d.groups,
    allGroups: d.allGroups,
    groupMembers,
    members,
    budgets: { groupLimits, userLimits, workspaceDefaults },
  };
}

function deserializeDirectory(s: SerializedDirectory): DirectoryCache {
  const workspaces = new Map<string, EnterpriseWorkspace>(Object.entries(s.workspaces));
  const groupMembers = new Map<string, string[]>(Object.entries(s.groupMembers));

  const members = new Map<string, EnterpriseMember>();
  for (const [k, v] of Object.entries(s.members)) {
    members.set(k, {
      userId: v.userId,
      username: v.username,
      email: v.email,
      name: v.name,
      isAccountAdmin: v.isAccountAdmin ?? false,
      workspaces: new Map(Object.entries(v.workspaces)),
    });
  }

  const groupLimits = new Map<string, Map<string, number>>();
  for (const [wsId, m] of Object.entries(s.budgets.groupLimits)) {
    groupLimits.set(wsId, new Map(Object.entries(m)));
  }
  const userLimits = new Map<string, Map<string, number>>();
  for (const [wsId, m] of Object.entries(s.budgets.userLimits)) {
    userLimits.set(wsId, new Map(Object.entries(m)));
  }
  const workspaceDefaults = new Map<string, number>(Object.entries(s.budgets.workspaceDefaults));

  const allGroups = s.allGroups ?? s.groups;

  return {
    fetchedAt: s.fetchedAt,
    workspaces,
    groups: allGroups.filter(isCustomGroup),
    allGroups,
    groupMembers,
    members,
    budgets: { groupLimits, userLimits, workspaceDefaults },
  };
}

// ---------- DB write-through helpers (fire-and-forget) ----------

function persistDirectoryToDb(d: DirectoryCache): void {
  const serialized = serializeDirectory(d);
  db.insert(apiDirectoryCacheTable)
    .values({ id: "singleton", directoryJson: serialized, fetchedAt: new Date(d.fetchedAt) })
    .onConflictDoUpdate({
      target: apiDirectoryCacheTable.id,
      set: { directoryJson: serialized, fetchedAt: new Date(d.fetchedAt) },
    })
    .catch((err: unknown) => logger.warn({ err }, "Failed to persist directory cache to DB"));
}

function persistSpendToDb(rangeKey: string, groupId: string, spend: GroupSpend): void {
  db.insert(apiSpendCacheTable)
    .values({
      rangeKey,
      groupId,
      spendUsd: spend.spendUsd,
      periodStart: spend.periodStart,
      periodEnd: spend.periodEnd,
      fetchedAt: new Date(spend.fetchedAt),
    })
    .onConflictDoUpdate({
      target: [apiSpendCacheTable.rangeKey, apiSpendCacheTable.groupId],
      set: {
        spendUsd: spend.spendUsd,
        periodStart: spend.periodStart,
        periodEnd: spend.periodEnd,
        fetchedAt: new Date(spend.fetchedAt),
      },
    })
    .catch((err: unknown) => logger.warn({ err, rangeKey, groupId }, "Failed to persist spend cache to DB"));
}

// ---------- Cold-start cache hydration ----------

export async function initCache(): Promise<void> {
  try {
    const [dirRow, spendRows] = await Promise.all([
      db.query.apiDirectoryCacheTable.findFirst({ where: eq(apiDirectoryCacheTable.id, "singleton") }),
      db.select().from(apiSpendCacheTable),
    ]);

    if (dirRow) {
      try {
        const deserialized = deserializeDirectory(dirRow.directoryJson as SerializedDirectory);
        // Only hydrate if not already populated by a concurrent fetch
        if (!directoryCache) {
          directoryCache = deserialized;
          logger.info({ fetchedAt: new Date(deserialized.fetchedAt).toISOString() }, "Directory cache hydrated from DB");
        }
      } catch (err) {
        logger.warn({ err }, "Failed to deserialize directory cache from DB");
      }
    }

    for (const row of spendRows) {
      const cacheKey = `${row.rangeKey}|${row.groupId}`;
      if (!spendCache.has(cacheKey)) {
        spendCache.set(cacheKey, {
          spendUsd: row.spendUsd,
          fetchedAt: row.fetchedAt.getTime(),
          periodStart: row.periodStart,
          periodEnd: row.periodEnd,
        });
      }
    }
    if (spendRows.length > 0) {
      logger.info({ count: spendRows.length }, "Spend cache hydrated from DB");
    }
  } catch (err) {
    logger.warn({ err }, "Failed to hydrate caches from DB — will fetch fresh on first request");
  }
}

interface DirectoryCache {
  fetchedAt: number;
  workspaces: Map<string, EnterpriseWorkspace>;
  groups: EnterpriseGroup[]; // custom/SCIM groups exposed by the dashboard
  allGroups: EnterpriseGroup[]; // raw Enterprise API list, including built-in role groups
  groupMembers: Map<string, string[]>; // groupId -> userIds
  members: Map<string, EnterpriseMember>; // userId -> member
  budgets: PlatformBudgets;
}

let directoryCache: DirectoryCache | null = null;
let directoryPromise: Promise<DirectoryCache> | null = null;
export function __setMemberUsageForTests(
  first: string,
  second: string | ReadonlyMap<string, ReadonlyMap<string, number>> | null,
  third?: Map<string, number> | null | ReadonlyMap<string, number>,
): void {
  if (typeof second === "string") {
    const key = `${second}|${first}`;
    const byUser = third as Map<string, number> | null;
    if (byUser === null) {
      memberUsageCache.delete(key);
      return;
    }
    const totalCostUsd = [...byUser.values()].reduce((sum, spend) => sum + spend, 0);
    memberUsageCache.set(key, {
      fetchedAt: Date.now(),
      byUser: new Map(byUser),
      attributableTotalCostUsd: totalCostUsd,
      unattributableTotalCostUsd: 0,
      totalCostUsd,
    });
    return;
  }

  const rangeKey = first;
  const usageByGroup = second;
  const unattributableByGroup = (third as ReadonlyMap<string, number> | undefined) ?? new Map();
  for (const key of memberUsageCache.keys()) {
    if (key.startsWith(`${rangeKey}|`)) memberUsageCache.delete(key);
  }
  if (!usageByGroup) return;
  for (const [groupId, byUser] of usageByGroup) {
    const totalCostUsd = [...byUser.values()].reduce((sum, spend) => sum + spend, 0);
    memberUsageCache.set(`${rangeKey}|${groupId}`, {
      fetchedAt: Date.now(),
      byUser: new Map(byUser),
      attributableTotalCostUsd: totalCostUsd,
      unattributableTotalCostUsd: unattributableByGroup.get(groupId) ?? 0,
      totalCostUsd: totalCostUsd + (unattributableByGroup.get(groupId) ?? 0),
    });
  }
}
/**
 * Test-only seam: seed the in-memory directory cache with a representative
 * fixture so authorization/scoping can be exercised without calling the real
 * Enterprise API. Production never calls this — the cache is populated by the
 * real paginated fetch in {@link getDirectory}. Passing `null` clears it.
 */
/** Test-only: seed the per-workspace spend cache (used for extra-workspace rollup).
 *  Passing `null` for byUser clears the entry. */
export function __setWsSpendForTests(
  wsId: string,
  rangeKey: string,
  byUser: Map<string, number> | null,
): void {
  const key = `${rangeKey}|${wsId}`;
  if (byUser === null) {
    wsSpendCache.delete(key);
    wsSpendCachedAt.delete(key);
  } else {
    wsSpendCache.set(key, byUser);
    wsSpendCachedAt.set(key, Date.now());
  }
}

export function __setDirectoryCacheForTests(
  fixture: {
    workspaces?: Map<string, EnterpriseWorkspace>;
    groups: EnterpriseGroup[];
    groupMembers?: Map<string, string[]>;
    members: Map<string, EnterpriseMember>;
  } | null,
): void {
  if (!fixture) {
    directoryCache = null;
    return;
  }
  directoryCache = {
    fetchedAt: Date.now(),
    workspaces: fixture.workspaces ?? new Map(),
    groups: fixture.groups,
    allGroups: fixture.groups,
    groupMembers: fixture.groupMembers ?? new Map(),
    members: fixture.members,
    budgets: { groupLimits: new Map(), userLimits: new Map(), workspaceDefaults: new Map() },
  };
}
export async function getDirectory(force = false): Promise<DirectoryCache> {
  const now = Date.now();
  if (!force && directoryCache && now - directoryCache.fetchedAt < DIRECTORY_TTL_MS) {
    return directoryCache;
  }
  if (directoryPromise) return directoryPromise;
  directoryPromise = (async () => {
    try {
      const workspaces = await paginate<EnterpriseWorkspace>("/workspaces", {});
      const wsMap = new Map(workspaces.map((w) => [w.id, w]));

      const allGroups: EnterpriseGroup[] = [];
      for (const ws of workspaces) {
        const wsGroups = await paginate<EnterpriseGroup>("/groups", { workspaceId: ws.id });
        for (const g of wsGroups) {
          allGroups.push({ ...g, workspaceId: g.workspaceId || ws.id });
        }
      }
      const groups = allGroups.filter(isCustomGroup);

      const groupMembers = new Map<string, string[]>();
      for (const g of groups) {
        try {
          const users = await paginate<{ userId: string }>(
            `/groups/${encodeURIComponent(g.id)}/users`,
            {},
          );
          groupMembers.set(g.id, users.map((u) => u.userId));
        } catch (err) {
          logger.warn({ err, groupId: g.id }, "Failed to fetch group members");
        }
      }

      const rawMembers = await paginate<RawMember>("/members", {});
      const members = new Map<string, EnterpriseMember>();
      for (const rm of rawMembers) {
        const name =
          [rm.user.firstName, rm.user.lastName].filter(Boolean).join(" ") || null;
        members.set(rm.user.id, {
          userId: rm.user.id,
          username: rm.user.username,
          email: rm.user.email,
          name,
          isAccountAdmin: parseIsAccountAdmin(rm),
          workspaces: new Map(
            rm.workspaces.map((w) => [w.id, { role: w.role, isDisabled: w.isDisabled }]),
          ),
        });
      }

      const budgets: PlatformBudgets = {
        groupLimits: new Map(),
        userLimits: new Map(),
        workspaceDefaults: new Map(),
      };
      try {
        const rawBudgets = await paginate<RawBudget>("/budgets", {});
        for (const b of rawBudgets) {
          if (!b.workspaceId || b.amountUsd == null) continue;
          if (b.type === "workspace_group_limit" && b.groupId) {
            if (!budgets.groupLimits.has(b.workspaceId))
              budgets.groupLimits.set(b.workspaceId, new Map());
            budgets.groupLimits.get(b.workspaceId)!.set(b.groupId, b.amountUsd);
          } else if (b.type === "workspace_user_limit" && b.userId) {
            if (!budgets.userLimits.has(b.workspaceId))
              budgets.userLimits.set(b.workspaceId, new Map());
            budgets.userLimits.get(b.workspaceId)!.set(b.userId, b.amountUsd);
          } else if (b.type === "workspace_default_user_limit") {
            budgets.workspaceDefaults.set(b.workspaceId, b.amountUsd);
          }
        }
      } catch (err) {
        logger.warn({ err }, "Failed to fetch platform budgets");
      }

      directoryCache = {
        fetchedAt: Date.now(),
        workspaces: wsMap,
        groups,
        allGroups,
        groupMembers,
        members,
        budgets,
      };
      persistDirectoryToDb(directoryCache);
      return directoryCache;
    } finally {
      directoryPromise = null;
    }
  })();
  return directoryPromise;
}

// ---------- Group spend cache (keyed by groupId + range) ----------

export interface GroupSpend {
  spendUsd: number;
  fetchedAt: number;
  periodStart: string;
  periodEnd: string;
}

const spendCache = new Map<string, GroupSpend>(); // `${rangeKey}|${groupId}`

export function getSpend(groupId: string, rangeKey = "billing:from-cutoff"): GroupSpend | undefined {
  return spendCache.get(`${rangeKey}|${groupId}`);
}

export function getBillingPeriod(): { start: string | null; label: string } {
  for (const [k, s] of spendCache) {
    if (!k.startsWith("billing:from-cutoff|")) continue;
    return {
      start: s.periodStart,
      label: SPEND_DATA_CUTOFF_LABEL,
    };
  }
  return {
    start: null,
    label: SPEND_DATA_CUTOFF_LABEL,
  };
}

/**
 * Result of queueGroupSpendFetch:
 * - "fresh_cache": cache is fresh, nothing queued, onDone NOT registered —
 *   read the cached value via getSpend() if needed.
 * - "queued": a new fetch was enqueued; onDone fires when it completes.
 * - "duplicate_queued": an identical fetch is already in flight/queued;
 *   onDone was still registered and fires when that fetch completes.
 */
export type QueueSpendResult = "fresh_cache" | "queued" | "duplicate_queued";

// Completion callbacks per `${rangeKey}|${groupId}`, fanned out when the
// in-flight fetch lands, so duplicate callers never act on stale data.
const spendCallbacks = new Map<string, Array<(spend: GroupSpend) => void>>();

function registerSpendCallback(cacheKey: string, cb: (spend: GroupSpend) => void): void {
  const list = spendCallbacks.get(cacheKey);
  if (list) list.push(cb);
  else spendCallbacks.set(cacheKey, [cb]);
}

function fireSpendCallbacks(cacheKey: string, spend: GroupSpend): void {
  const list = spendCallbacks.get(cacheKey);
  if (!list) return;
  spendCallbacks.delete(cacheKey);
  for (const cb of list) {
    try {
      cb(spend);
    } catch (err) {
      logger.error({ err, cacheKey }, "Spend callback failed");
    }
  }
}

export function queueGroupSpendFetch(
  group: EnterpriseGroup,
  priority: number,
  force = false,
  onDone?: (spend: GroupSpend) => void,
  range: UsageRange = resolveRange("billing"),
): QueueSpendResult {
  const cacheKey = `${range.key}|${group.id}`;
  const cached = spendCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.fetchedAt < USAGE_TTL_MS) {
    return "fresh_cache";
  }
  if (onDone) registerSpendCallback(cacheKey, onDone);
  const queued = enqueueUsage(`usage:${cacheKey}`, priority, async () => {
    try {
      const data = await usageFetch({
        workspaceId: group.workspaceId,
        groupId: group.id,
        ...range.params,
      });
      const spend: GroupSpend = {
        spendUsd: data.totalCostUsd,
        fetchedAt: Date.now(),
        periodStart: data.interval.startTime,
        periodEnd: data.interval.endTime,
      };
      spendCache.set(cacheKey, spend);
      persistSpendToDb(range.key, group.id, spend);
      // The network request has landed and cache is current. Release the queue
      // key before callbacks run so a callback-triggered forced refresh is a
      // new request rather than being reported as a duplicate of the finished one.
      queuedKeys.delete(`usage:${cacheKey}`);
      fireSpendCallbacks(cacheKey, spend);
    } catch (err) {
      logger.error({ err, groupId: group.id, range: range.key }, "Failed to fetch group usage");
      // Drop pending callbacks so they don't fire with a later, unrelated fetch.
      spendCallbacks.delete(cacheKey);
    }
  });
  return queued ? "queued" : "duplicate_queued";
}

export async function refreshAllGroupSpends(
  priority = 1,
  onGroupDone?: (group: EnterpriseGroup, spend: GroupSpend) => void,
  range: UsageRange = resolveRange("billing"),
): Promise<EnterpriseGroup[]> {
  const dir = await getDirectory();
  for (const g of dir.groups) {
    queueGroupSpendFetch(g, priority, false, (spend) => onGroupDone?.(g, spend), range);
  }
  return dir.groups;
}

// ---------- Per-member group usage (groupBy=member, one call per group+range) ----------

export interface MemberUsage {
  fetchedAt: number;
  byUser: Map<string, number>;
  attributableTotalCostUsd: number;
  unattributableTotalCostUsd: number;
  totalCostUsd: number;
}

const memberUsageCache = new Map<string, MemberUsage>(); // `${rangeKey}|${groupId}`

export function getMemberUsage(groupId: string, rangeKey: string): MemberUsage | undefined {
  return memberUsageCache.get(`${rangeKey}|${groupId}`);
}
export function queueMemberUsageFetch(
  group: EnterpriseGroup,
  range: UsageRange,
  priority = 0,
  force = false,
): boolean {
  const cacheKey = `${range.key}|${group.id}`;
  const cached = memberUsageCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.fetchedAt < USAGE_TTL_MS) {
    return false;
  }
  return enqueueUsage(`member-usage:${cacheKey}`, priority, async () => {
    try {
      const byUser = new Map<string, number>();
      let cursor: string | undefined;
      let first: UsageData | null = null;
      for (let page = 0; page < 50; page++) {
        const data = await usageFetch({
          workspaceId: group.workspaceId,
          groupId: group.id,
          groupBy: "member",
          limit: "100",
          cursor,
          ...range.params,
        });
        if (!first) first = data;
        for (const entry of data.groups) {
          if (entry.key.userId) {
            byUser.set(entry.key.userId, (byUser.get(entry.key.userId) ?? 0) + entry.totalCostUsd);
          }
        }
        if (!data.pagination?.hasMore || !data.pagination.cursor) break;
        cursor = data.pagination.cursor;
        // Pace intra-task pagination the same as the queue so a multi-page
        // member fetch can't burst past the /usage rate budget.
        await new Promise((r) => setTimeout(r, 700));
      }
      memberUsageCache.set(cacheKey, {
        fetchedAt: Date.now(),
        byUser,
        attributableTotalCostUsd: first?.attributableTotalCostUsd ?? 0,
        unattributableTotalCostUsd: first?.unattributableTotalCostUsd ?? 0,
        totalCostUsd: first?.totalCostUsd ?? 0,
      });
    } catch (err) {
      logger.error({ err, groupId: group.id, range: range.key }, "Failed to fetch member usage");
    }
  });
}

// ---------- Per-workspace member spend (workspaces without custom groups) ----------
// Users often belong to both the main Comcast workspace (where all AZ-Replit groups
// live) AND a dedicated team workspace (e.g. Strategic Development). Their spend in
// the dedicated workspace is not captured by the per-group Comcast fetches, so we
// fetch each extra workspace's member-level totals and merge them in.

const wsSpendCache = new Map<string, Map<string, number>>(); // `${rangeKey}|${wsId}` → userId → spend
const wsSpendCachedAt = new Map<string, number>(); // `${rangeKey}|${wsId}` → fetchedAt timestamp
const wsSpendFetching = new Set<string>(); // in-flight cache keys

export function getWsSpendByUser(wsId: string, rangeKey: string): Map<string, number> | undefined {
  return wsSpendCache.get(`${rangeKey}|${wsId}`);
}

export function queueWsSpendFetch(
  wsId: string,
  range: UsageRange,
  priority = 1,
  force = false,
): boolean {
  const cacheKey = `${range.key}|${wsId}`;
  const cached = wsSpendCache.get(cacheKey);
  const cachedAt = wsSpendCachedAt.get(cacheKey);
  // Apply the same TTL as per-group member usage so cross-workspace totals refresh
  // at the same cadence (rather than freezing for the lifetime of the server process).
  if (!force && cached && cachedAt && Date.now() - cachedAt < USAGE_TTL_MS) return false;
  if (wsSpendFetching.has(cacheKey)) return false;
  wsSpendFetching.add(cacheKey);
  return enqueueUsage(`ws-spend:${cacheKey}`, priority, async () => {
    try {
      const byUser = new Map<string, number>();
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        const data = await usageFetch({
          workspaceId: wsId,
          groupBy: "member",
          limit: "100",
          cursor,
          ...range.params,
        });
        for (const entry of data.groups) {
          if (entry.key.userId) {
            byUser.set(entry.key.userId, (byUser.get(entry.key.userId) ?? 0) + entry.totalCostUsd);
          }
        }
        if (!data.pagination?.hasMore || !data.pagination.cursor) break;
        cursor = data.pagination.cursor;
        await new Promise((r) => setTimeout(r, 700));
      }
      wsSpendCache.set(cacheKey, byUser);
      wsSpendCachedAt.set(cacheKey, Date.now());
    } catch (err) {
      logger.error({ err, wsId, range: range.key }, "Failed to fetch workspace member spend");
    } finally {
      wsSpendFetching.delete(cacheKey);
    }
  });
}

/** Queue per-member spend fetches for every workspace that owns no custom groups.
 *  These are the "extra" workspaces where users accumulate spend beyond their
 *  Comcast workspace group membership. */
export function queueExtraWorkspacesFetch(
  dir: DirectoryCache,
  range: UsageRange,
  priority = 1,
): void {
  const groupWorkspaceIds = new Set(dir.groups.map((g) => g.workspaceId));
  for (const [wsId] of dir.workspaces) {
    if (!groupWorkspaceIds.has(wsId)) {
      queueWsSpendFetch(wsId, range, priority);
    }
  }
}

/** Returns the summed extra-workspace spend per user and whether all fetches have landed. */
export function getExtraWorkspaceSpend(
  dir: DirectoryCache,
  rangeKey: string,
): { byUser: Map<string, number>; isComplete: boolean; loadedCount: number; totalCount: number } {
  const groupWorkspaceIds = new Set(dir.groups.map((g) => g.workspaceId));
  const byUser = new Map<string, number>();
  let loadedCount = 0;
  let totalCount = 0;
  for (const [wsId] of dir.workspaces) {
    if (groupWorkspaceIds.has(wsId)) continue;
    totalCount += 1;
    const wsData = wsSpendCache.get(`${rangeKey}|${wsId}`);
    if (!wsData) continue;
    loadedCount += 1;
    for (const [userId, spend] of wsData) {
      byUser.set(userId, (byUser.get(userId) ?? 0) + spend);
    }
  }
  return { byUser, isComplete: loadedCount === totalCount, loadedCount, totalCount };
}

// ---------- Per-project group usage (groupBy=project, one call per group+range) ----------

export interface ProjectUsageMetric {
  id: string;
  name: string;
  category: string;
  costUsd: number;
}

export interface ProjectUsageEntry {
  projectId: string;
  totalCostUsd: number;
  metrics: ProjectUsageMetric[];
}

export interface ProjectUsage {
  fetchedAt: number;
  byProject: Map<string, ProjectUsageEntry>;
  totalCostUsd: number;
}

const projectUsageCache = new Map<string, ProjectUsage>(); // `${rangeKey}|${groupId}`

export function getProjectUsage(groupId: string, rangeKey: string): ProjectUsage | undefined {
  return projectUsageCache.get(`${rangeKey}|${groupId}`);
}

export function queueProjectUsageFetch(
  group: EnterpriseGroup,
  range: UsageRange,
  priority = 0,
  force = false,
): boolean {
  const cacheKey = `${range.key}|${group.id}`;
  const cached = projectUsageCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.fetchedAt < USAGE_TTL_MS) {
    return false;
  }
  return enqueueUsage(`project-usage:${cacheKey}`, priority, async () => {
    try {
      const byProject = new Map<string, ProjectUsageEntry>();
      let cursor: string | undefined;
      let firstTotal = 0;
      for (let page = 0; page < 50; page++) {
        const data = await usageFetch({
          workspaceId: group.workspaceId,
          groupId: group.id,
          groupBy: "project",
          limit: "100",
          cursor,
          ...range.params,
        });
        if (page === 0) firstTotal = data.totalCostUsd;
        for (const entry of data.groups) {
          if (entry.key.projectId) {
            const metrics: ProjectUsageMetric[] = (entry.metrics ?? []).map((m) => ({
              id: m.id,
              name: m.name,
              category: m.category,
              costUsd: m.costUsd,
            }));
            const existing = byProject.get(entry.key.projectId);
            if (existing) {
              existing.totalCostUsd += entry.totalCostUsd;
              // Merge metrics by id
              for (const m of metrics) {
                const em = existing.metrics.find((x) => x.id === m.id);
                if (em) {
                  em.costUsd += m.costUsd;
                } else {
                  existing.metrics.push({ ...m });
                }
              }
            } else {
              byProject.set(entry.key.projectId, {
                projectId: entry.key.projectId,
                totalCostUsd: entry.totalCostUsd,
                metrics,
              });
            }
          }
        }
        if (!data.pagination?.hasMore || !data.pagination.cursor) break;
        cursor = data.pagination.cursor;
        await new Promise((r) => setTimeout(r, 700));
      }
      projectUsageCache.set(cacheKey, {
        fetchedAt: Date.now(),
        byProject,
        totalCostUsd: firstTotal,
      });
    } catch (err) {
      logger.error({ err, groupId: group.id, range: range.key }, "Failed to fetch project usage");
    }
  });
}

// ---------- Project titles (per workspace) ----------

interface RawProject {
  id: string;
  title?: string | null;
  creatorId?: string | null;
}

export interface ProjectInfo {
  title: string | null;
  creatorId: string | null;
}

// workspaceId -> projectId -> { title, creatorId }
const projectInfoCache = new Map<string, Map<string, ProjectInfo>>();
const projectTitlesFetching = new Set<string>();

export function getProjectTitles(workspaceId: string): Map<string, string> {
  const infoMap = projectInfoCache.get(workspaceId);
  if (!infoMap) return new Map();
  const out = new Map<string, string>();
  for (const [id, info] of infoMap) {
    if (info.title) out.set(id, info.title);
  }
  return out;
}

/** Returns undefined if cache not yet loaded for this workspace, otherwise the project's info. */
export function getProjectInfo(workspaceId: string, projectId: string): ProjectInfo | undefined {
  const infoMap = projectInfoCache.get(workspaceId);
  if (!infoMap) return undefined;
  return infoMap.get(projectId) ?? { title: null, creatorId: null };
}

/** Returns true if project info (titles + creatorIds) has been fetched for this workspace. */
export function hasProjectInfo(workspaceId: string): boolean {
  return projectInfoCache.has(workspaceId);
}

export function queueProjectTitlesFetch(workspaceId: string, priority = 0): boolean {
  if (projectInfoCache.has(workspaceId) || projectTitlesFetching.has(workspaceId)) return false;
  projectTitlesFetching.add(workspaceId);
  return enqueueUsage(`project-titles:${workspaceId}`, priority, async () => {
    try {
      const projects = await paginate<RawProject>("/projects", { workspaceId });
      const infoMap = new Map<string, ProjectInfo>();
      for (const p of projects) {
        infoMap.set(p.id, {
          title: p.title ?? null,
          creatorId: p.creatorId ?? null,
        });
      }
      projectInfoCache.set(workspaceId, infoMap);
    } catch (err) {
      logger.warn({ err, workspaceId }, "Failed to fetch project titles");
    } finally {
      projectTitlesFetching.delete(workspaceId);
    }
  });
}

/**
 * Two-phase deduped rollup combining Comcast + extra-workspace spend.
 *
 * Phase 1 – Comcast aggregation:
 *   Sum each user's per-group-project Comcast spend across ALL groups they appear in.
 *   Do NOT inject extra-workspace spend here. A user with $0 Comcast spend in Alpha
 *   (their first group) but $10 in Beta must not lose their $10 Beta spend because
 *   it was discarded when Alpha claimed the user in Phase 2.
 *
 * Phase 2 – Attribution + extra-workspace:
 *   Iterate groups in stable sort order. Attribute each user to their FIRST group
 *   (by directory membership when available, otherwise by API response membership).
 *   Add extra-workspace spend to that user's attributed group only — never injected
 *   into every group map before dedup.
 */
export function getDedupedUsageRollup(
  groups: EnterpriseGroup[],
  rangeKey: string,
  extraSpendByUser?: ReadonlyMap<string, number>,
  groupMembers?: ReadonlyMap<string, readonly string[]>,
): DedupedUsageRollup {
  const ordered: EnterpriseGroup[] = [...groups].sort(
    (a, b) =>
      a.workspaceId.localeCompare(b.workspaceId) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      a.id.localeCompare(b.id),
  );

  // Phase 1: combine distinct member-spend observations across groups. Identical
  // observations are the same account-level usage exposed through overlapping
  // group filters and must only count once; differing observations represent
  // separate group/project spend and are combined before stable attribution.
  let pendingCount = 0;
  const comcastSpendByUser = new Map<string, number>();
  const observedSpendByUser = new Map<string, Set<number>>();
  const usageByGroup = new Map<string, MemberUsage>();
  for (const group of ordered) {
    const usage = getMemberUsage(group.id, rangeKey);
    if (!usage) {
      pendingCount++;
      continue;
    }
    usageByGroup.set(group.id, usage);
    for (const [userId, spend] of usage.byUser) {
      let observations = observedSpendByUser.get(userId);
      if (!observations) {
        observations = new Set();
        observedSpendByUser.set(userId, observations);
      }
      if (observations.has(spend)) continue;
      observations.add(spend);
      comcastSpendByUser.set(userId, (comcastSpendByUser.get(userId) ?? 0) + spend);
    }
  }

  // Phase 2: attribute each user to their first group, then compute combined spend.
  // Extra-workspace spend is added once here, after attribution is determined.
  const byGroup = new Map<string, DedupedGroupRollup>();
  for (const group of ordered) byGroup.set(group.id, { spendUsd: 0, memberCount: 0, byUser: new Map() });

  const seenUsers = new Set<string>();
  let totalSpendUsd = 0;

  for (const group of ordered) {
    const groupRollup = byGroup.get(group.id)!;
    const rollupByUser = groupRollup.byUser as Map<string, number>;
    const unattributableSpend = usageByGroup.get(group.id)?.unattributableTotalCostUsd ?? 0;
    (groupRollup as { spendUsd: number }).spendUsd += unattributableSpend;
    totalSpendUsd += unattributableSpend;

    // Candidate members: directory membership (authoritative for $0-spend members)
    // unioned with API usage response (catches users missing from directory).
    const dirMembers: readonly string[] = groupMembers?.get(group.id) ?? [];
    const apiMembers: Iterable<string> = usageByGroup.get(group.id)?.byUser.keys() ?? [];
    const allCandidates = new Set<string>([...dirMembers, ...apiMembers]);

    for (const userId of allCandidates) {
      if (seenUsers.has(userId)) continue;
      seenUsers.add(userId);

      const comcastSpend = comcastSpendByUser.get(userId) ?? 0;
      const extraSpend = extraSpendByUser?.get(userId) ?? 0;
      const combined = comcastSpend + extraSpend;

      rollupByUser.set(userId, combined);
      (groupRollup as { spendUsd: number }).spendUsd += combined;
      (groupRollup as { memberCount: number }).memberCount += 1;
      totalSpendUsd += combined;
    }
  }

  return {
    byGroup,
    totalSpendUsd,
    totalMemberCount: seenUsers.size,
    pendingCount,
    isComplete: pendingCount === 0,
  };
}

export function getDedupedMemberCounts(
  groups: EnterpriseGroup[],
  membersByGroup: ReadonlyMap<string, readonly string[]>,
): Map<string, number> {
  return computeDedupedMemberCounts(groups, membersByGroup);
}
