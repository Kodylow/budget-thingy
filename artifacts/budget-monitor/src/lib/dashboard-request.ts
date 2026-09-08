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
  workspaceId?: GetDashboardParams["workspaceId"];
  projectionHorizon?: GetDashboardParams["projectionHorizon"];
  planningEndDate?: GetDashboardParams["planningEndDate"];
}): GetDashboardParams {
  const params: GetDashboardParams = { rangeType: input.rangeType };
  if (input.rangeType === "custom") {
    params.startDate = input.startDate;
    params.endDate = input.endDate;
  }
  if (input.granularity) params.granularity = input.granularity;
  if (input.trendMode) params.trendMode = input.trendMode;
  if (input.viewScope) params.viewScope = input.viewScope;
  if (input.workspaceId) params.workspaceId = input.workspaceId;
  if (input.projectionHorizon) params.projectionHorizon = input.projectionHorizon;
  if (input.projectionHorizon === 'planning_end' && input.planningEndDate) params.planningEndDate = input.planningEndDate;
  return params;
}

export function dashboardReportingHref(
  destination: '/org-insights' | '/my-team',
  searchString: string,
): string {
  const params = new URLSearchParams(searchString);
  for (const key of ['viewScope', 'workspaceId']) params.delete(key);
  return `${destination}${params.size ? `?${params}` : ''}`;
}