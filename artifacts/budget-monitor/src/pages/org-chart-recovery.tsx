import React, { Component, useState, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { reportRenderFailure } from '@/lib/render-diagnostics';

export function OrgChartUnavailable({ onRetry, incompatible = false }: {
  onRetry: () => Promise<void>;
  incompatible?: boolean;
}) {
  const [retrying, setRetrying] = useState(false);
  const [failed, setFailed] = useState(false);
  const retry = async () => {
    setRetrying(true);
    setFailed(false);
    try {
      await onRetry();
    } catch {
      setFailed(true);
    } finally {
      setRetrying(false);
    }
  };
  return (
    <section className="rounded border bg-card p-6" role="alert" data-testid="org-chart-unavailable">
      <h2 className="text-base font-semibold">Budget Trajectory unavailable</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        {incompatible
          ? 'The chart data is incomplete or incompatible with this version. Retry to request current data.'
          : 'The chart could not render. Retry to refresh its data and try the chart again.'}
        {' '}The rest of this report is still available.
      </p>
      {failed && <p className="mt-2 text-sm">Chart refresh failed. Please try again later.</p>}
      <Button className="mt-4" variant="outline" size="sm" disabled={retrying} onClick={() => void retry()}>
        {retrying ? 'Retrying chart…' : 'Retry chart'}
      </Button>
    </section>
  );
}

export class OrgChartBoundary extends Component<{
  children: ReactNode;
  onRetry: () => Promise<void>;
}, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    reportRenderFailure(error, info, 'org-budget-chart');
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return <OrgChartUnavailable onRetry={async () => {
      await this.props.onRetry();
      this.setState({ failed: false });
    }} />;
  }
}