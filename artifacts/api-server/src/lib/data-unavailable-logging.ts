import type { NextFunction, Request, Response } from "express";

export const DATA_UNAVAILABLE_REASONS = [
  "no_usage_observed",
  "incomplete_usage",
  "incomplete_scope",
  "limit_observation_failed",
  "limit_observation_unavailable",
  "limit_observation_refreshing",
  "missing_allocation",
  "period_mismatch",
  "explicit_unavailable",
  "missing_value",
  "authorization_unavailable",
  "scan_truncated",
  "instrumentation_failed",
] as const;

export type DataUnavailableReason = (typeof DATA_UNAVAILABLE_REASONS)[number];
export type DataUnavailableSite = {
  path: string;
  reason: DataUnavailableReason;
  count: number;
};
export type DataUnavailableDiagnostic = {
  count: number;
  sites: DataUnavailableSite[];
  truncated: boolean;
};

const MAX_NODES = 10_000;
const MAX_DEPTH = 14;
const MAX_SITES = 128;
const MAX_SCAN_MS = 10;
const MAX_TEXT_CHARS = 256_000;
const HEADER_MAX_BYTES = 3_500;

// Only names authored in API contracts may enter logs. Everything else (including
// map keys, IDs, emails, and provider error keys) is deliberately collapsed.
const SAFE_FIELDS = new Set([
  "body", "error", "message", "qualification", "qualifications", "status", "data_status",
  "limit_observation_status", "availability_status", "usage_status",
  "scope_status", "period_status", "authorization_status", "reason",
  "data", "result", "results", "items", "rows", "groups", "teams", "members",
  "users", "children", "summary", "totals", "billing", "billing_cycle",
  "current_cycle", "currentCycle", "limits", "limit", "monthly_agent_limit",
  "metadata", "accounting", "facets", "points", "history", "period", "scope",
  "personal_agent_limit", "personal_limit", "allocation", "canonical_allocation",
  "allocation_remaining", "allocation_or_limit_usd", "spend", "agent_spend",
  "agent_spend_usd", "your_agent_spend", "eligible_spend", "remaining",
  "agent_limit_remaining", "current_cycle_agent_spend_usd",
  "current_cycle_remaining_usd", "current_cycle_percent_used", "percent",
  "percent_used", "usage", "personal_usage", "current_cycle_usage",
  "currentCycleUsage", "amount", "value", "denominator", "observed",
  "complete", "scope_complete", "usage_complete", "period_matches",
  "no_limit", "not_applicable", "loading",
  "spendUsd", "agentSpendUsd", "otherServicesUsd", "allocationUsd",
  "remainingUsd", "percentUsed", "currentMonthSpendUsd", "currentCycleSpendUsd",
  "currentCycleRemainingUsd", "currentCyclePercentUsed", "usageObserved",
  "usageComplete", "scopeComplete", "periodMatches", "noLimit",
  "limitState", "limitObservationStatus", "availability",
  "accountReconciliationSpendUsd", "accountSpendUsd", "agentPercentUsed",
  "agentRemainingUsd", "aiSpendUsd", "annualAllocationUsd", "canonicalSpendUsd",
  "currentCycleAgentSpendUsd", "currentPercentUsed", "currentSpendUsd",
  "cycleAgentSpendUsd", "dailySpend", "dailySpendUsd", "displaySpendUsd",
  "effectiveLimitUsd", "eligibleSpendUsd", "excludedInternalSpendUsd",
  "explicitLimitUsd", "grossSpendUsd", "knownSpendUsd", "limitUsd",
  "membersSpendUsd", "monthlyAgentLimitUsd", "monthlyLimitUsd",
  "nonAiSpendUsd", "observedSpendUsd", "paceSpendUsd", "projectedRemainingUsd",
  "projectedSpendUsd", "projectedUsePercent", "projectSpendUsd",
  "rawMemberSpendUsd", "remaining_usd", "reportedSpendUsd", "residualSpendUsd",
  "rollupSpendUsd", "sevenDayDailySpendUsd", "spend_usd", "teamAllocationUsd",
  "unattributedProjectSpendUsd", "unattributedSpendUsd", "usageUsd",
  "twentyEightDayDailySpendUsd", "currentMonthUsageAvailability",
  "headline", "hierarchy", "budgetTracking", "sourceGroups", "cards",
  "isComplete", "dataAvailable", "comparisonsMatchBudgetWindow",
  "observationState", "unavailableReason", "unit", "key",
  "state", "trend", "buckets", "breakdown", "personalLimits",
  "personalSpendByWorkspace", "personalProjectCatalog", "projection",
  "actualPeriod", "target", "rate", "baseline", "budget", "trajectory",
  "staleSpend", "insights", "categories", "monthly", "topSpenders",
]);

const FINANCIAL_FIELDS = new Set([
  "spend", "agent_spend", "agent_spend_usd", "your_agent_spend",
  "eligible_spend", "remaining", "agent_limit_remaining",
  "current_cycle_agent_spend_usd", "current_cycle_remaining_usd",
  "allocation", "canonical_allocation", "allocation_remaining",
  "allocation_or_limit_usd", "limit", "limits", "monthly_agent_limit",
  "personal_agent_limit", "personal_limit", "percent", "percent_used",
  "current_cycle_percent_used", "usage", "personal_usage",
  "current_cycle_usage", "currentCycleUsage", "denominator",
  "spendUsd", "agentSpendUsd", "otherServicesUsd", "allocationUsd",
  "remainingUsd", "percentUsed", "currentMonthSpendUsd", "currentCycleSpendUsd",
  "currentCycleRemainingUsd", "currentCyclePercentUsed",
  "accountReconciliationSpendUsd", "accountSpendUsd", "agentPercentUsed",
  "agentRemainingUsd", "aiSpendUsd", "annualAllocationUsd", "canonicalSpendUsd",
  "currentCycleAgentSpendUsd", "currentPercentUsed", "currentSpendUsd",
  "cycleAgentSpendUsd", "dailySpend", "dailySpendUsd", "displaySpendUsd",
  "effectiveLimitUsd", "eligibleSpendUsd", "excludedInternalSpendUsd",
  "explicitLimitUsd", "grossSpendUsd", "knownSpendUsd", "limitUsd",
  "membersSpendUsd", "monthlyAgentLimitUsd", "monthlyLimitUsd",
  "nonAiSpendUsd", "observedSpendUsd", "paceSpendUsd", "projectedRemainingUsd",
  "projectedSpendUsd", "projectedUsePercent", "projectSpendUsd",
  "rawMemberSpendUsd", "remaining_usd", "reportedSpendUsd", "residualSpendUsd",
  "rollupSpendUsd", "sevenDayDailySpendUsd", "spend_usd", "teamAllocationUsd",
  "unattributedProjectSpendUsd", "unattributedSpendUsd", "usageUsd",
  "twentyEightDayDailySpendUsd",
]);

function safeName(name: string): string {
  return SAFE_FIELDS.has(name) ? name : "[field]";
}

function unavailableEnum(
  value: string,
  field?: string,
): DataUnavailableReason | undefined {
  const isLimitObservation = field === "limit_observation_status" ||
    field === "limitObservationStatus" || field === "limitState" ||
    field === "observationState";
  switch (value.toLowerCase()) {
    case "no_usage_observed": return "no_usage_observed";
    case "incomplete":
    case "partial":
    case "incomplete_usage": return "incomplete_usage";
    case "empty": return "no_usage_observed";
    case "incomplete_scope": return "incomplete_scope";
    case "failed":
      return isLimitObservation
        ? "limit_observation_failed" : undefined;
    case "observation_failed":
    case "limit_observation_failed": return "limit_observation_failed";
    case "limit_observation_unavailable": return "limit_observation_unavailable";
    case "refreshing":
      return isLimitObservation
        ? "limit_observation_refreshing" : undefined;
    case "limit_observation_refreshing": return "limit_observation_refreshing";
    case "period_mismatch": return "period_mismatch";
    case "authorization_unavailable": return "authorization_unavailable";
    case "unavailable":
      return isLimitObservation
        ? "limit_observation_unavailable" : "explicit_unavailable";
    default: return undefined;
  }
}

function siblingValue(
  object: object,
  names: readonly string[],
): unknown {
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    if (descriptor && "value" in descriptor) return descriptor.value;
  }
  return undefined;
}

function metricReason(object: object, field: string): DataUnavailableReason | undefined {
  if (field === "value") {
    const cardKey = siblingValue(object, ["key"]);
    const qualification = siblingValue(object, ["qualification"]);
    if (
      (cardKey === "monthly_agent_limit" || cardKey === "agent_limit_remaining") &&
      typeof qualification === "string"
    ) {
      if (/no (?:agent |single transferable )?limit/i.test(qualification)) {
        return undefined;
      }
      if (/refreshing/i.test(qualification)) return "limit_observation_refreshing";
      if (/failed/i.test(qualification)) return "limit_observation_failed";
      if (/unavailable|no completed stored limit observation is available/i.test(qualification)) {
        return "limit_observation_unavailable";
      }
    }
  }
  const noLimit = siblingValue(object, ["no_limit", "noLimit"]) === true ||
    ["limit_observation_status", "limitObservationStatus", "limitState", "status", "state"]
      .some((name) => siblingValue(object, [name]) === "no_limit");
  // No-limit only excuses the absent denominator and derived values. It never
  // excuses allocation or usage for the current cycle.
  if (noLimit && (field === "amount" || /limit|remaining|percent|denominator/i.test(field))) return undefined;

  const statusFields = [
    "limit_observation_status", "limitObservationStatus", "data_status",
    "usage_status", "scope_status",
    "period_status", "authorization_status", "status", "state",
  ] as const;
  for (const statusField of statusFields) {
    const status = siblingValue(object, [statusField]);
    if (status === "loading" || status === "not_applicable") return undefined;
    const reason = typeof status === "string"
      ? unavailableEnum(status, statusField) : undefined;
    if (reason) return reason;
  }
  if (siblingValue(object, ["observed", "usageObserved"]) === false) return "no_usage_observed";
  if (siblingValue(object, ["usage_complete", "usageComplete", "complete"]) === false) return "incomplete_usage";
  if (siblingValue(object, ["isComplete"]) === false) return "incomplete_usage";
  if (siblingValue(object, ["scope_complete", "scopeComplete"]) === false) return "incomplete_scope";
  if (siblingValue(object, [
    "period_matches", "periodMatches", "comparisonsMatchBudgetWindow",
  ]) === false) return "period_mismatch";
  if (/allocation/i.test(field)) return "missing_allocation";
  return "missing_value";
}

export function inspectUnavailableData(input: unknown): DataUnavailableDiagnostic {
  const started = performance.now();
  const sites = new Map<string, DataUnavailableSite>();
  const seen = new WeakSet<object>();
  let nodes = 0;
  let enqueued = 1;
  let examined = 0;
  let truncated = false;

  const add = (path: string, reason: DataUnavailableReason) => {
    const key = `${path}\0${reason}`;
    const existing = sites.get(key);
    if (existing) existing.count++;
    else if (sites.size < MAX_SITES) sites.set(key, { path, reason, count: 1 });
    else truncated = true;
  };

  const stack: Array<{ value: unknown; path: string; depth: number; parent?: object; field?: string }> =
    [{ value: input, path: "body", depth: 0 }];
  while (stack.length) {
    if (++nodes > MAX_NODES || performance.now() - started > MAX_SCAN_MS) {
      truncated = true;
      break;
    }
    const current = stack.pop()!;
    if (current.depth > MAX_DEPTH) {
      truncated = true;
      continue;
    }
    const { value } = current;
    if (value === false && current.field === "dataAvailable") {
      add(current.path, "explicit_unavailable");
    } else if (value === false && current.field === "isComplete") {
      add(current.path, "incomplete_usage");
    } else if (
      value === false && current.field === "comparisonsMatchBudgetWindow"
    ) {
      add(current.path, "period_mismatch");
    }
    const cardMetric = current.parent && current.field === "value" && (
      ["usd", "percent"].includes(String(siblingValue(current.parent, ["unit"]))) ||
      [
        "spend", "remaining", "allocation", "usage", "limit", "percent",
        "current_cycle_spend", "current_cycle_usage", "your_agent_spend",
        "monthly_agent_limit", "agent_limit_remaining", "agent_spend",
        "other_services", "eligible_spend", "allocated_budget",
        "allocation_remaining", "pools_attention", "members_with_spend",
      ].includes(String(siblingValue(current.parent, ["key"])))
    );
    if (
      current.parent && current.field &&
      (FINANCIAL_FIELDS.has(current.field) || cardMetric ||
        (current.field === "amount" && current.path.endsWith(".personalLimits[].amount"))) &&
      (value === null || (typeof value === "number" && !Number.isFinite(value)))
    ) {
      const reason = metricReason(current.parent, current.field);
      if (reason) add(current.path, reason);
    }
    if (typeof value === "string") {
      const statusReason = current.field &&
        (current.field.toLowerCase().includes("status") ||
          current.field === "availability" || current.field === "limitState" ||
          current.field === "observationState" ||
          current.field === "unavailableReason")
        ? unavailableEnum(value, current.field) : undefined;
      if (statusReason || (current.path === "body" && unavailableEnum(value))) {
        add(current.path, statusReason ?? unavailableEnum(value)!);
      }
      else if (
        (current.path === "body" || current.field === "error" ||
          current.field === "message" || current.field === "qualification" ||
          current.field === "qualifications") &&
        /\bunavailable\b/i.test(value)
      ) {
        add(current.path, /\bauthori[sz]ation\b/i.test(value)
          ? "authorization_unavailable" : "explicit_unavailable");
      }
      continue;
    }
    if (!value || typeof value !== "object") continue;
    if (seen.has(value)) continue;
    seen.add(value);

    if (Array.isArray(value)) {
      // for-in avoids materializing every key of a hostile large/sparse array.
      for (const name in value) {
        if (++examined > MAX_NODES || enqueued >= MAX_NODES ||
          performance.now() - started > MAX_SCAN_MS) {
          truncated = true;
          break;
        }
        if (!Object.hasOwn(value, name) || !/^(0|[1-9]\d*)$/.test(name)) continue;
        const index = Number(name);
        if (!Number.isSafeInteger(index) || index >= value.length) continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (!descriptor || !("value" in descriptor)) continue;
        stack.push({
          value: descriptor.value,
          path: `${current.path}[]`,
          depth: current.depth + 1,
          field: current.field,
        });
        enqueued++;
      }
      continue;
    }
    // API JSON properties are enumerable. Iteration keeps the scanner's own
    // memory bounded instead of first allocating an unbounded key array.
    for (const name in value) {
      if (++examined > MAX_NODES || enqueued >= MAX_NODES ||
        performance.now() - started > MAX_SCAN_MS) {
        truncated = true;
        break;
      }
      if (!Object.hasOwn(value, name)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !("value" in descriptor)) continue; // Never invoke getters.
      stack.push({
        value: descriptor.value,
        path: `${current.path}.${safeName(name)}`,
        depth: current.depth + 1,
        parent: value,
        field: name,
      });
      enqueued++;
    }
  }
  if (truncated) add("body", "scan_truncated");
  const result = [...sites.values()];
  return {
    count: result.reduce((sum, site) => sum + site.count, 0),
    sites: result,
    truncated,
  };
}

function inspectText(value: string | Buffer): DataUnavailableDiagnostic {
  const text = typeof value === "string"
    ? value.slice(0, MAX_TEXT_CHARS)
    : value.toString("utf8", 0, MAX_TEXT_CHARS);
  const matches = text.match(/\bunavailable\b/gi);
  const truncated = value.length > MAX_TEXT_CHARS;
  const sites: DataUnavailableSite[] = matches?.length
    ? [{ path: "body", reason: "explicit_unavailable", count: matches.length }]
    : [];
  if (truncated) sites.push({ path: "body", reason: "scan_truncated", count: 1 });
  return {
    count: sites.reduce((sum, site) => sum + site.count, 0),
    sites,
    truncated,
  };
}

function inspectSerializedJson(value: string | Buffer): DataUnavailableDiagnostic {
  const withinParseBudget = typeof value === "string"
    ? value.length <= MAX_TEXT_CHARS
    : value.length <= MAX_TEXT_CHARS;
  if (withinParseBudget) {
    try {
      const text = typeof value === "string" ? value : value.toString("utf8");
      return inspectUnavailableData(JSON.parse(text));
    } catch {
      // A malformed response must remain byte-for-byte untouched. The bounded
      // text scanner still captures authored "unavailable" errors without
      // exposing parser error prose.
    }
  }
  return inspectText(value);
}

function headerValue(diagnostic: DataUnavailableDiagnostic): string {
  const header: DataUnavailableDiagnostic = {
    count: diagnostic.count,
    sites: [],
    truncated: diagnostic.truncated,
  };
  for (const site of diagnostic.sites) {
    const candidate = { ...header, sites: [...header.sites, site] };
    const encoded = JSON.stringify(candidate);
    if (Buffer.byteLength(encoded, "ascii") > HEADER_MAX_BYTES) {
      header.truncated = true;
      break;
    }
    header.sites.push(site);
  }
  return JSON.stringify(header).replace(/[^\x20-\x7e]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function dataUnavailableLogging(
  endpoint: (url: string | undefined) => string,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = process.hrtime.bigint();
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);
    let insideJson = false;
    let recorded = false;
    const warn = (details: object, message: string): void => {
      try {
        req.log.warn(details, message);
      } catch {
        // Logging is observational and must never change the HTTP response.
      }
    };

    const record = (
      body: unknown,
      mode: "structured" | "text" | "serialized-json",
    ) => {
      if (recorded) return;
      recorded = true;
      try {
        const isTextBody = typeof body === "string" || Buffer.isBuffer(body);
        const diagnostic = mode === "serialized-json" && isTextBody
          ? inspectSerializedJson(body)
          : mode === "text" && isTextBody
            ? inspectText(body)
            : inspectUnavailableData(body);
        if (!diagnostic.count) return;
        try {
          res.setHeader("x-data-unavailable", headerValue(diagnostic));
        } catch {
          warn({
            requestId: req.id,
            sites: [{ path: "body", reason: "instrumentation_failed", count: 1 }],
          }, "Data availability header instrumentation failed");
        }
        warn({
          requestId: req.id,
          endpoint: endpoint(req.originalUrl),
          method: req.method,
          status: res.statusCode,
          durationMs: Math.round(Number(process.hrtime.bigint() - started) / 100_000) / 10,
          sites: diagnostic.sites,
          count: diagnostic.count,
          truncated: diagnostic.truncated,
        }, "data_unavailable");
      } catch {
        warn({
          requestId: req.id,
          endpoint: endpoint(req.originalUrl),
          method: req.method,
          status: res.statusCode,
          sites: [{ path: "body", reason: "instrumentation_failed", count: 1 }],
          count: 1,
          truncated: true,
        }, "data_unavailable");
      }
    };

    res.json = ((body: unknown) => {
      record(body, "structured");
      insideJson = true;
      try {
        return originalJson(body);
      } finally {
        insideJson = false;
      }
    }) as Response["json"];
    res.send = ((body?: unknown) => {
      if (!insideJson) {
        const contentType = String(res.getHeader("content-type") ?? "").toLowerCase();
        const serializedJson = /(?:application\/json|\/[^;+\s]+\+json)(?:;|$)/i
          .test(contentType);
        record(body, serializedJson ? "serialized-json" :
          typeof body === "string" || Buffer.isBuffer(body) ||
          contentType.includes("text/") || contentType.includes("csv")
            ? "text" : "structured");
      }
      return originalSend(body);
    }) as Response["send"];
    next();
  };
}