/**
 * Fetch raw export CSV and show column sums + first few rows.
 * Run: node --import tsx ./check-export.mjs
 */
import crypto from "node:crypto";
import { db, apiDirectoryCacheTable, sessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const API_PORT = process.env.PORT ?? 8080;

// Find account admin
const [dirRow] = await db.select().from(apiDirectoryCacheTable).limit(1);
const dir = dirRow.directoryJson;
const admin = Object.values(dir.members).find((m) => m.isAccountAdmin === true);

const sid = crypto.randomBytes(32).toString("hex");
await db.insert(sessionsTable).values({
  sid,
  sess: { user: { id: admin.userId, username: admin.username, email: admin.email } },
  expire: new Date(Date.now() + 60 * 60 * 1000),
});

let raw;
try {
  const resp = await fetch(`http://localhost:${API_PORT}/api/projects/export`, {
    headers: { cookie: `sid=${sid}` },
  });
  raw = await resp.text();
} finally {
  await db.delete(sessionsTable).where(eq(sessionsTable.sid, sid));
}

const lines = raw.split(/\r?\n/).filter(Boolean);
const headers = lines[0].split(",").map((h) => h.replace(/"/g, "").trim());
console.log("Headers:", headers);

// Parse rows
function parseLine(line) {
  const fields = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i+1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { fields.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

const rows = lines.slice(1).map((l) => {
  const f = parseLine(l);
  const obj = {};
  headers.forEach((h, i) => obj[h] = f[i] ?? "");
  return obj;
});

// Sum numeric columns
const sums = {};
for (const h of headers) sums[h] = 0;
for (const r of rows) {
  for (const h of headers) {
    const v = parseFloat(r[h]);
    if (!isNaN(v)) sums[h] = (sums[h] || 0) + v;
  }
}

console.log("\nColumn sums:");
for (const h of headers) {
  if (typeof sums[h] === "number" && sums[h] !== 0) {
    console.log(` ${h}: ${sums[h].toFixed(2)}`);
  }
}
console.log("\nSample rows (first 3):");
for (const r of rows.slice(0, 3)) console.log(JSON.stringify(r));

// Find LocalSERPAnalyzer
const serp = rows.find(r => r["Project Title"]?.includes("LocalSERP") || r["Project ID"] === "1b17c77f-9907-443f-b6bc-7d9d590ef99f");
if (serp) console.log("\nLocalSERPAnalyzer raw row:", JSON.stringify(serp));

process.exit(0);
