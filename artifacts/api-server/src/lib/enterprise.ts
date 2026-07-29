import { logger } from "./logger";

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
        label: now.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }),
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
      queuedKeys.delete(task.key);
      await task.run();
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

interface UsageGroupEntry {
  key: { userId?: string; workspaceId?: string; projectId?: string; date?: string };
  totalCostUsd: number;
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
        pauseUntil = Date.now() + Math.max(2000, reset * 1000);
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

export interface EnterpriseMember {
  userId: string;
  username: string;
  email: string;
  name: string | null;
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
  workspaces: { id: string; role: string; isDisabled: boolean }[];
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

interface DirectoryCache {
  fetchedAt: number;
  workspaces: Map<string, EnterpriseWorkspace>;
  groups: EnterpriseGroup[];
  groupMembers: Map<string, string[]>; // groupId -> userIds
  members: Map<string, EnterpriseMember>; // userId -> member
  budgets: PlatformBudgets;
}

let directoryCache: DirectoryCache | null = null;
let directoryPromise: Promise<DirectoryCache> | null = null;

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

      const groups: EnterpriseGroup[] = [];
      for (const ws of workspaces) {
        const wsGroups = await paginate<EnterpriseGroup>("/groups", { workspaceId: ws.id });
        for (const g of wsGroups) {
          groups.push({ ...g, workspaceId: g.workspaceId || ws.id });
        }
      }

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
        groupMembers,
        members,
        budgets,
      };
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
    const d = new Date(s.periodStart);
    return {
      start: s.periodStart,
      label: d.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }),
    };
  }
  const now = new Date();
  return {
    start: null,
    label: now.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }),
  };
}

export function queueGroupSpendFetch(
  group: EnterpriseGroup,
  priority: number,
  force = false,
  onDone?: (spend: GroupSpend) => void,
  range: UsageRange = resolveRange("billing"),
): boolean {
  const cacheKey = `${range.key}|${group.id}`;
  const cached = spendCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.fetchedAt < USAGE_TTL_MS) {
    return false;
  }
  return enqueueUsage(`usage:${cacheKey}`, priority, async () => {
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
      onDone?.(spend);
    } catch (err) {
      logger.error({ err, groupId: group.id, range: range.key }, "Failed to fetch group usage");
    }
  });
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
