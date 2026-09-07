const DAY_MS = 86_400_000;

export type ProjectionReason =
  | "historical_reporting_period"
  | "invalid_planning_end"
  | "unverified_cycle_end"
  | "insufficient_rate_history"
  | "incomplete_baseline";

export interface ProjectionDay {
  day: string;
  spendUsd: number;
  complete: boolean;
}

export interface ProjectionBudget {
  amountUsd: number;
  kind: "canonical_allocation" | "personal_agent_limit";
  label: string;
}

export interface ProjectionInput {
  now: Date;
  actualPeriod: { start: string; endExclusive: string };
  target: {
    kind: "month_end" | "year_end" | "term_end" | "cycle_end" | "planning_end";
    start: string;
    endExclusive: string | null;
    verified: boolean;
  };
  days: readonly ProjectionDay[];
  budget: ProjectionBudget | null;
  stale: boolean;
  initialReasons?: readonly ProjectionReason[];
}

function dayStart(value: Date | string): number {
  const date = typeof value === "string" ? new Date(value) : value;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function isoInstant(ms: number): string {
  return new Date(ms).toISOString();
}

function rounded(value: number): number {
  return Math.round((value + Number.EPSILON) * 1e8) / 1e8;
}

/**
 * A deterministic projection over already-authorized daily facts. Missing days
 * are never converted to zero; callers must provide genuine zero facts.
 */
export function buildDashboardProjection(input: ProjectionInput) {
  const today = dayStart(input.now);
  const yesterday = today - DAY_MS;
  const actualStart = Date.parse(input.actualPeriod.start);
  const actualEnd = Date.parse(input.actualPeriod.endExclusive);
  const targetStart = Date.parse(input.target.start);
  const targetEnd = input.target.endExclusive === null
    ? NaN
    : Date.parse(input.target.endExclusive);
  const reasons = new Set<ProjectionReason>(input.initialReasons ?? []);

  if (!(actualStart <= today && actualEnd > today)) {
    reasons.add("historical_reporting_period");
  }
  if (input.target.kind === "cycle_end" && !input.target.verified) {
    reasons.add("unverified_cycle_end");
  }
  if (!Number.isFinite(targetEnd) || targetEnd <= today ||
      targetEnd <= targetStart) {
    reasons.add("invalid_planning_end");
  }

  const historical = !(actualStart <= today && actualEnd > today);
  const byDay = new Map(input.days.map((item) => [item.day, item]));
  let dataThroughMs: number | null = null;
  const latestActualDay = Math.min(today, actualEnd - DAY_MS);
  for (const fact of input.days) {
    const factMs = Date.parse(`${fact.day}T00:00:00.000Z`);
    if (factMs >= actualStart && factMs <= latestActualDay &&
        (dataThroughMs === null || factMs > dataThroughMs)) {
      dataThroughMs = factMs;
    }
  }

  const rateDays: ProjectionDay[] = [];
  let rateThroughMs: number | null = null;
  for (let cursor = yesterday; cursor >= yesterday - 27 * DAY_MS; cursor -= DAY_MS) {
    if (byDay.get(isoDay(cursor))?.complete) {
      rateThroughMs = cursor;
      break;
    }
  }
  if (rateThroughMs !== null) {
    for (let cursor = rateThroughMs;
      rateDays.length < 28;
      cursor -= DAY_MS) {
      const fact = byDay.get(isoDay(cursor));
      if (!fact?.complete) break;
      rateDays.unshift(fact);
    }
  }
  if (rateDays.length < 7) reasons.add("insufficient_rate_history");
  const sumLast = (count: number) => {
    if (rateDays.length < count) return null;
    const sample = rateDays.slice(-count);
    return rounded(sample.reduce((sum, day) => sum + day.spendUsd, 0) / count);
  };
  const dailySpendUsd = rateDays.length >= 7
    ? rounded(rateDays.reduce((sum, day) => sum + day.spendUsd, 0) /
      rateDays.length)
    : null;

  // The cumulative baseline always belongs to the selected reporting period,
  // independently of the chosen forecast horizon. Partial facts contribute
  // their known charge, but an absent or partial day keeps it incomplete.
  const expectedPastEnd = historical
    ? actualEnd - DAY_MS
    : Math.min(yesterday, actualEnd - DAY_MS);
  const baselineEnd = Math.max(expectedPastEnd, dataThroughMs ?? -Infinity);
  let baselineSpendUsd = 0;
  let baselineComplete = Number.isFinite(actualStart) &&
    baselineEnd >= actualStart;
  if (baselineEnd >= actualStart) {
    for (let cursor = actualStart; cursor <= baselineEnd; cursor += DAY_MS) {
      const fact = byDay.get(isoDay(cursor));
      if (fact) baselineSpendUsd += fact.spendUsd;
      if (!fact?.complete) baselineComplete = false;
    }
  }
  baselineSpendUsd = rounded(baselineSpendUsd);
  if (!baselineComplete) reasons.add("incomplete_baseline");

  const blocking = reasons.size > 0;
  const forecastStart = dataThroughMs === null
    ? today
    : Math.max(today, dataThroughMs + DAY_MS);
  const remainingDays = Number.isFinite(targetEnd)
    ? Math.max(0, Math.round((targetEnd - forecastStart) / DAY_MS))
    : 0;
  const projectedTotalUsd = !blocking &&
      dailySpendUsd !== null
    ? rounded(baselineSpendUsd + dailySpendUsd * remainingDays)
    : null;
  const onlyIncompleteBaseline = reasons.size === 1 &&
    reasons.has("incomplete_baseline");
  const projectedKnownTotalUsd = onlyIncompleteBaseline &&
      dailySpendUsd !== null && Number.isFinite(targetEnd)
    ? rounded(baselineSpendUsd + dailySpendUsd * remainingDays)
    : null;
  const budget = input.budget;
  const projectedRemainingUsd = projectedTotalUsd !== null && budget
    ? rounded(budget.amountUsd - projectedTotalUsd)
    : null;
  const projectedOverageUsd = projectedRemainingUsd === null
    ? null
    : rounded(Math.max(0, -projectedRemainingUsd));
  const projectedUsePercent = projectedTotalUsd !== null && budget &&
      budget.amountUsd > 0
    ? rounded(projectedTotalUsd / budget.amountUsd * 100)
    : null;
  const stale = input.stale ||
    (dataThroughMs !== null && dataThroughMs < yesterday);
  const alreadyExceeded = budget !== null && baselineComplete &&
    baselineSpendUsd > budget.amountUsd;
  const status = alreadyExceeded
    ? "over" as const
    : stale
      ? "unavailable" as const
      : (budget !== null && budget.amountUsd <= 0 &&
          projectedTotalUsd !== null && projectedTotalUsd > 0)
      ? "over" as const
      : projectedUsePercent === null
        ? "unavailable" as const
        : projectedUsePercent > 100
          ? "over" as const
          : projectedUsePercent >= 90
        ? "near" as const
        : "within" as const;

  const sevenDay = sumLast(7);
  const twentyEightDay = sumLast(28);
  const trajectory: {
    date: string;
    actualCumulativeUsd: number | null;
    projectedCumulativeUsd: number | null;
    sevenDayScenarioUsd: number | null;
    twentyEightDayScenarioUsd: number | null;
  }[] = [];
  const chartEnd = historical ? actualEnd : targetEnd;
  if (Number.isFinite(actualStart) && Number.isFinite(chartEnd) &&
      chartEnd > actualStart) {
    const totalDays = Math.ceil((chartEnd - actualStart) / DAY_MS);
    const selected = new Set<number>([0, totalDays - 1]);
    const anchored = new Set<number>([0, totalDays - 1]);
    const addAnchor = (ms: number | null) => {
      if (ms === null) return;
      const index = Math.round((ms - actualStart) / DAY_MS);
      if (index >= 0 && index < totalDays) anchored.add(index);
    };
    addAnchor(dataThroughMs);
    addAnchor(actualEnd - DAY_MS);
    const earliestRecorded = input.days
      .filter((fact) => fact.spendUsd !== 0)
      .map((fact) => Date.parse(`${fact.day}T00:00:00.000Z`))
      .filter((ms) => ms >= actualStart && ms < chartEnd)
      .sort((a, b) => a - b)[0] ?? null;
    addAnchor(earliestRecorded);
    const regularLimit = Math.max(1, 400 - anchored.size);
    const stride = Math.max(1, Math.ceil(totalDays / regularLimit));
    for (let index = 0; index < totalDays; index += stride) {
      selected.add(index);
    }
    for (const index of anchored) selected.add(index);
    if (selected.size > 400) {
      for (const index of [...selected].sort((a, b) => a - b)) {
        if (selected.size <= 400) break;
        if (!anchored.has(index)) selected.delete(index);
      }
    }
    const selectedIndexes = [...selected].sort((a, b) => a - b);
    const observedFacts = input.days
      .filter((fact) => {
        const factMs = Date.parse(`${fact.day}T00:00:00.000Z`);
        return factMs >= actualStart && factMs < actualEnd &&
          factMs <= today;
      })
      .sort((a, b) => a.day.localeCompare(b.day));
    let actual = 0;
    let observedIndex = 0;
    for (const index of selectedIndexes) {
      const cursor = actualStart + index * DAY_MS;
      while (observedIndex < observedFacts.length &&
          Date.parse(`${observedFacts[observedIndex]!.day}T00:00:00.000Z`) <
            cursor + DAY_MS) {
        actual = rounded(actual + observedFacts[observedIndex]!.spendUsd);
        observedIndex += 1;
      }
      const forecastDaysThroughCursor = cursor < forecastStart
        ? 0
        : Math.round((cursor - forecastStart) / DAY_MS) + 1;
      const isActualDate = cursor < actualEnd && cursor <= today;
      trajectory.push({
        date: isoDay(cursor),
        actualCumulativeUsd: isActualDate ? actual : null,
        projectedCumulativeUsd: projectedTotalUsd !== null &&
            cursor >= forecastStart
          ? rounded(baselineSpendUsd + dailySpendUsd! * forecastDaysThroughCursor)
          : null,
        sevenDayScenarioUsd: projectedTotalUsd !== null && sevenDay !== null &&
            cursor >= forecastStart
          ? rounded(baselineSpendUsd + sevenDay * forecastDaysThroughCursor)
          : null,
        twentyEightDayScenarioUsd: projectedTotalUsd !== null &&
            twentyEightDay !== null && cursor >= forecastStart
          ? rounded(baselineSpendUsd + twentyEightDay * forecastDaysThroughCursor)
          : null,
      });
    }
  }

  return {
    actualPeriod: input.actualPeriod,
    target: input.target,
    dataThrough: dataThroughMs === null ? null : isoDay(dataThroughMs),
    rate: {
      dailySpendUsd,
      windowStart: rateDays.length ? `${rateDays[0]!.day}T00:00:00.000Z` : null,
      windowEndExclusive: rateDays.length
        ? isoInstant(Date.parse(`${rateDays.at(-1)!.day}T00:00:00.000Z`) + DAY_MS)
        : null,
      completeDays: rateDays.length,
      sevenDayDailySpendUsd: sevenDay,
      twentyEightDayDailySpendUsd: twentyEightDay,
    },
    baseline: {
      spendUsd: baselineSpendUsd,
      complete: baselineComplete,
    },
    budget,
    projectedTotalUsd,
    projectedKnownTotalUsd,
    projectedRemainingUsd,
    projectedOverageUsd,
    projectedUsePercent,
    status,
    stale,
    reasons: [...reasons],
    methodology:
      "Known cumulative spend starts at the selected reporting-period start. Forecast pace is the arithmetic mean of up to 28 consecutive complete UTC days (minimum 7), excluding today; missing past days are never estimated.",
    trajectory,
  };
}