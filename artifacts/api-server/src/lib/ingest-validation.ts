type UsageMetric = {
  id: string;
  name: string;
  category: string;
  costUsd: number;
};

type UsageGroup = {
  key?: { userId?: string; projectId?: string };
  totalCostUsd?: number;
  metrics?: UsageMetric[];
};

export type ValidatedUsagePayload = {
  interval?: { startTime?: string; endTime?: string };
  totalCostUsd: number;
  attributableTotalCostUsd?: number;
  unattributableTotalCostUsd?: number;
  metrics?: UsageMetric[];
  groups?: UsageGroup[];
  pagination?: {
    nextCursor?: string | null;
    cursor?: string | null;
    hasMore?: boolean;
  };
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Enterprise /usage ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function finiteMoney(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Enterprise /usage ${label} must be a finite non-negative number`);
  }
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Enterprise /usage ${label} must be a non-empty string`);
  }
  return value;
}

function metrics(value: unknown, label: string): UsageMetric[] {
  if (!Array.isArray(value)) throw new Error(`Enterprise /usage ${label} must be an array`);
  return value.map((raw, index) => {
    const metric = object(raw, `${label}[${index}]`);
    return {
      id: nonEmptyString(metric.id, `${label}[${index}].id`),
      name: nonEmptyString(metric.name, `${label}[${index}].name`),
      category: nonEmptyString(metric.category, `${label}[${index}].category`),
      costUsd: finiteMoney(metric.costUsd, `${label}[${index}].costUsd`),
    };
  });
}

/**
 * Rejects an ambiguous page before any durable fact is replaced. Zero is a
 * valid observation; omitted, string, negative and non-finite amounts are not.
 */
export function validateUsagePayload(
  raw: unknown,
  groupBy?: "member" | "project",
): ValidatedUsagePayload {
  const payload = object(raw, "data");
  const validated: ValidatedUsagePayload = {
    totalCostUsd: finiteMoney(payload.totalCostUsd, "data.totalCostUsd"),
  };
  if (payload.interval !== undefined) {
    const interval = object(payload.interval, "data.interval");
    validated.interval = {
      startTime: interval.startTime === undefined
        ? undefined
        : nonEmptyString(interval.startTime, "data.interval.startTime"),
      endTime: interval.endTime === undefined
        ? undefined
        : nonEmptyString(interval.endTime, "data.interval.endTime"),
    };
  }
  if (payload.metrics !== undefined) validated.metrics = metrics(payload.metrics, "data.metrics");
  if (!groupBy) return validated;

  validated.attributableTotalCostUsd = finiteMoney(
    payload.attributableTotalCostUsd,
    "data.attributableTotalCostUsd",
  );
  validated.unattributableTotalCostUsd = finiteMoney(
    payload.unattributableTotalCostUsd,
    "data.unattributableTotalCostUsd",
  );
  validated.metrics = metrics(payload.metrics, "data.metrics");
  if (!Array.isArray(payload.groups)) {
    throw new Error("Enterprise /usage data.groups must be an array");
  }
  validated.groups = payload.groups.map((rawGroup, index) => {
    const group = object(rawGroup, `data.groups[${index}]`);
    const key = object(group.key, `data.groups[${index}].key`);
    const keyName = groupBy === "member" ? "userId" : "projectId";
    return {
      key: { [keyName]: nonEmptyString(key[keyName], `data.groups[${index}].key.${keyName}`) },
      totalCostUsd: finiteMoney(group.totalCostUsd, `data.groups[${index}].totalCostUsd`),
      metrics: metrics(group.metrics, `data.groups[${index}].metrics`),
    };
  });
  const pagination = object(payload.pagination, "data.pagination");
  if (typeof pagination.hasMore !== "boolean") {
    throw new Error("Enterprise /usage data.pagination.hasMore must be a boolean");
  }
  const cursorValue = pagination.nextCursor ?? pagination.cursor;
  if (cursorValue !== undefined && cursorValue !== null && typeof cursorValue !== "string") {
    throw new Error("Enterprise /usage pagination cursor must be a string or null");
  }
  if (pagination.hasMore && (typeof cursorValue !== "string" || cursorValue === "")) {
    throw new Error("Enterprise /usage pagination reported hasMore without a cursor");
  }
  validated.pagination = {
    hasMore: pagination.hasMore,
    nextCursor: pagination.nextCursor as string | null | undefined,
    cursor: pagination.cursor as string | null | undefined,
  };
  return validated;
}

export function assertIntervalMatches(
  payload: ValidatedUsagePayload,
  expectedStart: string,
  expectedEnd: string,
): void {
  const { startTime, endTime } = payload.interval ?? {};
  if ((startTime !== undefined && Date.parse(startTime) !== Date.parse(expectedStart)) ||
      (endTime !== undefined && Date.parse(endTime) !== Date.parse(expectedEnd))) {
    throw new Error("Enterprise /usage returned an interval outside the requested bounds");
  }
}

export function assertExplicitIntervalMatches(
  payload: ValidatedUsagePayload,
  expectedStart: string,
  expectedEnd: string,
): void {
  if (!payload.interval?.startTime || !payload.interval.endTime) {
    throw new Error("Enterprise /usage grouped page omitted its requested interval");
  }
  assertIntervalMatches(payload, expectedStart, expectedEnd);
}