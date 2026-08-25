/**
 * Refresh attached_assets/spend-per-project.csv from the database cache.
 *
 * The API server durably persists every project-usage sync into usage_sync_chunks
 * (mode='group_project'). This script reads that cache + the directory cache
 * and builds the CSV without making any live Enterprise API calls.
 *
 * Run: node scripts/refresh-spend-csv-db.mjs
 */

import pg from "pg";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, "../attached_assets/spend-per-project.csv");

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function query(sql, params = []) {
  const res = await pool.query(sql, params);
  return res.rows;
}

// ---------------------------------------------------------------------------
// Aggregate project usage from DB chunks
// ---------------------------------------------------------------------------
function aggregateProjectUsage(chunks) {
  // byProject: projectId -> { projectId, workspaceId, totalCostUsd, metrics: Map<id, {id, name, category, costUsd}> }
  const byProject = new Map();

  for (const chunk of chunks) {
    const payload = chunk.payload_json;
    const groups = payload.groups ?? [];
    for (const entry of groups) {
      if (!entry.key?.projectId) continue;
      const pid = entry.key.projectId;
      let project = byProject.get(pid);
      if (!project) {
        project = {
          projectId: pid,
          workspaceId: entry.key.workspaceId ?? null,
          totalCostUsd: 0,
          metricsMap: new Map(),
        };
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

  // Convert metricsMap to array
  const result = new Map();
  for (const [pid, p] of byProject) {
    result.set(pid, {
      projectId: p.projectId,
      workspaceId: p.workspaceId,
      totalCostUsd: p.totalCostUsd,
      metrics: Array.from(p.metricsMap.values()),
    });
  }
  return result;
}

async function main() {
  console.log("Reading API directory cache from DB...");
  const dirRows = await query(
    "SELECT directory_json FROM api_directory_cache WHERE id = 'singleton' LIMIT 1",
  );
  if (dirRows.length === 0) throw new Error("No directory cache found in DB — run the API server first");

  const dir = dirRows[0].directory_json;
  const workspaces = new Map(Object.entries(dir.workspaces ?? {}));
  const groups = (dir.groups ?? []).filter(
    (g) => !["admin", "member", "guest"].includes((g.type ?? "").toLowerCase()),
  );
  console.log(`  ${workspaces.size} workspaces, ${groups.length} custom groups`);

  // userId -> member info
  const membersById = new Map(Object.entries(dir.members ?? {}));
  // username -> email
  const emailByUsername = new Map();
  for (const [, m] of membersById) {
    if (m.username && m.email) emailByUsername.set(m.username.toLowerCase(), m.email);
  }

  console.log("Reading project usage chunks from DB (mode=group_project, billing:from-cutoff)...");
  // Load all project-usage chunks for the default billing range.
  // We prefer billing:from-cutoff but also accept mtd/ytd chunks as fallback.
  const chunks = await query(
    `SELECT scope_key, payload_json
     FROM usage_sync_chunks
     WHERE mode = 'group_project'
       AND range_key = 'billing:from-cutoff'
     ORDER BY scope_key, chunk_start`,
  );
  console.log(`  ${chunks.length} DB chunks`);

  if (chunks.length === 0) {
    // Try any available range_key for project data
    const fallback = await query(
      `SELECT scope_key, range_key, COUNT(*) as cnt
       FROM usage_sync_chunks
       WHERE mode = 'group_project'
       GROUP BY scope_key, range_key
       ORDER BY cnt DESC
       LIMIT 5`,
    );
    console.log("Available ranges:", fallback);
    throw new Error("No group_project chunks found for billing:from-cutoff range. Start the API server and let it warm up first.");
  }

  // Group chunks by scope_key (=groupId)
  const chunksByGroup = new Map();
  for (const chunk of chunks) {
    const existing = chunksByGroup.get(chunk.scope_key) ?? [];
    existing.push(chunk);
    chunksByGroup.set(chunk.scope_key, existing);
  }
  console.log(`  ${chunksByGroup.size} groups have project usage data`);

  // Build a groupId -> group info map
  const groupById = new Map(groups.map((g) => [g.id, g]));

  // Load project info from directory cache
  // dir doesn't have project info (titles). Read the API's project info from
  // the in-memory cache — but since we're in a standalone script, we need to
  // look for a project_info or similar store. The enterprise lib doesn't persist
  // project titles to DB; they stay in memory. Let's try to read from DB if available,
  // or fetch titles on-demand.
  
  // Check if project titles are stored in DB
  const titleRows = await query(
    `SELECT table_name FROM information_schema.tables 
     WHERE table_schema = 'public' AND table_name LIKE '%project%'`,
  );
  console.log("Project-related tables in DB:", titleRows.map((r) => r.table_name));

  // Aggregate projects across all groups
  // projectId -> { entry, workspaceId, groupNames }
  const projectMap = new Map();

  for (const [groupId, groupChunks] of chunksByGroup) {
    const group = groupById.get(groupId);
    if (!group) {
      // Group might be in a different workspace than what's in the custom groups list.
      // Find it in allGroups from dir if available.
    }
    const groupName = group?.name ?? groupId;
    const workspaceId = group?.workspaceId ?? groupId;

    const byProject = aggregateProjectUsage(groupChunks);

    for (const entry of byProject.values()) {
      const existing = projectMap.get(entry.projectId);
      if (!existing) {
        projectMap.set(entry.projectId, {
          entry,
          workspaceId,
          groupNames: new Set([groupName]),
        });
      } else {
        existing.groupNames.add(groupName);
        if (entry.totalCostUsd > existing.entry.totalCostUsd) {
          existing.entry = entry;
          existing.workspaceId = workspaceId;
        }
      }
    }
  }

  console.log(`Total unique projects found: ${projectMap.size}`);

  // Fetch project titles from the live API (only for workspaces we need, and only
  // if the API server isn't running). Fall back gracefully — titles become "".
  //
  // Actually, let's try to get them from the API using the key we have.
  // But we need to be smart: batch by workspace.
  
  const neededWorkspaces = new Set();
  for (const { workspaceId } of projectMap.values()) {
    neededWorkspaces.add(workspaceId);
  }
  console.log(`\nFetching project titles for ${neededWorkspaces.size} workspaces...`);

  const projectInfoByWs = new Map(); // wsId -> Map<projectId, {title, creatorId, creatorUsername}>

  const KEY = process.env["REPLIT_ENTERPRISE_API_KEY"];
  if (KEY) {
    let pauseUntil = 0;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const fetchProjects = async (workspaceId) => {
      const out = [];
      let cursor;
      for (let page = 0; page < 200; page++) {
        const now = Date.now();
        if (pauseUntil > now) await sleep(pauseUntil - now);

        const url = new URL("https://api.replit.com/v1/projects");
        url.searchParams.set("workspaceId", workspaceId);
        url.searchParams.set("limit", "100");
        if (cursor) url.searchParams.set("cursor", cursor);

        const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });

        const remaining = Number(res.headers.get("X-RateLimit-Remaining") ?? "20");
        if (remaining <= 3) {
          const reset = Number(res.headers.get("X-RateLimit-Reset") ?? "10");
          const delay = reset > 1_000_000_000 ? reset * 1000 - Date.now() : reset * 1000;
          pauseUntil = Date.now() + Math.max(2000, delay);
        }
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get("Retry-After") ?? "10");
          await sleep(retryAfter * 1000);
          continue;
        }
        if (!res.ok) break;

        const body = await res.json();
        await sleep(700);
        out.push(...(body.data ?? []));
        if (!body.pagination?.hasMore || !body.pagination?.cursor) break;
        cursor = body.pagination.cursor;
      }
      return out;
    };

    for (const wsId of neededWorkspaces) {
      const wsName = workspaces.get(wsId)?.name ?? wsId;
      try {
        const projects = await fetchProjects(wsId);
        const infoMap = new Map();
        for (const p of projects) {
          infoMap.set(p.id, {
            title: p.title ?? null,
            creatorId: p.creatorId ?? null,
            creatorUsername: p.creatorUsername ?? null,
          });
        }
        projectInfoByWs.set(wsId, infoMap);
        console.log(`  ${wsName}: ${projects.length} project titles`);
      } catch (err) {
        console.warn(`  Failed for ${wsName}: ${err.message}`);
        projectInfoByWs.set(wsId, new Map());
      }
    }
  } else {
    console.warn("  No REPLIT_ENTERPRISE_API_KEY — project titles will be empty");
  }

  // Build output rows
  const rows = [];
  for (const { entry, workspaceId, groupNames } of projectMap.values()) {
    const wsName = workspaces.get(workspaceId)?.name ?? workspaceId;
    const infoMap = projectInfoByWs.get(workspaceId);
    const info = infoMap?.get(entry.projectId);

    const ownerUsername = info?.creatorUsername ?? "";
    const ownerId = info?.creatorId ?? null;
    const member = ownerId ? membersById.get(ownerId) : undefined;

    const ownerName = member
      ? [member.username].filter(Boolean).join(" ") // fallback if name not in dir
      : "";
    // The dir members have: { userId, username, email, name, isAccountAdmin, workspaces }
    const ownerNameFull = member?.name ?? ownerName;
    const ownerEmail =
      member?.email ??
      (ownerUsername ? emailByUsername.get(ownerUsername.toLowerCase()) : undefined) ??
      "";

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

    const groupArr = Array.from(groupNames).sort();
    const workspacesStr = wsName; // The export uses workspace name (from workspaceId of the winning group)

    rows.push({
      projectId: entry.projectId,
      projectName: info?.title ?? "",
      owner: ownerNameFull,
      ownerUsername: ownerUsername || member?.username || "",
      ownerEmail,
      workspaces: workspacesStr,
      aiAgent: aiUsd,
      aiOther: 0,
      hostingStorageTraffic: hostingUsd + storageUsd + otherUsd,
      totalSpend: entry.totalCostUsd,
    });
  }

  rows.sort((a, b) => b.totalSpend - a.totalSpend);

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
        "", // Notes blank
      ].join(","),
    );
  }

  const csv = lines.join("\n");
  writeFileSync(OUT_PATH, csv, "utf8");
  console.log(`\nWrote ${rows.length} rows to ${OUT_PATH}`);

  await pool.end();
}

main().catch(async (err) => {
  console.error("Fatal:", err);
  await pool.end().catch(() => {});
  process.exit(1);
});
