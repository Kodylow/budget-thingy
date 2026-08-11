import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Bell, RefreshCw, CheckCircle, XCircle } from 'lucide-react';
import { useListAlerts, useRunAlertCheck, getListAlertsQueryKey } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { formatDistanceToNow } from 'date-fns';
import { useCanWrite } from '@/components/auth-context';

export default function Alerts() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const canWrite = useCanWrite();
  const [runningCheck, setRunningCheck] = useState(false);

  const { data: alerts, isLoading } = useListAlerts({ limit: 100 });
  const runCheck = useRunAlertCheck();

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

  return (
    <div className="p-8 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight" data-testid="text-alerts-title">
            Alerts
          </h1>
          <p className="text-muted-foreground mt-1">
            Email notifications sent when groups cross budget thresholds
          </p>
        </div>
        {canWrite && (
          <Button
            onClick={handleRunCheck}
            disabled={runningCheck || runCheck.isPending}
            data-testid="button-run-check"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${runningCheck || runCheck.isPending ? 'animate-spin' : ''}`} />
            Run Check Now
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Alert History</CardTitle>
          <CardDescription>
            Recent threshold alerts sent to admin emails
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
                  className="flex items-start gap-4 p-4 rounded-lg border border-border hover:bg-muted/50 transition-colors"
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
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-sm" data-testid={`text-group-name-${alert.id}`}>
                        {alert.groupName}
                      </span>
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
                        Spend: <span className="font-mono">${alert.spendUsd.toFixed(2)}</span> / Budget:{' '}
                        <span className="font-mono">${alert.budgetUsd.toFixed(2)}</span>
                      </p>
                      <p data-testid={`text-recipients-${alert.id}`}>
                        Recipients: {alert.recipients.join(', ')}
                      </p>
                      {alert.errorMessage && (
                        <p className="text-destructive text-xs" data-testid={`text-error-${alert.id}`}>
                          Error: {alert.errorMessage}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex-shrink-0 text-xs text-muted-foreground" data-testid={`text-time-${alert.id}`}>
                    {formatDistanceToNow(new Date(alert.sentAt), { addSuffix: true })}
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
                  Alerts will appear here when groups cross budget thresholds
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
