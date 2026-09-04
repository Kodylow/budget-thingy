import { db, sessionsTable } from "@workspace/db";
import { desc, gt } from "drizzle-orm";

const sampleCount = 20;
const warmupCount = 2;
const benchmarkPort = process.env.BENCHMARK_PORT ?? process.env.PORT ?? "8080";

function resolveBaseUrl(): string {
  const parsed = new URL(
    process.env.BENCHMARK_BASE_URL ?? `http://127.0.0.1:${benchmarkPort}/api`,
  );
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (
    parsed.protocol !== "http:" ||
    !loopbackHosts.has(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname.replace(/\/+$/, "") !== "/api"
  ) {
    throw new Error(
      "BENCHMARK_BASE_URL must be an http loopback URL with the /api path.",
    );
  }
  return parsed.toString().replace(/\/+$/, "");
}

const baseUrl = resolveBaseUrl();

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.ceil(sorted.length * fraction) - 1]!;
}

async function timedRequest(path: string, sid: string): Promise<number> {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${sid}` },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${body.slice(0, 200)}`);
  }
  return performance.now() - startedAt;
}

async function benchmark(path: string, sid: string) {
  for (let index = 0; index < warmupCount; index += 1) {
    await timedRequest(path, sid);
  }
  const timings: number[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    timings.push(await timedRequest(path, sid));
  }
  const sorted = [...timings].sort((a, b) => a - b);
  return {
    path,
    sampleCount,
    p50Ms: Number(percentile(sorted, 0.5).toFixed(1)),
    p95Ms: Number(percentile(sorted, 0.95).toFixed(1)),
    minMs: Number(sorted[0]!.toFixed(1)),
    maxMs: Number(sorted.at(-1)!.toFixed(1)),
  };
}

async function selectRepresentativeGroup(
  groups: Array<{ groupId: string; isSynthetic?: boolean; memberCount?: number }>,
  sid: string,
): Promise<{ groupId: string }> {
  const candidates = groups
    .filter((candidate) => !candidate.isSynthetic)
    .sort((a, b) => (b.memberCount ?? 0) - (a.memberCount ?? 0));
  for (const candidate of candidates) {
    const path = `/groups/${encodeURIComponent(candidate.groupId)}?rangeType=full-term`;
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${sid}` },
    });
    await response.arrayBuffer();
    if (response.ok) return candidate;
  }
  throw new Error("No accessible real group has a readable full-term detail snapshot.");
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("The warm benchmark may only run against a development environment.");
  }
  const [session] = await db
    .select({ sid: sessionsTable.sid })
    .from(sessionsTable)
    .where(gt(sessionsTable.expire, new Date()))
    .orderBy(desc(sessionsTable.expire))
    .limit(1);
  if (!session) {
    throw new Error("No unexpired development session found. Sign in to the app first.");
  }

  const groupsResponse = await fetch(`${baseUrl}/groups?rangeType=full-term`, {
    headers: { Authorization: `Bearer ${session.sid}` },
  });
  if (!groupsResponse.ok) {
    throw new Error(`Unable to select a benchmark group (${groupsResponse.status}).`);
  }
  const groupsPayload = await groupsResponse.json() as {
    groups?: Array<{ groupId: string; isSynthetic?: boolean; memberCount?: number }>;
  };
  if (!groupsPayload.groups?.length) {
    throw new Error("The authenticated groups response has no accessible real group.");
  }
  const group = await selectRepresentativeGroup(groupsPayload.groups, session.sid);

  const results = [];
  results.push(await benchmark("/groups?rangeType=full-term", session.sid));
  results.push(await benchmark("/summary?rangeType=billing", session.sid));
  results.push(await benchmark(
    `/groups/${encodeURIComponent(group.groupId)}?rangeType=full-term`,
    session.sid,
  ));
  console.log(JSON.stringify({
    measuredAt: new Date().toISOString(),
    environment: "Replit development workflow, authenticated durable warm store",
    baseUrl,
    warmupRequestsPerEndpoint: warmupCount,
    sequentialRequestsPerEndpoint: sampleCount,
    representativeGroupId: group.groupId,
    results,
  }, null, 2));
}

await main();