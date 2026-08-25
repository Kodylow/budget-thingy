import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Bell, RefreshCw, CheckCircle, XCircle, Send } from 'lucide-react';
import {
  useListAlerts,
  useRunAlertCheck,
  useSendTestAlert,
  getListAlertsQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { formatDistanceToNow } from 'date-fns';
import { useAuthContext, useCanWrite } from '@/components/auth-context';
import { NotificationRecipients } from '@/components/notification-recipients';

export default function Alerts() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const canWrite = useCanWrite();
  const { isAccountAdmin } = useAuthContext();
  const [runningCheck, setRunningCheck] = useState(false);
  const [testingAlertId, setTestingAlertId] = useState<number | null>(null);

  const { data: alerts, isLoading } = useListAlerts({ limit: 100 });
  const runCheck = useRunAlertCheck();
  const sendTest = useSendTestAlert();

  const handleRunCheck = () => {
    setRunningCheck(true);
    runCheck.mutate(undefined, {
      onSuccess: (result) => {
        queryClient.invalidateQueries({ queryKey: getListAlertsQueryKey({ limit: 100 }) });
        toast({
          title: 'Alert check completed',
          description: `Checked ${result.checkedGroups} groups, sent ${result.alertsSent} alerts`,
        });
        setRunningCheck(false);
      },
      onError: () => {
        toast({
          title: 'Alert check failed',
          variant: 'destructive',
        });
        setRunningCheck(false);
      },
    });
  };

  const handleSendTest = (alertId: number, entityName: string) => {
    setTestingAlertId(alertId);
    sendTest.mutate(
      { alertId },
      {
        onSuccess: (activity) => {
          queryClient.invalidateQueries({ queryKey: getListAlertsQueryKey({ limit: 100 }) });
          if (activity.status === 'sent') {
            toast({
              title: 'Test email sent',
              description: `${entityName}: ${activity.recipients.join(', ')}`,
            });
          } else {
            toast({
              title: 'Test email failed',
              description: activity.errorMessage || 'The failure was added to Email Activity.',
              variant: 'destructive',
            });
          }
          setTestingAlertId(null);
        },
        onError: () => {
          queryClient.invalidateQueries({ queryKey: getListAlertsQueryKey({ limit: 100 }) });
          toast({
            title: 'Test email failed',
            description: 'The failed delivery was added to Email Activity.',
            variant: 'destructive',
          });
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
            Notifications
          </h1>
          <p className="text-muted-foreground mt-1 text-sm md:text-base">
            Manage recipients and track budget threshold email delivery
          </p>
        </div>
        {canWrite && (
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

      <Card>
        <CardHeader className="px-4 py-4 md:px-6 md:py-6">
          <CardTitle>Email Activity</CardTitle>
          <CardDescription>
            Delivery history for threshold notifications, including recipients and failures.
            Test sends reuse the selected alert without changing threshold state; in development,
            actual delivery is routed only to kody.low@repl.it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-16 bg-muted animate-pulse-glow rounded" />
              ))}
            </div>
          ) : alerts && alerts.length > 0 ? (
            <div className="space-y-3">
              {alerts.map((alert) => (
                <div
                  key={alert.id}
                  className="flex flex-wrap sm:flex-nowrap items-start gap-3 md:gap-4 p-3 md:p-4 rounded-lg border border-border hover:bg-muted/50 transition-colors"
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
                      <span className="font-medium text-sm" data-testid={`text-entity-name-${alert.id}`}>
                        {alert.entityName}
                      </span>
                      <Badge variant="secondary" className="text-[10px] capitalize">
                        {alert.entityType}
                      </Badge>
                      <Badge
                        variant={alert.threshold >= 100 ? 'destructive' : 'outline'}
                        className="font-mono text-xs"
                        data-testid={`badge-threshold-${alert.id}`}
                      >
                        {alert.threshold}% threshold
                      </Badge>
                    </div>
                    <div className="text-sm text-muted-foreground space-y-1">
                      <p data-testid={`text-spend-${alert.id}`}>
                        Send-time snapshot: <span className="font-mono">${alert.spendUsd.toFixed(2)}</span> / Allocated pool:{' '}
                        <span className="font-mono">${alert.budgetUsd.toFixed(2)}</span>
                      </p>
                      <p data-testid={`text-current-spend-${alert.id}`}>
                        Current canonical spend:{' '}
                        {alert.currentUsageComplete && alert.currentSpendUsd != null ? (
                          <>
                            <span className="font-mono">${alert.currentSpendUsd.toFixed(2)}</span>
                            {alert.currentPercentUsed != null && (
                              <span className="font-mono"> ({alert.currentPercentUsed.toFixed(1)}%)</span>
                            )}
                          </>
                        ) : (
                          <span>Loading…</span>
                        )}
                      </p>
                      <p className="break-words" data-testid={`text-recipients-${alert.id}`}>
                        Recipients: {alert.recipients.join(', ')}
                      </p>
                      {alert.errorMessage && (
                        <p className="text-destructive text-xs" data-testid={`text-error-${alert.id}`}>
                          Error: {alert.errorMessage}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="w-full pl-8 sm:w-auto sm:pl-0 flex-shrink-0 flex sm:flex-col items-center sm:items-end justify-between gap-2">
                    <span className="text-xs text-muted-foreground" data-testid={`text-time-${alert.id}`}>
                      {formatDistanceToNow(new Date(alert.sentAt), { addSuffix: true })}
                    </span>
                    {isAccountAdmin && (
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
            <div className="text-center py-12 text-muted-foreground flex flex-col items-center gap-3" data-testid="text-no-alerts">
              <Bell className="h-12 w-12 text-muted-foreground/40" />
              <div>
                <p className="font-medium">No alerts sent yet</p>
                <p className="text-sm mt-1">
                  Alerts will appear here when groups or teams cross allocated pool thresholds
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
