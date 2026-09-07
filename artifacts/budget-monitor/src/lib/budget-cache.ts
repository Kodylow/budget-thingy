import type { QueryClient } from '@tanstack/react-query';
import {
  getGetWorkspaceLimitPoliciesQueryKey,
  getListVisibleWorkspaceMembersQueryKey,
  getListWorkspaceUsageLimitAuditsQueryKey,
} from '@workspace/api-client-react';

export const invalidateBudgetCaches = (queryClient: QueryClient, workspaceId?: string) => {
  if (workspaceId) {
    void queryClient.invalidateQueries({ queryKey: getListVisibleWorkspaceMembersQueryKey(workspaceId) });
    void queryClient.invalidateQueries({ queryKey: getListWorkspaceUsageLimitAuditsQueryKey(workspaceId) });
    void queryClient.invalidateQueries({ queryKey: getGetWorkspaceLimitPoliciesQueryKey(workspaceId) });
  }
  void queryClient.invalidateQueries({
    predicate: (query) =>
      typeof query.queryKey[0] === 'string' &&
      (query.queryKey[0] === '/api/dashboard' ||
       query.queryKey[0].startsWith('/api/spend/') ||
       query.queryKey[0].startsWith('/api/limits') ||
       query.queryKey[0].startsWith('/api/reporting/details/') ||
       query.queryKey[0].startsWith('/api/directory/workspaces') ||
       query.queryKey[0].startsWith('/api/clusters/') ||
       query.queryKey[0].startsWith('/api/groups/') ||
       query.queryKey[0].includes('history') ||
       query.queryKey[0].includes('audit'))
  });
};