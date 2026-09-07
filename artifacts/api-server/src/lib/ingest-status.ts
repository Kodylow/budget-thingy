export type IngestRunRow = {
  id: unknown;
  kind: unknown;
  started_at: unknown;
  finished_at: unknown;
  units: unknown;
  calls: unknown;
  failures: unknown;
  error: unknown;
  remaining: unknown;
};

export function durableFailedUnitKeys(error: unknown): string[] {
  if (typeof error !== "string" || !error.startsWith("failed-units:")) return [];
  return error.slice("failed-units:".length).split("\n").map((key) => key.trim()).filter(Boolean);
}

/**
 * Keeps the public run contract stable while ensuring a bounded run with some
 * failed units is not mislabeled as wholly failed merely because its durable
 * retry ledger occupies the error column.
 */
export function presentUsageIngestRun(row: IngestRunRow) {
  const units = Number(row.units);
  const failures = Number(row.failures);
  const remaining = row.remaining == null ? null : Number(row.remaining);
  const finishedAt = row.finished_at ? new Date(row.finished_at as string | Date).toISOString() : null;
  const status = !finishedAt
    ? "running"
    : failures > 0 && row.error != null
      ? units > failures ? "partial" : "failed"
      : (remaining ?? 0) > 0 ? "partial" : "succeeded";
  return {
    id: Number(row.id),
    kind: String(row.kind),
    startedAt: new Date(row.started_at as string | Date).toISOString(),
    finishedAt,
    units,
    calls: Number(row.calls),
    failures,
    error: row.error == null ? null : String(row.error),
    remaining,
    status,
  };
}