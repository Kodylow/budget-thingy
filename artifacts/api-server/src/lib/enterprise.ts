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

/**
 * Serial priority queue for /usage calls (~100 req/min budget).
 * All /usage requests MUST go through this queue — never call /usage concurrently.
 */
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
      // Gentle pacing: ~1.5 calls/sec keeps well under 100/min with headroom.
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

// ---------- Directory (cheap endpoints, paginate fully) ----------

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

interface UsageData {
  interval: { startTime: string; endTime: string };
  totalCostUsd: number;
}

// ---------- Caches ----------

const DIRECTORY_TTL_MS = 15 * 60 * 1000;
const USAGE_TTL_MS = 10 * 60 * 1000;

interface DirectoryCache {
  fetchedAt: number;
  workspaces: Map<string, EnterpriseWorkspace>;
  groups: EnterpriseGroup[];
  memberCounts: Map<string, number>;
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
        const wsGroups = await paginate<EnterpriseGroup>("/groups", {
          workspaceId: ws.id,
        });
        for (const g of wsGroups) {
          groups.push({ ...g, workspaceId: g.workspaceId || ws.id });
        }
      }
      const memberCounts = new Map<string, number>();
      for (const g of groups) {
        try {
          const users = await paginate<{ userId: string }>(
            `/groups/${encodeURIComponent(g.id)}/users`,
            {},
          );
          memberCounts.set(g.id, users.length);
        } catch (err) {
          logger.warn({ err, groupId: g.id }, "Failed to fetch group members");
        }
      }
      directoryCache = { fetchedAt: Date.now(), workspaces: wsMap, groups, memberCounts };
      return directoryCache;
    } finally {
      directoryPromise = null;
    }
  })();
  return directoryPromise;
}

export interface GroupSpend {
  spendUsd: number;
  fetchedAt: number;
  periodStart: string;
  periodEnd: string;
}

const spendCache = new Map<string, GroupSpend>();

export function getSpend(groupId: string): GroupSpend | undefined {
  return spendCache.get(groupId);
}

export function getBillingPeriod(): { start: string | null; label: string } {
  for (const s of spendCache.values()) {
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

/**
 * Queue a spend fetch for one group. priority 0 = interactive, 1 = background.
 * Returns false if an identical fetch is already queued.
 */
export function queueGroupSpendFetch(
  group: EnterpriseGroup,
  priority: number,
  force = false,
  onDone?: (spend: GroupSpend) => void,
): boolean {
  const cached = spendCache.get(group.id);
  if (!force && cached && Date.now() - cached.fetchedAt < USAGE_TTL_MS) {
    return false;
  }
  return enqueueUsage(`usage:${group.id}`, priority, async () => {
    try {
      const data = await usageFetch({
        workspaceId: group.workspaceId,
        groupId: group.id,
        billingPeriod: "current",
      });
      const spend: GroupSpend = {
        spendUsd: data.totalCostUsd,
        fetchedAt: Date.now(),
        periodStart: data.interval.startTime,
        periodEnd: data.interval.endTime,
      };
      spendCache.set(group.id, spend);
      onDone?.(spend);
    } catch (err) {
      logger.error({ err, groupId: group.id }, "Failed to fetch group usage");
    }
  });
}

/** Ensure spend fetches are queued for every group (background priority). */
export async function refreshAllGroupSpends(
  priority = 1,
  onGroupDone?: (group: EnterpriseGroup, spend: GroupSpend) => void,
): Promise<EnterpriseGroup[]> {
  const dir = await getDirectory();
  for (const g of dir.groups) {
    queueGroupSpendFetch(g, priority, false, (spend) => onGroupDone?.(g, spend));
  }
  return dir.groups;
}
