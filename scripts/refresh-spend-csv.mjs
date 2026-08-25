/**
 * Refresh attached_assets/spend-per-project.csv from the database cache.
 *
 * The API server durably persists project-usage data into `usage_sync_chunks`
 * (mode='group_project'). This script reads that cache + the directory cache
 * and builds the CSV without making live /usage API calls (which are
 * rate-limited and take too long for 173 groups interactively).
 * Project titles are fetched from /projects per workspace (fast, one call per
 * workspace).
 *
 * Prerequisites:
 *   - The API server must have run at least once so usage_sync_chunks and
 *     api_directory_cache are populated.
 *   - DATABASE_URL and REPLIT_ENTERPRISE_API_KEY must be set.
 *
 * Run:
 *   node scripts/refresh-spend-csv.mjs
 */

import pg from "pg";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, "../attached_assets/spend-per-project.csv");

// ── Validate environment ───────────────────────────────────────────────────
const KEY = process.env["REPLIT_ENTERPRISE_API_KEY"];
if (!KEY) throw new Error("REPLIT_ENTERPRISE_API_KEY is not set");
if (!process.env["DATABASE_URL"]) throw new Error("DATABASE_URL is not set");

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env["DATABASE_URL"] });

async function dbQuery(sql, params = []) {
  const res = await pool.query(sql, params);
  return res.rows;
}

// ── Aggregate project usage from DB chunk payloads ─────────────────────────
function aggregateProjectUsage(chunks) {
  const byProject = new Map();
  for (const chunk of chunks) {
    const payload = chunk.payload_json;
    for (const entry of payload.groups ?? []) {
      if (!entry.key?.projectId) continue;
      const pid = entry.key.projectId;
      let project = byProject.get(pid);
      if (!project) {
        project = { projectId: pid, totalCostUsd: 0, metricsMap: new Map() };
        byProject.set(pid, project);
      }
      project.totalCostUsd += entry.totalCostUsd;
      for (const metric of entry.metrics ?? []) {
        const existing = project.metricsMap.get(metric.id);
        if (existing) existing.costUsd += metric.costUsd;
        else project.metricsMap.set(metric.id, { ...metric });
      }
    }
  }
  const result = new Map();
  for (const [pid, p] of byProject) {
    result.set(pid, {
      projectId: p.projectId,
      totalCostUsd: p.totalCostUsd,
      metrics: Array.from(p.metricsMap.values()),
    });
  }
  return result;
}

// ── Paginated Enterprise API call ──────────────────────────────────────────
let pauseUntil = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiFetch(path, params = {}) {
  const now = Date.now();
  if (pauseUntil > now) await sleep(pauseUntil - now);

  const url = new URL("https://api.replit.com/v1" + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });

    const remaining = Number(res.headers.get("X-RateLimit-Remaining") ?? "20");
    if (remaining <= 3) {
      const reset = Number(res.headers.get("X-RateLimit-Reset") ?? "10");
      const delay = reset > 1_000_000_000 ? reset * 1000 - Date.now() : reset * 1000;
      pauseUntil = Date.now() + Math.max(2000, delay);
    }

    if (res.status === 429) {
      const after = Number(res.headers.get("Retry-After") ?? "10");
      console.warn(`  429 — retrying after ${after}s`);
      await sleep(after * 1000);
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`API ${path} returned HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    return res.json();
  }
  throw new Error(`API ${path} failed after 5 retries`);
}

async function paginateApi(path, params = {}) {
  const out = [];
  let cursor;
  for (let page = 0; page < 200; page++) {
    const body = await apiFetch(path, { ...params, limit: "100", cursor });
    await sleep(700);
    out.push(...(body.data ?? []));
    if (!body.pagination?.hasMore || !body.pagination?.cursor) break;
    cursor = body.pagination.cursor;
  }
  return out;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  // 1. Load directory from DB ────────────────────────────────────────────────
  console.log("Reading directory cache from DB...");
  const dirRows = await dbQuery(
    "SELECT directory_json FROM api_directory_cache WHERE id = 'singleton' LIMIT 1",
  );
  if (!dirRows.length) {
    throw new Error(
      "No directory cache found. Start the API server and wait for it to warm up first.",
    );
  }

  const dir = dirRows[0].directory_json;
  const workspaces = new Map(Object.entries(dir.workspaces ?? {}));
  const customGroups = (dir.allGroups ?? dir.groups ?? []).filter(
    (g) => !["admin", "member", "guest"].includes((g.type ?? "").toLowerCase()),
  );
  const membersById = new Map(Object.entries(dir.members ?? {}));
  const emailByUsername = new Map();
  for (const [, m] of membersById) {
    if (m.username && m.email) emailByUsername.set(m.username.toLowerCase(), m.email);
  }
  const groupById = new Map(customGroups.map((g) => [g.id, g]));
  console.log(`  ${workspaces.size} workspaces, ${customGroups.length} custom groups`);

  // 2. Load project-usage chunks from DB ─────────────────────────────────────
  console.log("Reading group_project usage chunks from DB...");
  const chunks = await dbQuery(
    `SELECT scope_key, payload_json
     FROM usage_sync_chunks
     WHERE mode = 'group_project' AND range_key = 'billing:from-cutoff'
     ORDER BY scope_key, chunk_start`,
  );
  if (!chunks.length) {
    throw new Error(
      "No group_project usage chunks found for billing:from-cutoff. " +
        "Start the API server and wait for it to warm up then retry.",
    );
  }
  const chunksByGroup = new Map();
  for (const chunk of chunks) {
    const list = chunksByGroup.get(chunk.scope_key) ?? [];
    list.push(chunk);
    chunksByGroup.set(chunk.scope_key, list);
  }
  console.log(`  ${chunks.length} chunks across ${chunksByGroup.size} groups`);

  // 3. Aggregate projects across all groups ──────────────────────────────────
  // projectId → { entry, workspaceNames: Set<string> }
  const projectMap = new Map();
  for (const [groupId, groupChunks] of chunksByGroup) {
    const group = groupById.get(groupId);
    const groupName = group?.name ?? groupId;
    const workspaceId = group?.workspaceId ?? "";
    const wsName = workspaces.get(workspaceId)?.name ?? workspaceId;

    for (const entry of aggregateProjectUsage(groupChunks).values()) {
      const existing = projectMap.get(entry.projectId);
      if (!existing) {
        projectMap.set(entry.projectId, {
          entry,
          workspaceId,
          workspaceNames: new Set(wsName ? [wsName] : []),
        });
      } else {
        if (wsName) existing.workspaceNames.add(wsName);
        if (entry.totalCostUsd > existing.entry.totalCostUsd) {
          existing.entry = entry;
          existing.workspaceId = workspaceId;
        }
      }
    }
  }
  console.log(`Total unique projects: ${projectMap.size}`);

  // 4. Fetch project titles for all workspaces ───────────────────────────────
  // projectId → { title, creatorId, creatorUsername }
  const globalProjectInfo = new Map();

  console.log(`\nFetching project titles for ${workspaces.size} workspaces...`);
  const workspaceErrors = [];
  for (const [wsId, ws] of workspaces) {
    try {
      const projects = await paginateApi("/projects", { workspaceId: wsId });
      for (const p of projects) {
        const current = globalProjectInfo.get(p.id);
        // Prefer entries that have a title; don't overwrite a title with blank
        if (!current || (!current.title && p.title)) {
          globalProjectInfo.set(p.id, {
            title: p.title ?? null,
            creatorId: p.creatorId ?? null,
            creatorUsername: p.creatorUsername ?? null,
          });
        }
      }
      console.log(`  ${ws.name}: ${projects.length} projects`);
    } catch (err) {
      // Record but do not swallow — emit after loop so caller sees the full picture
      workspaceErrors.push({ workspace: ws.name, error: err.message });
      console.error(`  ERROR fetching projects for ${ws.name}: ${err.message}`);
    }
  }

  if (workspaceErrors.length > 0) {
    // At least one workspace failed. Fail the refresh rather than silently
    // writing a CSV with blank titles that looks like good data.
    throw new Error(
      `Project title fetch failed for ${workspaceErrors.length} workspace(s): ` +
        workspaceErrors.map((e) => `${e.workspace} — ${e.error}`).join("; "),
    );
  }
  console.log(`  Global project info: ${globalProjectInfo.size} entries`);

  // 5. Build output rows ─────────────────────────────────────────────────────
  const rows = [];
  for (const { entry, workspaceNames } of projectMap.values()) {
    const info = globalProjectInfo.get(entry.projectId);
    const ownerUsername = info?.creatorUsername ?? "";
    const ownerId = info?.creatorId ?? null;
    const member = ownerId ? membersById.get(ownerId) : undefined;
    const ownerName = member?.name ?? "";
    const ownerEmail =
      member?.email ??
      (ownerUsername ? emailByUsername.get(ownerUsername.toLowerCase()) : undefined) ??
      "";
    const resolvedUsername = ownerUsername || member?.username || "";

    const aiUsd = entry.metrics
      .filter((m) => m.category === "ai")
      .reduce((s, m) => s + m.costUsd, 0);
    const hostingUsd = entry.metrics
      .filter((m) => m.category === "hosting")
      .reduce((s, m) => s + m.costUsd, 0);
    const storageUsd = entry.metrics
      .filter((m) => m.category === "storage")
      .reduce((s, m) => s + m.costUsd, 0);
    const otherUsd = entry.metrics
      .filter((m) => !["ai", "hosting", "storage"].includes(m.category))
      .reduce((s, m) => s + m.costUsd, 0);

    rows.push({
      projectId: entry.projectId,
      projectName: info?.title ?? "",
      owner: ownerName,
      ownerUsername: resolvedUsername,
      ownerEmail,
      workspaces: Array.from(workspaceNames).sort().join("; "),
      aiAgent: aiUsd,
      aiOther: 0,
      hostingStorageTraffic: hostingUsd + storageUsd + otherUsd,
      totalSpend: entry.totalCostUsd,
    });
  }

  rows.sort((a, b) => b.totalSpend - a.totalSpend);

  // 6. Write CSV ─────────────────────────────────────────────────────────────
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const fmt = (n) => n.toFixed(2);

  const header = [
    "Project ID",
    "Project Name",
    "Owner",
    "Owner Username",
    "Owner Email",
    "Workspace(s)",
    "Spend – AI Agent",
    "Spend – AI Other",
    "Spend – Hosting/Storage/Traffic",
    "Total Spend (USD)",
    "Notes",
  ];

  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        esc(r.projectId),
        esc(r.projectName),
        esc(r.owner),
        esc(r.ownerUsername),
        esc(r.ownerEmail),
        esc(r.workspaces),
        fmt(r.aiAgent),
        fmt(r.aiOther),
        fmt(r.hostingStorageTraffic),
        fmt(r.totalSpend),
        "", // Notes — left blank per spec
      ].join(","),
    );
  }

  writeFileSync(OUT_PATH, lines.join("\n"), "utf8");

  const withTitle = rows.filter((r) => r.projectName).length;
  const withOwner = rows.filter((r) => r.owner).length;
  console.log(`\nWrote ${rows.length} rows → ${OUT_PATH}`);
  console.log(`  ${withTitle}/${rows.length} rows have project titles`);
  console.log(`  ${withOwner}/${rows.length} rows have owner names`);

  await pool.end();
}

main().catch(async (err) => {
  console.error("\nFatal error:", err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
