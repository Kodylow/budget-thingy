export type ApiDiagnosticCategory = "success" | "http" | "network" | "parse" | "aborted";

export interface ApiDiagnosticDataState {
  metadataStatus?: "complete" | "stale" | "partial" | "empty" | "unavailable";
  stale?: boolean;
  dataAvailable?: boolean;
  rowCount?: number;
  dashboardCardKeys?: Array<
    | "eligible_spend"
    | "allocated_budget"
    | "allocation_remaining"
    | "pools_attention"
    | "spend"
    | "agent_spend"
    | "other_services"
    | "members_with_spend"
    | "your_agent_spend"
    | "monthly_agent_limit"
    | "agent_limit_remaining"
  >;
  limitObservationStateCounts?: Partial<
    Record<"not_applicable" | "complete" | "failed" | "unavailable" | "refreshing", number>
  >;
}

export interface ApiDiagnosticEntry {
  timestamp: string;
  method: string;
  endpoint: string;
  route: string;
  status: number | null;
  elapsedMs: number;
  requestId: string | null;
  category: ApiDiagnosticCategory;
  dataState?: ApiDiagnosticDataState;
}

const HISTORY_LIMIT = 25;
const ALLOWED_QUERY_KEYS = new Set([
  "role",
  "viewScope",
  "rangeType",
  "start",
  "end",
  "startDate",
  "endDate",
]);
const listeners = new Set<() => void>();
let history: ApiDiagnosticEntry[] = [];
const METADATA_STATUSES = new Set([
  "complete",
  "stale",
  "partial",
  "empty",
  "unavailable",
] as const);
const DASHBOARD_CARD_KEYS = new Set([
  "eligible_spend",
  "allocated_budget",
  "allocation_remaining",
  "pools_attention",
  "spend",
  "agent_spend",
  "other_services",
  "members_with_spend",
  "your_agent_spend",
  "monthly_agent_limit",
  "agent_limit_remaining",
] as const);
const LIMIT_OBSERVATION_STATES = new Set([
  "not_applicable",
  "complete",
  "failed",
  "unavailable",
  "refreshing",
] as const);

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Extracts only an intentionally tiny primitive envelope from a parsed response. */
export function summarizeApiResponse(value: unknown): ApiDiagnosticDataState | undefined {
  const root = objectValue(value);
  if (!root) return undefined;
  const summary: ApiDiagnosticDataState = {};
  const metadata = objectValue(root.metadata);

  if (metadata && typeof metadata.status === "string" &&
      METADATA_STATUSES.has(metadata.status as never)) {
    summary.metadataStatus = metadata.status as ApiDiagnosticDataState["metadataStatus"];
  }
  if (metadata && typeof metadata.stale === "boolean") summary.stale = metadata.stale;
  if (metadata && typeof metadata.dataAvailable === "boolean") {
    summary.dataAvailable = metadata.dataAvailable;
  }

  if (Array.isArray(root.rows)) summary.rowCount = root.rows.length;

  if (Array.isArray(root.cards)) {
    const keys = root.cards.flatMap((card) => {
      const key = objectValue(card)?.key;
      return typeof key === "string" && DASHBOARD_CARD_KEYS.has(key as never)
        ? [key as NonNullable<ApiDiagnosticDataState["dashboardCardKeys"]>[number]]
        : [];
    });
    if (keys.length > 0) summary.dashboardCardKeys = [...new Set(keys)];
  }

  const observations = Array.isArray(root.rows)
    ? root.rows
    : Array.isArray(root.members)
      ? root.members
      : null;
  if (observations) {
    const counts: NonNullable<ApiDiagnosticDataState["limitObservationStateCounts"]> = {};
    observations.forEach((item) => {
      const state = objectValue(item)?.limitObservationStatus;
      if (typeof state === "string" && LIMIT_OBSERVATION_STATES.has(state as never)) {
        const safeState = state as keyof typeof counts;
        counts[safeState] = (counts[safeState] ?? 0) + 1;
      }
    });
    if (Object.keys(counts).length > 0) summary.limitObservationStateCounts = counts;
  }

  return Object.keys(summary).length > 0 ? summary : undefined;
}

function safeScopeValue(key: string, value: string): string | null {
  if (key === "start" || key === "end" || key === "startDate" || key === "endDate") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
      ? value
      : null;
  }
  return /^[A-Za-z0-9_-]{1,40}$/.test(value) ? value : null;
}

function isDynamicPathSegment(segments: string[], index: number): boolean {
  const previous = segments[index - 1];
  const beforePrevious = segments[index - 2];
  if (
    previous === "groups" ||
    previous === "clusters" ||
    previous === "workspaces" ||
    previous === "admins" ||
    previous === "app-admins" ||
    previous === "alerts" ||
    previous === "operations"
  ) {
    return true;
  }
  if (previous === "members" && segments[index] !== "budget") return true;
  if (
    beforePrevious === "reporting" &&
    (previous === "details" || previous === "teams")
  ) {
    return true;
  }
  if (previous === "team-budgets" && segments[index] !== "targets") return true;
  if (previous === "targets" || beforePrevious === "targets") return true;
  return false;
}

function safePathname(pathname: string): string {
  const segments = pathname.split("/");
  return segments
    .map((segment, index) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return "[redacted]";
      }
      return isDynamicPathSegment(segments, index) ||
        decoded.includes("@") ||
        decoded.length > 128
        ? "[redacted]"
        : segment;
    })
    .join("/");
}

/**
 * Returns only the path and explicitly approved scoping query parameters.
 * Hosts, fragments, identities, and all other query values are discarded.
 */
export function sanitizeDiagnosticUrl(input: string): string {
  try {
    const url = new URL(input, "https://diagnostics.invalid");
    const query = new URLSearchParams();
    url.searchParams.forEach((value, key) => {
      const safeValue = safeScopeValue(key, value);
      if (ALLOWED_QUERY_KEYS.has(key) && safeValue) query.append(key, safeValue);
    });
    const suffix = query.toString();
    return `${safePathname(url.pathname)}${suffix ? `?${suffix}` : ""}`;
  } catch {
    return "[invalid-path]";
  }
}

export function getApiDiagnostics(): readonly ApiDiagnosticEntry[] {
  return history;
}

export function subscribeApiDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyListeners(): void {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // A diagnostics UI subscriber must never alter API request behavior.
      try {
        console.error("api_diagnostics_subscriber_failed", { category: "subscriber" });
      } catch {
        // Diagnostics logging itself is best effort.
      }
    }
  });
}

export function recordApiDiagnostic(entry: ApiDiagnosticEntry): void {
  history = [...history.slice(-(HISTORY_LIMIT - 1)), Object.freeze({ ...entry })];
  notifyListeners();
}

/** Clears volatile history. Primarily useful when signing out and in tests. */
export function clearApiDiagnostics(): void {
  history = [];
  notifyListeners();
}

export function currentDiagnosticRoute(): string {
  if (typeof window === "undefined") return "[non-browser]";
  return sanitizeDiagnosticUrl(`${window.location.pathname}${window.location.search}`);
}

export function sanitizeDiagnosticRequestId(value: string | null): string | null {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}