import { useState } from 'react';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  RefreshCw,
  Send,
  ShieldCheck,
} from 'lucide-react';
import {
  useListAlerts,
  useRunAlertCheck,
  useSendTestAlert,
  getListAlertsQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable, EmptyState, StatusBadge } from '@/components/journey-primitives';
import { useToast } from '@/hooks/use-toast';
import { useAuthContext } from '@/components/auth-context';
import { NotificationRecipients } from '@/components/notification-recipients';
import { cn } from '@/lib/utils';

interface LastCheck {
  checkedGroups: number;
  alertsSent: number;
  completedAt: Date;
}

const formatMoney = (value: number) =>
  `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const formatDate = (value: string) =>
  new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));

export default function Alerts() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { canTestEmail, capabilities } = useAuthContext();
  const [runningCheck, setRunningCheck] = useState(false);
  const [testingAlertId, setTestingAlertId] = useState<number | null>(null);
  const [lastCheck, setLastCheck] = useState<LastCheck | null>(null);
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
        setLastCheck({
          checkedGroups: result.checkedGroups,
          alertsSent: result.alertsSent,
          completedAt: new Date(),
        });
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

  const history = alerts ?? [];

  const activityCell = (
    alert: (typeof history)[number],
    includeTestIds = false,
    includeRowTestId = includeTestIds,
  ) => (
    <div className="min-w-[210px]" {...(includeRowTestId ? { 'data-testid': `alert-${alert.id}` } : {})}>
      <div className="flex items-center gap-2 font-medium">
        <span className={cn('h-2 w-2 rounded-full', alert.status === 'sent' ? 'bg-emerald-600' : 'bg-red-600')} />
        <span
          className="break-words"
          {...(includeTestIds ? { 'data-testid': `text-entity-name-${alert.id}` } : {})}
        >
          {alert.entityName}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="capitalize">{alert.entityType}</span>
        {alert.alertType === 'member_limit_reached' ? (
          <Badge
            variant="destructive"
            className="text-[10px]"
            {...(includeTestIds ? { 'data-testid': `badge-limit-reached-${alert.id}` } : {})}
          >
            {alert.blockedMemberCount} {alert.blockedMemberCount === 1 ? 'member' : 'members'} blocked
          </Badge>
        ) : (
          <Badge
            variant={alert.threshold >= 100 ? 'destructive' : 'outline'}
            className="font-mono text-[10px]"
            {...(includeTestIds ? { 'data-testid': `badge-threshold-${alert.id}` } : {})}
          >
            {alert.threshold}% threshold
          </Badge>
        )}
      </div>
    </div>
  );

  return (
    <div className="mx-auto max-w-[1280px] space-y-8 px-4 py-6 md:px-8 md:py-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0 space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl" data-testid="text-alerts-title">
            Email activity
          </h1>
          <p className="text-sm text-muted-foreground">
            Review recipients, delivery history, and authorized operational checks
          </p>
        </div>
        {capabilities.canRunChecks && (
          <Button
            onClick={handleRunCheck}
            disabled={runningCheck || runCheck.isPending}
            data-testid="button-run-check"
            className="w-full min-w-[142px] sm:w-auto"
          >
            <RefreshCw className={cn('mr-2 h-4 w-4', (runningCheck || runCheck.isPending) && 'animate-spin')} />
            {runningCheck || runCheck.isPending ? 'Checking…' : 'Run Check Now'}
          </Button>
        )}
      </div>

      <section aria-label="Notification recipients and operational status" className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <NotificationRecipients />
        <Card className="rounded-md border-primary/20 bg-primary/[0.03] shadow-none">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-3">
              <CardDescription>Operational check</CardDescription>
              {capabilities.canRunChecks && (
                <Badge variant="outline" className="gap-1.5 border-emerald-200 bg-emerald-50 text-emerald-700">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Authorized
                </Badge>
              )}
            </div>
            <CardTitle className="text-base">Budget alerts monitored</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-emerald-700">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              {lastCheck
                ? `Last check ${formatDistanceToNow(lastCheck.completedAt, { addSuffix: true })}`
                : 'Ready for the next authorized check'}
            </div>
            <div className="flex items-center justify-between gap-3 border-t pt-3 text-xs text-muted-foreground">
              {lastCheck ? (
                <>
                  <span>{lastCheck.checkedGroups} groups checked</span>
                  <span>{lastCheck.alertsSent} alerts sent</span>
                </>
              ) : (
                <span>Results from a manual check will appear here</span>
              )}
            </div>
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="history-heading" className="border-t pt-7">
        <div className="mb-5 max-w-3xl">
          <div className="flex items-center gap-2">
            <h2 id="history-heading" className="text-xl font-semibold">Delivery history</h2>
            {!isLoading && (
              <Badge variant="secondary" className="font-mono text-[11px]">
                {history.length} {history.length === 1 ? 'record' : 'records'}
              </Badge>
            )}
          </div>
          <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
            Delivery history for allocated-pool and member-limit notifications, including recipients and failures.
            Test sends reuse the selected alert without changing threshold state.
          </p>
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((item) => (
              <div key={item} className="h-16 animate-pulse-glow rounded-md bg-muted" />
            ))}
          </div>
        ) : isError && !alerts ? (
          <EmptyState
            title="Email activity is unavailable"
            description="The delivery history could not be loaded. Retry to request it again."
            action={<Button variant="outline" onClick={() => refetch()}>Retry</Button>}
          />
        ) : history.length > 0 ? (
          <>
            <div className="hidden md:block">
              <DataTable
                caption="Alert delivery history"
                columns={[
                  { label: 'Activity' },
                  { label: 'Send-time snapshot', className: 'w-[220px]' },
                  { label: 'Recipients', className: 'w-[270px]' },
                  { label: 'Status', className: 'w-[150px]' },
                  { label: '', className: 'w-[118px]' },
                ]}
                rows={history.map((alert) => [
                  activityCell(alert, true),
                  <div
                    className="space-y-1 text-xs"
                    data-testid={`text-spend-${alert.id}`}
                  >
                    <div className="font-mono text-sm">
                      {formatMoney(alert.spendUsd)}
                      {alert.alertType !== 'member_limit_reached' ? ` / ${formatMoney(alert.budgetUsd)}` : ''}
                    </div>
                    <div className="text-muted-foreground" data-testid={`text-time-${alert.id}`}>
                      {formatDate(alert.sentAt)}
                    </div>
                  </div>,
                  <div
                    className="max-w-[255px] truncate text-xs text-muted-foreground"
                    title={alert.recipients.join(', ')}
                    data-testid={`text-recipients-${alert.id}`}
                  >
                    {alert.recipients.join(', ')}
                  </div>,
                  <div className="flex items-center gap-2">
                    {alert.status === 'sent' ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-700" data-testid={`icon-success-${alert.id}`} />
                    ) : (
                      <CircleAlert className="h-4 w-4 text-red-700" data-testid={`icon-error-${alert.id}`} />
                    )}
                    <StatusBadge status={alert.status === 'sent' ? 'Sent' : 'Failed'} />
                  </div>,
                  canTestEmail ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleSendTest(alert.id, alert.entityName)}
                      disabled={sendTest.isPending}
                      aria-label={`Send test email for ${alert.entityName}`}
                      data-testid={`button-send-test-${alert.id}`}
                    >
                      {testingAlertId === alert.id ? (
                        <><Clock3 className="mr-1.5 h-3.5 w-3.5 animate-pulse" />Sending…</>
                      ) : (
                        <><Send className="mr-1.5 h-3.5 w-3.5" />Send test</>
                      )}
                    </Button>
                  ) : null,
                ])}
              />
            </div>

            <div className="space-y-3 md:hidden">
              {history.map((alert) => (
                <Card
                  key={alert.id}
                  className="rounded-md shadow-none"
                  data-testid={`alert-${alert.id}-mobile`}
                >
                  <CardContent className="space-y-3 p-4">
                    <div className="flex items-start justify-between gap-3">
                      {activityCell(alert, true, false)}
                      {alert.status === 'sent' ? (
                        <CheckCircle2
                          className="h-4 w-4 shrink-0 text-emerald-700"
                          data-testid={`icon-success-${alert.id}`}
                        />
                      ) : (
                        <CircleAlert
                          className="h-4 w-4 shrink-0 text-red-700"
                          data-testid={`icon-error-${alert.id}`}
                        />
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-3 border-y py-3 text-xs">
                      <div data-testid={`text-spend-${alert.id}`}>
                        <span className="text-muted-foreground">Snapshot</span>
                        <p className="mt-1 font-mono">
                          {formatMoney(alert.spendUsd)}
                          {alert.alertType !== 'member_limit_reached' ? ` / ${formatMoney(alert.budgetUsd)}` : ''}
                        </p>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Sent</span>
                        <p className="mt-1" data-testid={`text-time-${alert.id}`}>
                          {formatDate(alert.sentAt)}
                        </p>
                      </div>
                    </div>
                    <p
                      className="truncate text-xs text-muted-foreground"
                      title={alert.recipients.join(', ')}
                      data-testid={`text-recipients-${alert.id}`}
                    >
                      {alert.recipients.join(', ')}
                    </p>
                    {canTestEmail && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => handleSendTest(alert.id, alert.entityName)}
                        disabled={sendTest.isPending}
                        aria-label={`Send test email for ${alert.entityName}`}
                        data-testid={`button-send-test-${alert.id}`}
                      >
                        {testingAlertId === alert.id ? 'Sending…' : 'Send test email'}
                      </Button>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </>
        ) : (
          <div data-testid="text-no-alerts">
            <EmptyState
              title={beforeId ? 'No older alerts' : 'No alerts sent yet'}
              description="Alerts will appear here when allocated pools cross thresholds or members reach Agent limits."
            />
          </div>
        )}

        {isError && alerts && (
          <p className="mt-4 text-sm text-muted-foreground">
            Refresh failed. Showing the last successful history page.{' '}
            <button className="underline" onClick={() => refetch()}>Retry</button>
          </p>
        )}
        <div className="flex flex-col items-stretch justify-between gap-3 pt-4 min-[390px]:flex-row min-[390px]:items-center">
          <span className="text-xs text-muted-foreground">
            Page {cursors.length} · up to 100 records per page
          </span>
          <div className="flex gap-2">
            <Button
              className="flex-1"
              variant="outline"
              size="sm"
              disabled={cursors.length === 1 || isLoading}
              onClick={() => setCursors((current) => current.slice(0, -1))}
            >
              <ChevronLeft className="mr-1 h-4 w-4" />
              Previous
            </Button>
            <Button
              className="flex-1"
              variant="outline"
              size="sm"
              disabled={isLoading || !alerts || alerts.length < 100}
              onClick={() => setCursors((current) => [...current, alerts?.at(-1)?.id])}
            >
              Next
              <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}