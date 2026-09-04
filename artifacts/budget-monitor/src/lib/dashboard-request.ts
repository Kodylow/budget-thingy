import type {
  GetDashboardParams,
  RangeTypeParameter,
  TrendGranularityParameter,
  TrendModeParameter,
  ViewScopeParameter,
} from "@workspace/api-client-react";

export function dashboardRequestParams(input: {
  rangeType: RangeTypeParameter;
  startDate?: string;
  endDate?: string;
  granularity?: TrendGranularityParameter;
  trendMode?: TrendModeParameter;
  viewScope?: ViewScopeParameter;
}): GetDashboardParams {
  const params: GetDashboardParams = { rangeType: input.rangeType };
  if (input.rangeType === "custom") {
    params.startDate = input.startDate;
    params.endDate = input.endDate;
  }
  if (input.granularity) params.granularity = input.granularity;
  if (input.trendMode) params.trendMode = input.trendMode;
  if (input.viewScope) params.viewScope = input.viewScope;
  return params;
}

export function dashboardSpendHref(
  searchString: string,
  filter?: Record<string, string>,
): string {
  const params = new URLSearchParams(searchString);
  for (const [key, value] of Object.entries(filter ?? {})) {
    params.set(key, value);
  }
  return `/spend?${params.toString()}`;
}