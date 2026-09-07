import { useState, useSyncExternalStore } from 'react';
import { Copy, Stethoscope } from 'lucide-react';
import {
  getApiDiagnostics,
  subscribeApiDiagnostics,
  type ApiDiagnosticEntry,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

function diagnosticReport(entries: readonly ApiDiagnosticEntry[]): string {
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    page: entries.at(-1)?.route ?? window.location.pathname,
    requests: entries.map(({ timestamp, method, endpoint, route, status, elapsedMs, requestId, category, dataState }) => ({
      timestamp,
      method,
      endpoint,
      route,
      status,
      elapsedMs,
      requestId,
      category,
      ...(dataState ? { dataState } : {}),
    })),
  }, null, 2);
}

/** Small, app-shell-ready mount point for redacted volatile API diagnostics. */
export function ApiDiagnostics() {
  const entries = useSyncExternalStore(
    subscribeApiDiagnostics,
    getApiDiagnostics,
    getApiDiagnostics,
  );
  const [copyStatus, setCopyStatus] = useState<string>('');
  const failures = entries.filter((entry) => entry.category !== 'success' && entry.category !== 'aborted');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(diagnosticReport(entries));
      setCopyStatus('Copied. Include this with your support report.');
    } catch {
      setCopyStatus('Copy failed. Your browser may block clipboard access.');
      console.error('diagnostics_copy_failed', { category: 'clipboard' });
    }
  };

  return (
    <Dialog onOpenChange={() => setCopyStatus('')}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" aria-label="Open API diagnostics">
          <Stethoscope className="mr-2 h-4 w-4" />
          Diagnostics{failures.length > 0 ? ` (${failures.length})` : ''}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request diagnostics</DialogTitle>
          <DialogDescription>
            Volatile, redacted request details and safe availability flags help support identify a
            failed page. No response payloads, cookies, tokens, or financial values are included.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-72 space-y-2 overflow-y-auto text-xs" aria-live="polite">
          {entries.length === 0 ? (
            <p className="text-muted-foreground">No API requests recorded in this session.</p>
          ) : [...entries].reverse().map((entry, index) => (
            <div className="rounded-md border p-2" key={`${entry.timestamp}-${index}`}>
              <div className="font-medium">
                {entry.method} {entry.endpoint} — {entry.status ?? entry.category}
              </div>
              <div className="text-muted-foreground">
                {entry.elapsedMs} ms · request ID: {entry.requestId ?? 'not provided'}
              </div>
              {entry.dataState && (
                <div className="mt-1 text-muted-foreground">
                  Data: {[
                    entry.dataState.metadataStatus && `status ${entry.dataState.metadataStatus}`,
                    entry.dataState.stale === true ? 'stale' : entry.dataState.stale === false ? 'fresh' : null,
                    typeof entry.dataState.dataAvailable === 'boolean'
                      ? `available ${entry.dataState.dataAvailable ? 'yes' : 'no'}`
                      : null,
                    typeof entry.dataState.rowCount === 'number'
                      ? `${entry.dataState.rowCount} rows`
                      : null,
                    entry.dataState.dashboardCardKeys?.length
                      ? `cards: ${entry.dataState.dashboardCardKeys.join(', ')}`
                      : null,
                    entry.dataState.limitObservationStateCounts
                      ? `limit observations: ${Object.entries(entry.dataState.limitObservationStateCounts)
                        .map(([state, count]) => `${state} ${count}`)
                        .join(', ')}`
                      : null,
                  ].filter(Boolean).join(' · ')}
                </div>
              )}
            </div>
          ))}
        </div>
        <Button type="button" variant="outline" onClick={() => void copy()}>
          <Copy className="mr-2 h-4 w-4" />
          Copy redacted diagnostics
        </Button>
        {copyStatus && <p className="text-sm text-muted-foreground" role="status">{copyStatus}</p>}
      </DialogContent>
    </Dialog>
  );
}