import type { SpendPersonWorkspace } from '@workspace/api-client-react';
import { formatUsd } from '@/pages/home-components/format';

export function PersonWorkspaceDetails({ workspaces }: { workspaces: SpendPersonWorkspace[] }) {
  return (
    <details className="mt-1 text-xs">
      <summary className="w-fit cursor-pointer text-muted-foreground hover:text-foreground">
        {workspaces.length} workspaces
      </summary>
      <div className="mt-2 min-w-64 space-y-3">
        {workspaces.map((workspace) => (
          <div key={workspace.workspaceId} className="border-l pl-3">
            <p className="font-medium">{workspace.workspaceName ?? workspace.workspaceId}</p>
            <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">Selected spend</dt>
              <dd className="text-right font-mono">{workspace.usageObserved === false ? 'Unavailable' : formatUsd(workspace.spendUsd)}</dd>
              <dt className="text-muted-foreground">Billing-cycle Agent</dt>
              <dd className="text-right font-mono">{formatUsd(workspace.currentCycleAgentSpendUsd)}</dd>
              <dt className="text-muted-foreground">Monthly Agent limit</dt>
              <dd className="text-right font-mono">{workspace.limitState === 'no_limit' ? 'No limit' : formatUsd(workspace.allocationUsd)}</dd>
              <dt className="text-muted-foreground">Limit source</dt>
              <dd className="text-right">{workspace.limitState.replaceAll('_', ' ')}</dd>
              <dt className="text-muted-foreground">Remaining</dt>
              <dd className="text-right font-mono">{formatUsd(workspace.currentCycleRemainingUsd)}</dd>
            </dl>
            {workspace.limitObservationStatus === 'refreshing' && <p className="mt-1 text-muted-foreground">Refreshing</p>}
            {workspace.limitObservationStatus === 'failed' && <p className="mt-1 text-muted-foreground">{workspace.allocationUsd != null ? 'Last known · refresh failed' : 'Observation failed'}</p>}
            {workspace.limitObservationStatus === 'unavailable' && <p className="mt-1 text-muted-foreground">Observation unavailable</p>}
          </div>
        ))}
      </div>
    </details>
  );
}