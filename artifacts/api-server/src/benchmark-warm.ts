import { db, sessionsTable } from "@workspace/db";
import { desc, gt } from "drizzle-orm";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { spawn } from "node:child_process";

const sampleCount = 20;
const warmupCount = 2;
const concurrentCount = 8;
const benchmarkPort = process.env.BENCHMARK_PORT ?? "80";

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

interface RequestMeasurement {
  durationMs: number;
  decodedBodyBytes: number;
  contentLengthBytes: number | null;
  contentEncoding: string | null;
  serverTiming: string | null;
  cacheControl: string | null;
}

async function timedRequest(path: string, sid: string): Promise<RequestMeasurement> {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      Accept: path.includes(".csv") ? "text/csv" : "application/json",
      "Accept-Encoding": "gzip, br",
      Authorization: `Bearer ${sid}`,
    },
  });
  const body = await response.arrayBuffer();
  if (!response.ok) {
    throw new Error(
      `${path} returned ${response.status}: ${new TextDecoder().decode(body.slice(0, 200))}`,
    );
  }
  const contentLengthHeader = response.headers.get("content-length");
  const contentLength = contentLengthHeader === null
    ? Number.NaN
    : Number(contentLengthHeader);
  return {
    durationMs: performance.now() - startedAt,
    decodedBodyBytes: body.byteLength,
    contentLengthBytes: Number.isFinite(contentLength) ? contentLength : null,
    contentEncoding: response.headers.get("content-encoding"),
    serverTiming: response.headers.get("server-timing"),
    cacheControl: response.headers.get("cache-control"),
  };
}

function summarize(
  path: string,
  profile: string,
  measurements: RequestMeasurement[],
) {
  const timings = measurements.map(({ durationMs }) => durationMs);
  const sorted = [...timings].sort((a, b) => a - b);
  const decodedBodyBytes = measurements.map(({ decodedBodyBytes }) => decodedBodyBytes);
  const contentLengthBytes = measurements
    .map(({ contentLengthBytes }) => contentLengthBytes)
    .filter((value): value is number => value !== null);
  return {
    path,
    profile,
    requestCount: measurements.length,
    p50Ms: Number(percentile(sorted, 0.5).toFixed(1)),
    p95Ms: Number(percentile(sorted, 0.95).toFixed(1)),
    minMs: Number(sorted[0]!.toFixed(1)),
    maxMs: Number(sorted.at(-1)!.toFixed(1)),
    decodedBodyBytes: {
      min: Math.min(...decodedBodyBytes),
      max: Math.max(...decodedBodyBytes),
    },
    contentLengthBytes: contentLengthBytes.length > 0
      ? { min: Math.min(...contentLengthBytes), max: Math.max(...contentLengthBytes) }
      : null,
    contentEncodings: [...new Set(measurements.map(({ contentEncoding }) =>
      contentEncoding ?? "identity"))],
    serverTiming: [...new Set(measurements.flatMap(({ serverTiming }) =>
      serverTiming ? [serverTiming] : []))],
    cacheControls: [...new Set(measurements.map(({ cacheControl }) =>
      cacheControl ?? "missing"))],
  };
}

async function benchmark(path: string, sid: string) {
  const cold = [await timedRequest(path, sid)];
  for (let index = 0; index < warmupCount; index += 1) {
    await timedRequest(path, sid);
  }
  const warm: RequestMeasurement[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    warm.push(await timedRequest(path, sid));
  }
  const concurrent = await Promise.all(
    Array.from({ length: concurrentCount }, () => timedRequest(path, sid)),
  );
  return [
    summarize(path, "cold-first-request", cold),
    summarize(path, "warm-sequential", warm),
    summarize(path, `concurrent-${concurrentCount}`, concurrent),
  ];
}

async function runIngestionActive(
  paths: readonly string[],
  sid: string,
): Promise<ReturnType<typeof summarize>[]> {
  if (process.env["BENCHMARK_WITH_INGEST"] !== "1") return [];
  const child = spawn(
    "pnpm",
    ["--filter", "@workspace/api-server", "run", "ingest:once"],
    { stdio: "ignore", env: process.env },
  );
  const results: ReturnType<typeof summarize>[] = [];
  try {
    for (const path of paths) {
      const measurements = await Promise.all(
        Array.from({ length: concurrentCount }, () => timedRequest(path, sid)),
      );
      results.push(summarize(
        path,
        `ingestion-active-concurrent-${concurrentCount}`,
        measurements,
      ));
    }
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  return results;
}

async function selectRepresentativeGroup(
  groups: Array<{
    groupId: string;
    workspaceId?: string;
    isSynthetic?: boolean;
    memberCount?: number;
  }>,
  sid: string,
): Promise<{ groupId: string; workspaceId: string }> {
  const candidates = groups
    .filter((candidate): candidate is typeof candidate & { workspaceId: string } =>
      !candidate.isSynthetic && Boolean(candidate.workspaceId))
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

async function selectAuthorizedSession(): Promise<{
  sid: string;
  groups: Array<{
    groupId: string;
    workspaceId?: string;
    isSynthetic?: boolean;
    memberCount?: number;
  }>;
}> {
  const sessions = await db
    .select({ sid: sessionsTable.sid })
    .from(sessionsTable)
    .where(gt(sessionsTable.expire, new Date()))
    .orderBy(desc(sessionsTable.expire))
    .limit(50);

  for (const session of sessions) {
    const response = await fetch(`${baseUrl}/groups?rangeType=full-term`, {
      headers: { Authorization: `Bearer ${session.sid}` },
    });
    if (!response.ok) {
      await response.arrayBuffer();
      continue;
    }
    const payload = await response.json() as {
      groups?: Array<{
        groupId: string;
        workspaceId?: string;
        isSynthetic?: boolean;
        memberCount?: number;
      }>;
    };
    if (payload.groups?.length) {
      return { sid: session.sid, groups: payload.groups };
    }
  }

  throw new Error(
    "No unexpired development session can read an accessible real group. Sign in to the app first.",
  );
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("The warm benchmark may only run against a development environment.");
  }
  const session = await selectAuthorizedSession();
  const group = await selectRepresentativeGroup(session.groups, session.sid);

  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  eventLoopDelay.enable();
  const commonQuery = "rangeType=full-term&viewScope=all_authorized";
  const benchmarkPaths = [
    `/dashboard?${commonQuery}`,
    `/spend/pools?${commonQuery}`,
    `/spend/groups?${commonQuery}`,
    `/spend/people?${commonQuery}`,
    `/spend/projects?${commonQuery}`,
    `/spend/pools.csv?${commonQuery}`,
    `/spend/groups.csv?${commonQuery}`,
    `/spend/people.csv?${commonQuery}`,
    `/spend/projects.csv?${commonQuery}`,
    `/groups/${encodeURIComponent(group.groupId)}?rangeType=full-term`,
    `/groups/${encodeURIComponent(group.groupId)}?rangeType=billing`,
    `/groups/${encodeURIComponent(group.groupId)}/projects?rangeType=full-term`,
  ];
  const results = [];
  for (const path of benchmarkPaths) {
    results.push(...await benchmark(path, session.sid));
  }
  results.push(...await runIngestionActive(benchmarkPaths, session.sid));
  eventLoopDelay.disable();
  console.log(JSON.stringify({
    measuredAt: new Date().toISOString(),
    environment: "Replit development workflow, authenticated durable persisted store",
    baseUrl,
    warmupRequestsPerEndpoint: warmupCount,
    sequentialRequestsPerEndpoint: sampleCount,
    concurrentRequestsPerEndpoint: concurrentCount,
    ingestionActiveProfile:
      process.env["BENCHMARK_WITH_INGEST"] === "1" ? "enabled" : "disabled",
    representativeGroupId: group.groupId,
    representativeWorkspaceId: group.workspaceId,
    eventLoopDelayMs: {
      mean: Number((eventLoopDelay.mean / 1e6).toFixed(1)),
      p95: Number((eventLoopDelay.percentile(95) / 1e6).toFixed(1)),
      max: Number((eventLoopDelay.max / 1e6).toFixed(1)),
    },
    results,
  }, null, 2));
}

await main();