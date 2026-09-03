import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, recurringJobClaimsTable } from "@workspace/db";

const MIN_LEASE_MS = 5_000;
const MAX_LEASE_MS = 15 * 60_000;

function boundedLease(ms: number): number {
  if (!Number.isFinite(ms)) throw new Error("A finite job lease is required");
  return Math.max(MIN_LEASE_MS, Math.min(MAX_LEASE_MS, Math.floor(ms)));
}

export interface JobClaim {
  jobKey: string;
  ownerToken: string;
  cursor: string | null;
  leaseMs: number;
  signal?: AbortSignal;
}

/** Atomically elect one owner. Database time makes this safe across skewed replicas. */
export async function acquireJobClaim(
  jobKey: string,
  cadenceMs: number,
  requestedLeaseMs: number,
): Promise<JobClaim | null> {
  const ownerToken = randomUUID();
  const leaseMs = boundedLease(requestedLeaseMs);
  const cadence = Math.max(1_000, Math.floor(cadenceMs));
  const result = await db.execute(sql`
    insert into recurring_job_claims
      (job_key, owner_token, lease_expires_at, not_before, claimed_at, updated_at)
    values (
      ${jobKey}, ${ownerToken},
      now() + (${leaseMs}::text || ' milliseconds')::interval,
      now() + (${cadence}::text || ' milliseconds')::interval,
      now(), now()
    )
    on conflict (job_key) do update set
      owner_token = excluded.owner_token,
      lease_expires_at = excluded.lease_expires_at,
      not_before = excluded.not_before,
      claimed_at = now(),
      updated_at = now()
    where (
      recurring_job_claims.owner_token is not null
      and recurring_job_claims.lease_expires_at <= now()
    )
      or (
        recurring_job_claims.owner_token is null
        and recurring_job_claims.not_before <= now()
      )
    returning cursor
  `);
  const row = result.rows[0] as { cursor?: string | null } | undefined;
  return row ? { jobKey, ownerToken, cursor: row.cursor ?? null, leaseMs } : null;
}

export async function renewJobClaim(claim: JobClaim): Promise<boolean> {
  const [row] = await db.update(recurringJobClaimsTable).set({
    leaseExpiresAt: sql`now() + (${boundedLease(claim.leaseMs)}::text || ' milliseconds')::interval`,
    updatedAt: sql`now()`,
  }).where(and(
    eq(recurringJobClaimsTable.jobKey, claim.jobKey),
    eq(recurringJobClaimsTable.ownerToken, claim.ownerToken),
    sql`${recurringJobClaimsTable.leaseExpiresAt} > now()`,
  )).returning({ jobKey: recurringJobClaimsTable.jobKey });
  return !!row;
}

export async function updateJobClaimCursor(
  claim: JobClaim,
  cursor: string | null,
): Promise<boolean> {
  const [row] = await db.update(recurringJobClaimsTable).set({
    cursor,
    updatedAt: sql`now()`,
  }).where(and(
    eq(recurringJobClaimsTable.jobKey, claim.jobKey),
    eq(recurringJobClaimsTable.ownerToken, claim.ownerToken),
    sql`${recurringJobClaimsTable.leaseExpiresAt} > now()`,
  )).returning({ jobKey: recurringJobClaimsTable.jobKey });
  return !!row;
}

export async function releaseJobClaim(claim: JobClaim): Promise<void> {
  await db.update(recurringJobClaimsTable).set({
    ownerToken: null,
    leaseExpiresAt: sql`now()`,
    updatedAt: sql`now()`,
  }).where(and(
    eq(recurringJobClaimsTable.jobKey, claim.jobKey),
    eq(recurringJobClaimsTable.ownerToken, claim.ownerToken),
  ));
}

/**
 * Keep ownership alive while work executes. No work runs in a transaction:
 * heartbeat and release are independent short statements.
 */
export async function withJobClaim<T>(
  jobKey: string,
  cadenceMs: number,
  leaseMs: number,
  work: (claim: JobClaim) => Promise<T>,
): Promise<{ acquired: false } | { acquired: true; value: T }> {
  const claim = await acquireJobClaim(jobKey, cadenceMs, leaseMs);
  if (!claim) return { acquired: false };
  const controller = new AbortController();
  const activeClaim: JobClaim = { ...claim, signal: controller.signal };
  let renewalInFlight = false;
  const timer = setInterval(
    () => {
      if (renewalInFlight || controller.signal.aborted) return;
      renewalInFlight = true;
      void renewJobClaim(activeClaim)
        .then((renewed) => {
          if (!renewed) controller.abort(new Error(`Lost recurring job claim: ${jobKey}`));
        })
        .catch((err) => controller.abort(err))
        .finally(() => {
          renewalInFlight = false;
        });
    },
    Math.max(1_000, claim.leaseMs / 3),
  );
  timer.unref();
  try {
    controller.signal.throwIfAborted();
    const value = await work(activeClaim);
    controller.signal.throwIfAborted();
    return { acquired: true, value };
  } finally {
    clearInterval(timer);
    await releaseJobClaim(activeClaim);
  }
}