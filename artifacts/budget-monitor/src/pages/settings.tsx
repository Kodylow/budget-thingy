import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetEmailSettingsQueryKey,
  getGetSummaryQueryKey,
  getGetStatusQueryKey,
  getListAppAdminsQueryKey,
  useAddAppAdmin,
  useDeleteAppAdmin,
  useGetEmailSettings,
  useGetStatus,
  useGetSummary,
  useListAppAdmins,
  useSendEmailTestExample,
  useUpdateEmailSettings,
  type EmailSettings,
  type EmailTestResult,
  type Summary,
  type SystemStatus,
} from '@workspace/api-client-react';
import { AlertCircle, CheckCircle, Plus, Send, ShieldAlert, Trash2, XCircle } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

import { useAuthContext } from '@/components/auth-context';
import { useRange } from '@/components/range-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { getAutomatedEmailPolicyPresentation, getEmailConnectorPresentation } from '@/lib/email-policy';
import { getEnterpriseApiStatusPresentation } from '@/lib/enterprise-api-status';
import { formatTestEmailLabel, formatTestEmailSpend, getTestEmailResultView } from '@/lib/test-email-helpers';

type EnterprisePresentation = ReturnType<typeof getEnterpriseApiStatusPresentation>;

function SpendAccountingCard({ summary }: { summary?: Summary }) {
  const available = Boolean(
    summary &&
      (summary.usageHealth.status === 'complete' || summary.usageHealth.status === 'stale') &&
      typeof summary.grossSpendUsd === 'number' &&
      typeof summary.excludedInternalSpendUsd === 'number' &&
      typeof summary.eligibleSpendUsd === 'number',
  );
  return (
    <Card data-testid="internal-spend-accounting">
      <CardHeader>
        <CardTitle>Selected range spend accounting</CardTitle>
        <CardDescription>{summary?.billingPeriodLabel ?? 'Active reporting range'}</CardDescription>
      </CardHeader>
      <CardContent>
        {available ? (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono tabular-nums">
            <span>${summary!.grossSpendUsd.toFixed(2)} gross</span>
            <span aria-hidden="true">−</span>
            <span>${summary!.excludedInternalSpendUsd.toFixed(2)} internal</span>
            <span aria-hidden="true">=</span>
            <span className="font-semibold">${summary!.eligibleSpendUsd.toFixed(2)} eligible</span>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Accounting is unavailable until usage for this reporting range is complete.
          </p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Internal Replit user usage remains visible in directory context but is excluded from
          eligible spend, budget consumption, and limit policy calculations.
        </p>
      </CardContent>
    </Card>
  );
}

function TestEmailResult({ result }: { result: EmailTestResult }) {
  const presentation = getTestEmailResultView(result);
  return (
    <div
      className={`rounded-md p-3 border ${
        presentation.tone === 'success'
          ? 'bg-chart-1/10 border-chart-1/20 text-chart-1'
          : 'bg-destructive/10 border-destructive/20 text-destructive'
      }`}
      data-testid="test-email-result"
      role="status"
    >
      <div className="flex items-start gap-2">
        {presentation.tone === 'success'
          ? <CheckCircle className="h-4 w-4 shrink-0 mt-0.5" />
          : <XCircle className="h-4 w-4 shrink-0 mt-0.5" />}
        <div className="space-y-1 text-sm">
          <p className="font-medium">{presentation.title}</p>
          {presentation.tone === 'success' ? (
            <>
              <p>Sender: <span className="font-mono text-xs">{result.senderEmail}</span></p>
              <p>Message ID: <span className="font-mono text-xs">{result.messageId}</span></p>
            </>
          ) : <p>{presentation.detail}</p>}
        </div>
      </div>
    </div>
  );
}

function emailErrorMessage(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('data' in error)) return 'Failed to send test email.';
  const data = error.data;
  if (typeof data !== 'object' || data === null || !('error' in data)) return 'Failed to send test email.';
  return typeof data.error === 'string' ? data.error : 'Failed to send test email.';
}

function TestEmailDialog() {
  const [open, setOpen] = useState(false);
  const [entityType, setEntityType] = useState<'group' | 'team'>('group');
  const [threshold, setThreshold] = useState<50 | 75 | 90 | 100>(100);
  const [result, setResult] = useState<EmailTestResult | null>(null);
  const sendEmailTest = useSendEmailTestExample();
  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) setResult(null);
  };
  const send = () => {
    setResult(null);
    sendEmailTest.mutate({ data: { entityType, threshold } }, {
      onSuccess: setResult,
      onError: (error) => setResult({
        ok: false,
        recipient: '',
        subject: '',
        error: emailErrorMessage(error),
        messageId: null,
        senderEmail: null,
      }),
    });
  };
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="ml-2" data-testid="button-test-email-modal">
          <ShieldAlert className="h-4 w-4 mr-2 text-chart-2" />
          Test Email
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Send Test Email</DialogTitle>
          <DialogDescription>
            Generate a predefined threshold alert example to verify delivery and formatting.
            Delivery uses the server-configured test recipient.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <label className="text-sm font-medium">Entity Type</label>
            <Select value={entityType} onValueChange={(value: 'group' | 'team') => {
              setEntityType(value);
              setResult(null);
            }}>
              <SelectTrigger data-testid="select-test-entity-type"><SelectValue placeholder="Select type" /></SelectTrigger>
              <SelectContent><SelectItem value="group">Group</SelectItem><SelectItem value="team">Team</SelectItem></SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Threshold</label>
            <Select value={threshold.toString()} onValueChange={(value) => {
              setThreshold(Number(value) as 50 | 75 | 90 | 100);
              setResult(null);
            }}>
              <SelectTrigger data-testid="select-test-threshold"><SelectValue placeholder="Select threshold" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="50">50%</SelectItem><SelectItem value="75">75%</SelectItem>
                <SelectItem value="90">90%</SelectItem><SelectItem value="100">100%</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="rounded-md border border-border p-3 bg-muted/30 space-y-1 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Preview Payload</p>
            <p>Entity: <span className="font-mono">{formatTestEmailLabel(entityType)}</span></p>
            <p>Budget: <span className="font-mono">$10,000.00</span></p>
            <p>Spend: <span className="font-mono">${formatTestEmailSpend(threshold).toFixed(2)}</span></p>
          </div>
          {result && <TestEmailResult result={result} />}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setOpen(false)} disabled={sendEmailTest.isPending}>Close</Button>
          <Button onClick={send} disabled={sendEmailTest.isPending} data-testid="button-send-test-email">
            <Send className={`h-4 w-4 mr-2 ${sendEmailTest.isPending ? 'animate-pulse' : ''}`} />
            {sendEmailTest.isPending ? 'Sending...' : 'Send Test'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EnterpriseApiRow({ presentation }: { presentation: EnterprisePresentation }) {
  const icon = presentation.state === 'connected'
    ? <CheckCircle className="h-5 w-5 text-chart-1 shrink-0 mt-0.5 sm:mt-0" />
    : presentation.state === 'pending'
      ? <AlertCircle className="h-5 w-5 text-chart-2 shrink-0 mt-0.5 sm:mt-0" />
      : <XCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5 sm:mt-0" />;
  const detailClass = presentation.state === 'connected'
    ? 'text-xs text-chart-1'
    : presentation.state === 'failed' ? 'text-xs text-destructive' : 'text-xs text-muted-foreground';
  const badgeVariant = presentation.state === 'connected'
    ? 'default' : presentation.state === 'failed' ? 'destructive' : 'secondary';
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-lg border border-border" data-testid="status-enterprise-api">
      <div className="flex items-start sm:items-center gap-3">
        {icon}
        <div><p className="text-sm font-medium">Enterprise API</p><p className={detailClass}>{presentation.detail}</p></div>
      </div>
      <Badge className="w-fit" variant={badgeVariant}>{presentation.badge}</Badge>
    </div>
  );
}

function EmailConnectorRow({ status, canTest }: { status: SystemStatus; canTest: boolean }) {
  const presentation = getEmailConnectorPresentation(status.emailConfigured);
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-lg border border-border" data-testid="status-email-connector">
      <div className="flex items-start sm:items-center gap-3">
        {status.emailConfigured
          ? <CheckCircle className="h-5 w-5 text-chart-1 shrink-0 mt-0.5 sm:mt-0" />
          : <AlertCircle className="h-5 w-5 text-chart-2 shrink-0 mt-0.5 sm:mt-0" />}
        <div><p className="text-sm font-medium">Email Connector</p><p className="text-xs text-muted-foreground">{presentation.detail}</p></div>
      </div>
      <div className="flex items-center gap-2">
        <Badge className="w-fit" variant={status.emailConfigured ? 'default' : 'secondary'}>{presentation.label}</Badge>
        {canTest && <TestEmailDialog />}
      </div>
    </div>
  );
}

function AutomatedEmailRow() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const query = useGetEmailSettings();
  const mutation = useUpdateEmailSettings();
  const settings: EmailSettings | undefined = query.data;
  const presentation = settings
    ? getAutomatedEmailPolicyPresentation(settings.automatedEmailEnabled)
    : null;
  const update = (automatedEmailEnabled: boolean) => {
    mutation.mutate({ data: { automatedEmailEnabled } }, {
      onSuccess: (saved) => {
        queryClient.setQueryData(getGetEmailSettingsQueryKey(), saved);
        queryClient.invalidateQueries({ queryKey: getGetStatusQueryKey() });
        toast({
          title: saved.automatedEmailEnabled ? 'Automated email delivery enabled' : 'Automated email delivery disabled',
          description: saved.automatedEmailEnabled
            ? 'Still-due threshold alerts can send on the next budget check.'
            : 'Budget checks will preserve due alerts without sending them.',
        });
      },
      onError: () => toast({
        variant: 'destructive',
        title: 'Email setting was not saved',
        description: 'The previous automated delivery policy is still active.',
      }),
    });
  };
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-3 rounded-lg border border-border" data-testid="setting-automated-email">
      <div className="flex items-start gap-3">
        {settings?.automatedEmailEnabled
          ? <CheckCircle className="h-5 w-5 text-chart-1 shrink-0 mt-0.5" />
          : <ShieldAlert className="h-5 w-5 text-chart-2 shrink-0 mt-0.5" />}
        <div>
          <label htmlFor="automated-email-toggle" className="text-sm font-medium cursor-pointer">Automated budget-alert delivery</label>
          <p className="text-xs text-muted-foreground mt-0.5">
            {query.isLoading ? 'Loading saved delivery policy…'
              : query.isError ? 'The saved delivery policy could not be loaded.'
                : presentation?.detail}
          </p>
          <p className="text-xs text-muted-foreground mt-1">This does not configure AgentMail or disable the fixed-recipient Test Email.</p>
          {mutation.isError && <p className="text-xs text-destructive mt-1" role="alert">Save failed. The previous policy remains active.</p>}
        </div>
      </div>
      <div className="flex items-center gap-3 self-end sm:self-auto">
        <Badge variant={settings?.automatedEmailEnabled ? 'default' : 'secondary'} data-testid="automated-email-state">
          {mutation.isPending ? 'Saving…' : presentation?.label ?? 'Unknown'}
        </Badge>
        <Switch
          id="automated-email-toggle"
          aria-label="Enable automated budget-alert delivery"
          checked={settings?.automatedEmailEnabled ?? false}
          disabled={query.isLoading || query.isError || !settings || mutation.isPending}
          onCheckedChange={update}
          data-testid="switch-automated-email"
        />
      </div>
    </div>
  );
}

function CheckerRow({ status }: { status: SystemStatus }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-lg border border-border" data-testid="status-checker">
      <div className="flex items-start sm:items-center gap-3">
        <CheckCircle className="h-5 w-5 text-chart-1 shrink-0 mt-0.5 sm:mt-0" />
        <div>
          <p className="text-sm font-medium">Background Checker</p>
          <p className="text-xs text-muted-foreground">
            Runs every {status.checkerIntervalMinutes} minutes
            {status.lastCheckAt && <> · Last successful evaluation {formatDistanceToNow(new Date(status.lastCheckAt), { addSuffix: true })}</>}
            {status.lastEvaluatedDataAsOf && <> · Data through {new Date(status.lastEvaluatedDataAsOf).toLocaleString()}</>}
            {status.lastCheckerSkipReason && <> · Last attempt skipped: {status.lastCheckerSkipReason}</>}
          </p>
        </div>
      </div>
      <Badge className="w-fit" variant="default">Active</Badge>
    </div>
  );
}

function BillingPeriodRow({ status }: { status: SystemStatus }) {
  const warning = status.billingPeriodFallback || !status.billingPeriodFresh;
  const freshness = status.billingPeriodFallback
    ? 'Using the safe fallback until Enterprise billing metadata is available.'
    : status.billingPeriodFresh
      ? `Resolved ${formatDistanceToNow(new Date(status.billingPeriodFetchedAt!), { addSuffix: true })}`
      : 'Stored billing metadata is more than 24 hours old.';
  return (
    <div className="flex flex-col gap-3 p-3 rounded-lg border border-border" data-testid="status-billing-period">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          {warning
            ? <AlertCircle className="h-5 w-5 text-chart-2 shrink-0 mt-0.5" />
            : <CheckCircle className="h-5 w-5 text-chart-1 shrink-0 mt-0.5" />}
          <div>
            <p className="text-sm font-medium">Enterprise Billing Period</p>
            <p className="text-xs text-muted-foreground">{status.billingPeriodLabel}</p>
            <p className="text-xs text-muted-foreground mt-1">Reporting range: {status.reportingRangeLabel}</p>
            <p className="text-xs text-muted-foreground mt-1">{freshness}</p>
          </div>
        </div>
        <Badge variant={warning ? 'secondary' : 'default'}>
          {status.billingPeriodFallback ? 'Fallback' : status.billingPeriodFresh ? 'Current' : 'Stale'}
        </Badge>
      </div>
      {status.billingPeriodDiffersFromReportingCutoff && (
        <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs">
          The Enterprise billing period starts on {new Date(status.billingPeriodStart).toLocaleDateString()}.
          The default dashboard now starts there instead of using the earlier May 20 data-availability cutoff.
        </div>
      )}
    </div>
  );
}

function EnterpriseGuidance({ presentation }: { presentation: EnterprisePresentation }) {
  if (!presentation.guidance) return null;
  const danger = presentation.state === 'failed' || presentation.state === 'missing';
  return (
    <div className={danger
      ? 'p-4 rounded-lg bg-destructive/10 border border-destructive/20 flex items-start gap-3'
      : 'p-4 rounded-lg bg-muted border border-border flex items-start gap-3'}>
      <AlertCircle className={danger ? 'h-5 w-5 text-destructive mt-0.5' : 'h-5 w-5 text-chart-2 mt-0.5'} />
      <div className="flex-1">
        <p className={danger ? 'text-sm font-medium text-destructive' : 'text-sm font-medium'}>{presentation.calloutTitle}</p>
        <p className="text-xs text-muted-foreground mt-1">{presentation.guidance}</p>
      </div>
    </div>
  );
}

function SystemStatusContent({ status, canTest }: { status: SystemStatus; canTest: boolean }) {
  const enterprise = getEnterpriseApiStatusPresentation(status);
  return (
    <div className="space-y-4">
      <EnterpriseApiRow presentation={enterprise} />
      <EmailConnectorRow status={status} canTest={canTest} />
      <AutomatedEmailRow />
      <CheckerRow status={status} />
      <BillingPeriodRow status={status} />
      <EnterpriseGuidance presentation={enterprise} />
    </div>
  );
}

function SystemStatusCard({ canTest }: { canTest: boolean }) {
  const query = useGetStatus();
  let content;
  if (query.isLoading) {
    content = <div className="space-y-2">{[1, 2, 3].map((item) => <div key={item} className="h-12 bg-muted animate-pulse-glow rounded" />)}</div>;
  } else if (query.data) {
    content = <SystemStatusContent status={query.data} canTest={canTest} />;
  } else if (query.isError) {
    content = <p className="text-muted-foreground text-sm">System status is unavailable.</p>;
  } else {
    content = <p className="text-muted-foreground text-sm">No system status is available.</p>;
  }
  return (
    <Card>
      <CardHeader className="px-4 py-4 md:px-6 md:py-6">
        <CardTitle>System Status</CardTitle>
        <CardDescription>Enterprise API connectivity and background checker state</CardDescription>
      </CardHeader>
      <CardContent className="px-4 pb-4 md:px-6 md:pb-6">{content}</CardContent>
    </Card>
  );
}

function AdministratorsCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [userIdDraft, setUserIdDraft] = useState('');
  const query = useListAppAdmins();
  const addEditor = useAddAppAdmin();
  const deleteEditor = useDeleteAppAdmin();
  const add = () => {
    const userId = userIdDraft.trim();
    if (!userId) return;
    addEditor.mutate({ data: { userId } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAppAdminsQueryKey() });
        setUserIdDraft('');
        toast({ title: 'Editor added', description: 'Account-wide pool access is now enabled.' });
      },
    });
  };
  const remove = (userId: string) => deleteEditor.mutate({ userId }, {
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getListAppAdminsQueryKey() });
      toast({ title: 'Editor removed' });
    },
  });
  let list;
  if (query.isLoading) {
    list = <div className="h-12 bg-muted animate-pulse-glow rounded" />;
  } else if (query.isError && !query.data) {
    list = <p className="text-sm text-muted-foreground">Editor data is unavailable.</p>;
  } else if (query.data?.length) {
    list = (
      <div className="space-y-2">
        {query.data.map((editor) => (
          <div key={editor.userId} className="flex items-center justify-between p-3 rounded-lg border border-border">
            <div><p className="text-sm font-medium">{editor.email || editor.userId}</p><p className="text-xs text-muted-foreground font-mono">{editor.userId}</p></div>
            <Button variant="ghost" size="sm" onClick={() => remove(editor.userId)} disabled={deleteEditor.isPending} data-testid={`button-delete-editor-${editor.userId}`}>
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </div>
        ))}
      </div>
    );
  } else {
    list = <p className="text-sm text-muted-foreground">No application administrators configured.</p>;
  }
  return (
    <Card>
      <CardHeader><CardTitle>Application Administrators</CardTitle><CardDescription>Replit users with account-level access to this application.</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Input placeholder="Stable Replit user ID" value={userIdDraft} onChange={(event) => setUserIdDraft(event.target.value)} onKeyDown={(event) => {
            if (event.key === 'Enter') add();
          }} data-testid="input-new-editor" />
          <Button onClick={add} disabled={addEditor.isPending || !userIdDraft.trim()} data-testid="button-add-editor">
            <Plus className="h-4 w-4 mr-2" />Add
          </Button>
        </div>
        {list}
      </CardContent>
    </Card>
  );
}

export default function Settings() {
  const { capabilities, role } = useAuthContext();
  const { rangeType, startDate, endDate } = useRange();
  const summaryParams = { rangeType, ...(rangeType === 'custom' ? { startDate, endDate } : {}) };
  const summary = useGetSummary(summaryParams, {
    query: {
      enabled: role === 'account',
      queryKey: getGetSummaryQueryKey(summaryParams),
    },
  });
  if (!capabilities.canManageAccess) {
    return (
      <div className="p-4 md:p-8" data-testid="settings-forbidden">
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-2">Settings are only available to account administrators.</p>
      </div>
    );
  }
  return (
    <div className="p-4 md:p-8 space-y-4 md:space-y-6 max-w-[100vw]">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight" data-testid="text-settings-title">Settings</h1>
        <p className="text-muted-foreground mt-1 text-sm md:text-base">Manage account access and monitor system status</p>
      </div>
      {role === 'account' && <SpendAccountingCard summary={summary.data} />}
      <SystemStatusCard canTest={capabilities.canManageAccess} />
      <AdministratorsCard />
    </div>
  );
}