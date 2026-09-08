import type { SpendPersonWorkspace } from '@workspace/api-client-react';
import { formatUsd } from '@/pages/home-components/format';

export function PersonWorkspaceDetails({ workspaces, id, memberName }: {
  workspaces: SpendPersonWorkspace[];
  id?: string;
  memberName?: string;
}) {
  return (
    <div id={id} className="p-3">
      <table className="w-full text-xs">
        <caption className="sr-only">{memberName ? `${memberName} workspace breakdown` : 'Workspace breakdown'}</caption>
        <thead className="text-muted-foreground">
          <tr>
            {['Workspace', 'Selected-period spend', 'Billing-cycle Agent', 'Monthly Agent limit', 'Billing-cycle remaining'].map((label, index) => (
              <th key={label} scope="col" className={`px-2 pb-2 font-medium ${index === 0 ? 'text-left' : 'text-right'}`}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {workspaces.map((workspace) => (
            <tr key={workspace.workspaceId} className="align-top">
              <th scope="row" className="max-w-48 break-words px-2 py-2 text-left font-medium [overflow-wrap:anywhere]">{workspace.workspaceName ?? workspace.workspaceId}</th>
              <td className="whitespace-nowrap px-2 py-2 text-right font-mono">{workspace.usageObserved === false ? 'Unavailable' : formatUsd(workspace.spendUsd)}</td>
              <td className="whitespace-nowrap px-2 py-2 text-right font-mono">{formatUsd(workspace.currentCycleAgentSpendUsd)}</td>
              <td className="px-2 py-2 text-right">
                <span className="whitespace-nowrap font-mono">{workspace.limitState === 'no_limit' ? 'No limit' : formatUsd(workspace.allocationUsd)}</span>
                <span className="block text-[10px] text-muted-foreground">Source: {workspace.limitState.replaceAll('_', ' ')}</span>
                {workspace.limitObservationStatus === 'failed' && workspace.allocationUsd == null && <span className="block text-[10px] text-muted-foreground">Observation failed</span>}
                {workspace.limitObservationStatus === 'unavailable' && <span className="block text-[10px] text-muted-foreground">Observation unavailable</span>}
              </td>
              <td className="whitespace-nowrap px-2 py-2 text-right font-mono">{formatUsd(workspace.currentCycleRemainingUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}