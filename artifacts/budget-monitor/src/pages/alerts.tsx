import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, CheckCircle, XCircle, Send } from 'lucide-react';
import {
  useListAlerts,
  useRunAlertCheck,
  useSendTestAlert,
  getListAlertsQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { formatDistanceToNow } from 'date-fns';
import { useAuthContext } from '@/components/auth-context';
import { NotificationRecipients } from '@/components/notification-recipients';

export default function Alerts() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { canTestEmail, capabilities } = useAuthContext();
  const [runningCheck, setRunningCheck] = useState(false);
  const [testingAlertId, setTestingAlertId] = useState<number | null>(null);
  const [cursors, setCursors] = useState<Array<number | undefined>>([undefined]);
  const beforeId = cursors[cursors.length - 1];

  const { data: alerts, isLoading, isError, refetch } = useListAlerts(
    { limit: 100, ...(beforeId == null ? {} : { beforeId }) },
  );
  const runCheck = useRunAlertCheck();
  const sendTest = useSendTestAlert();

  const handleRunCheck = () => {
    setRunningCheck(true);
    runCheck.mutate(undefined, {
      onSuccess: (result) => {
        queryClient.invalidateQueries({ queryKey: getListAlertsQueryKey() });
        toast({
          title: 'Alert check completed',
          description: `Checked ${result.checkedGroups} groups, sent ${result.alertsSent} alerts`,
        });
        setRunningCheck(false);
      },
      onSettled: () => {
        setRunningCheck(false);
      },
      onError: () => {
        toast({ title: 'Alert check unavailable', description: 'No successful check was confirmed. Retry shortly.', variant: 'destructive' });
      },
    });
  };

  const handleSendTest = (alertId: number, entityName: string) => {
    setTestingAlertId(alertId);
    sendTest.mutate(
      { alertId },
      {
        onSuccess: (result) => {
          if (result.ok) {
            toast({
              title: 'Test email sent',
              description: `Sender: ${result.senderEmail}\nMessage ID: ${result.messageId}`,
            });
          } else {
            toast({
              title: 'Test email failed',
              description: result.error || 'Failed to send test email',
              variant: 'destructive',
            });
          }
        },
        onSettled: () => {
          setTestingAlertId(null);
        },
      },
    );
  };

  return (
    <div className="p-4 md:p-8 space-y-4 md:space-y-6 max-w-[100vw]">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight" data-testid="text-alerts-title">
            Email activity
          </h1>
          <p className="text-muted-foreground mt-1 text-sm md:text-base">
            Review recipients, delivery history, and authorized operational checks
          </p>
        </div>
        {capabilities.canRunChecks && (
          <Button
            onClick={handleRunCheck}
            disabled={runningCheck || runCheck.isPending}
            data-testid="button-run-check"
            className="w-full sm:w-auto"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${runningCheck || runCheck.isPending ? 'animate-spin' : ''}`} />
            Run Check Now
          </Button>
        )}
      </div>

      <NotificationRecipients />

      <section className="border-t border-border pt-6">
        <div className="mb-4 max-w-3xl">
          <h2 className="text-lg font-semibold">Delivery history</h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Delivery history for allocated-pool and member-limit notifications, including recipients and failures.
            Test sends reuse the selected alert without changing threshold state.
          </p>
        </div>
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-16 bg-muted animate-pulse-glow rounded" />
              ))}
            </div>
          ) : isError && !alerts ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              Email activity is unavailable.
              <Button variant="outline" className="ml-3" onClick={() => refetch()}>Retry</Button>
            </div>
          ) : (alerts ?? []).length > 0 ? (
            <div className="border-y border-border">
              {(alerts ?? []).map((alert) => (
                <div
                  key={alert.id}
                  className="flex flex-wrap items-start gap-3 border-b border-border px-1 py-4 last:border-b-0 sm:flex-nowrap md:gap-4"
                  data-testid={`alert-${alert.id}`}
                >
                  <div className="flex-shrink-0 mt-1">
                    {alert.status === 'sent' ? (
                      <CheckCircle className="h-5 w-5 text-chart-1" data-testid={`icon-success-${alert.id}`} />
                    ) : (
                      <XCircle className="h-5 w-5 text-destructive" data-testid={`icon-error-${alert.id}`} />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <span className="break-words font-medium text-sm" data-testid={`text-entity-name-${alert.id}`}>
                        {alert.entityName}
                      </span>
                      <span className="text-xs capitalize text-muted-foreground">
                        {alert.entityType}
                      </span>
                      {alert.alertType === 'member_limit_reached' ? (
                        <Badge
                          variant="destructive"
                          className="text-xs"
                          data-testid={`badge-limit-reached-${alert.id}`}
                        >
                          {alert.blockedMemberCount} {alert.blockedMemberCount === 1 ? 'member' : 'members'} blocked
                        </Badge>
                      ) : (
                        <Badge
                          variant={alert.threshold >= 100 ? 'destructive' : 'outline'}
                          className="font-mono text-xs"
                          data-testid={`badge-threshold-${alert.id}`}
                        >
                          {alert.threshold}% threshold
                        </Badge>
                      )}
                    </div>
                    <div className="text-sm text-muted-foreground space-y-1">
                      {alert.alertType === 'member_limit_reached' ? (
                        <p data-testid={`text-spend-${alert.id}`}>
                          Current-cycle Agent spend for blocked members:{' '}
                          <span className="font-mono">${alert.spendUsd.toFixed(2)}</span> across{' '}
                          <span className="font-mono">{alert.blockedMemberCount}</span>{' '}
                          {alert.blockedMemberCount === 1 ? 'member' : 'members'}
                        </p>
                      ) : (
                        <p data-testid={`text-spend-${alert.id}`}>
                          Send-time snapshot: <span className="font-mono">${alert.spendUsd.toFixed(2)}</span> / Allocated pool:{' '}
                          <span className="font-mono">${alert.budgetUsd.toFixed(2)}</span>
                        </p>
                      )}
                      <p className="break-words" data-testid={`text-recipients-${alert.id}`}>
                        Recipients: {alert.recipients.join(', ')}
                      </p>
                    </div>
                  </div>
                  <div className="flex w-full flex-shrink-0 flex-wrap items-center justify-between gap-2 pl-8 sm:w-auto sm:flex-col sm:items-end sm:pl-0">
                    <span className="text-xs text-muted-foreground" data-testid={`text-time-${alert.id}`}>
                      {formatDistanceToNow(new Date(alert.sentAt), { addSuffix: true })}
                    </span>
                    {canTestEmail && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleSendTest(alert.id, alert.entityName)}
                        disabled={sendTest.isPending}
                        aria-label={`Send test email for ${alert.entityName}`}
                        data-testid={`button-send-test-${alert.id}`}
                      >
                        <Send className={`h-3.5 w-3.5 mr-1.5 ${testingAlertId === alert.id ? 'animate-pulse' : ''}`} />
                        {testingAlertId === alert.id ? 'Sending…' : 'Send test'}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="border-y border-border py-10 text-muted-foreground" data-testid="text-no-alerts">
              <div className="max-w-lg">
                <p className="font-medium">{beforeId ? 'No older alerts' : 'No alerts sent yet'}</p>
                <p className="text-sm mt-1">
                  Alerts will appear here when allocated pools cross thresholds or members reach Agent limits
                </p>
              </div>
            </div>
          )}
          {isError && alerts && (
            <p className="text-sm text-muted-foreground">Refresh failed. Showing the last successful history page. <button className="underline" onClick={() => refetch()}>Retry</button></p>
          )}
          <div className="flex flex-col items-stretch justify-between gap-3 pt-4 min-[390px]:flex-row min-[390px]:items-center">
            <span className="text-xs text-muted-foreground">Page {cursors.length} · up to 100 records per page</span>
            <div className="flex gap-2">
              <Button className="flex-1" variant="outline" disabled={cursors.length === 1 || isLoading} onClick={() => setCursors((current) => current.slice(0, -1))}>Previous</Button>
              <Button className="flex-1" variant="outline" disabled={isLoading || !alerts || alerts.length < 100} onClick={() => setCursors((current) => [...current, alerts?.at(-1)?.id])}>Next</Button>
            </div>
          </div>
      </section>
    </div>
  );
}
