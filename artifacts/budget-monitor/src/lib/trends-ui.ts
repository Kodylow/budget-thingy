import type {
  GetTrendsGranularity,
  GetTrendsParams,
  RangeTypeParameter,
} from '@workspace/api-client-react';

export function buildTrendsParams({
  granularity,
  rangeType,
  startDate,
  endDate,
  selectedTeams,
  selectedGroupIds,
}: {
  granularity: GetTrendsGranularity;
  rangeType: RangeTypeParameter;
  startDate?: string;
  endDate?: string;
  selectedTeams: ReadonlySet<string>;
  selectedGroupIds: ReadonlySet<string>;
}): GetTrendsParams {
  return {
    granularity,
    rangeType,
    ...(rangeType === 'custom' ? { startDate, endDate } : {}),
    ...(selectedTeams.size > 0 ? { teamNames: [...selectedTeams].sort() } : {}),
    ...(selectedGroupIds.size > 0 ? { groupIds: [...selectedGroupIds].sort() } : {}),
  };
}

export const PARTIAL_BUCKET_EXPLANATION =
  'Partial bucket: current usage can arrive late. Bucket boundaries are calculated in UTC, so this value is not final.';