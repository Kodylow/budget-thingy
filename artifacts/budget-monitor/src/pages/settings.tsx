import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { AlertCircle, CheckCircle, RefreshCw, Trash2, Plus, XCircle, Send, ShieldAlert } from 'lucide-react';
import {
  useGetStatus,
  useListEditors,
  useAddEditor,
  useDeleteEditor,
  getListEditorsQueryKey,
  useRebuildUsageRange,
  useSendEmailTestExample,
  type EmailTestResult,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { formatDistanceToNow } from 'date-fns';
import { useAuthContext } from '@/components/auth-context';
import { RangeFilter } from '@/components/range-filter';
import { useRange } from '@/components/range-context';
import { checkCanAccessSettings } from '@/lib/auth-helpers';
import {
  formatTestEmailSpend,
  formatTestEmailLabel,
  getTestEmailResultView,
} from '@/lib/test-email-helpers';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export default function Settings() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { isAccountAdmin, realIsAccountAdmin, canTestEmail } = useAuthContext();
  const canAccessSettings = checkCanAccessSettings(isAccountAdmin, realIsAccountAdmin, canTestEmail);
  const showAdminControls = isAccountAdmin;

  const { rangeType, startDate, endDate } = useRange();
  const [newEditorUserId, setNewEditorUserId] = useState('');

  const [testModalOpen, setTestModalOpen] = useState(false);
  const [testEntityType, setTestEntityType] = useState<'group' | 'team'>('group');
  const [testThreshold, setTestThreshold] = useState<50 | 75 | 90 | 100>(100);
  const [testResult, setTestResult] = useState<EmailTestResult | null>(null);

  const { data: status, isLoading: statusLoading } = useGetStatus();
  const { data: editors, isLoading: editorsLoading } = useListEditors();
  const addEditor = useAddEditor();
  const deleteEditor = useDeleteEditor();
  const rebuildRange = useRebuildUsageRange();
  const sendEmailTest = useSendEmailTestExample();

  const handleRebuildRange = () => {
    rebuildRange.mutate(
      {
        data: {
          rangeType,
          ...(rangeType === 'custom' ? { startDate, endDate } : {}),
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries();
          toast({
            title: 'Range rebuild queued',
            description: 'The selected range will be rebuilt without changing other cached ranges.',
          });
        },
        onError: (error: any) => {
          toast({
            title: 'Unable to rebuild range',
            description: error?.data?.error || 'Check the selected dates and try again.',
            variant: 'destructive',
          });
        },
      },
    );
  };

  const handleAddEditor = () => {
    const userId = newEditorUserId.trim();
    if (!userId) return;
    addEditor.mutate(
      { data: { userId } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListEditorsQueryKey() });
          setNewEditorUserId('');
          toast({ title: 'Editor added', description: 'Account-wide pool access is now enabled.' });
        },
        onError: (error: any) => {
          toast({
            title: 'Failed to add editor',
            description: error?.error || 'Confirm the user has signed in to this app.',
            variant: 'destructive',
          });
        },
      },
    );
  };

  const handleDeleteEditor = (userId: string) => {
    deleteEditor.mutate(
      { userId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListEditorsQueryKey() });
          toast({ title: 'Editor removed' });
        },
        onError: () => toast({ title: 'Failed to remove editor', variant: 'destructive' }),
      },
    );
  };

  const handleSendTestEmail = () => {
    setTestResult(null);
    sendEmailTest.mutate(
      { data: { entityType: testEntityType, threshold: testThreshold } },
      {
        onSuccess: (result) => {
          setTestResult(result);
        },
        onError: (error: any) => {
          setTestResult({
            ok: false,
            recipient: 'kody.low@repl.it',
            subject: '',
            error: error?.data?.error || 'Failed to send test email.',
            messageId: null,
            senderEmail: null,
          });
        },
      }
    );
  };

  const handleModalOpenChange = (open: boolean) => {
    setTestModalOpen(open);
    if (open) {
      setTestResult(null);
    }
  };

  if (!canAccessSettings) {
    return (
      <div className="p-4 md:p-8" data-testid="settings-forbidden">
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-2">
          Settings are only available to account administrators.
        </p>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 space-y-4 md:space-y-6 max-w-[100vw]">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight" data-testid="text-settings-title">
          Settings
        </h1>
        <p className="text-muted-foreground mt-1 text-sm md:text-base">
          Manage account access and monitor system status
        </p>
      </div>

      <Card>
        <CardHeader className="px-4 py-4 md:px-6 md:py-6">
          <CardTitle>System Status</CardTitle>
          <CardDescription>
            Enterprise API connectivity and background checker state
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4 pb-4 md:px-6 md:pb-6">
          {statusLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 bg-muted animate-pulse-glow rounded" />
              ))}
            </div>
          ) : status ? (
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-lg border border-border" data-testid="status-enterprise-api">
                <div className="flex items-start sm:items-center gap-3">
                  {status.enterpriseApiConfigured && status.enterpriseApiOk ? (
                    <CheckCircle className="h-5 w-5 text-chart-1 shrink-0 mt-0.5 sm:mt-0" />
                  ) : (
                    <XCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5 sm:mt-0" />
                  )}
                  <div>
                    <p className="text-sm font-medium">Enterprise API</p>
                    {!status.enterpriseApiConfigured ? (
                      <p className="text-xs text-muted-foreground">Not configured</p>
                    ) : status.enterpriseApiOk ? (
                      <p className="text-xs text-chart-1">Connected</p>
                    ) : (
                      <p className="text-xs text-destructive">{status.enterpriseApiError || 'Connection failed'}</p>
                    )}
                  </div>
                </div>
                <Badge className="w-fit" variant={status.enterpriseApiConfigured && status.enterpriseApiOk ? 'default' : 'destructive'}>
                  {status.enterpriseApiConfigured && status.enterpriseApiOk ? 'OK' : 'Error'}
                </Badge>
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-lg border border-border" data-testid="status-email">
                <div className="flex items-start sm:items-center gap-3">
                  {status.emailConfigured ? (
                    <CheckCircle className="h-5 w-5 text-chart-1 shrink-0 mt-0.5 sm:mt-0" />
                  ) : (
                    <AlertCircle className="h-5 w-5 text-chart-2 shrink-0 mt-0.5 sm:mt-0" />
                  )}
                  <div>
                    <p className="text-sm font-medium">Email Sending</p>
                    <p className="text-xs text-muted-foreground">
                      {status.emailConfigured ? 'Configured' : 'Not configured'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge className="w-fit" variant={status.emailConfigured ? 'default' : 'secondary'}>
                    {status.emailConfigured ? 'OK' : 'Not Set'}
                  </Badge>
                  {canTestEmail && (
                    <Dialog open={testModalOpen} onOpenChange={handleModalOpenChange}>
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
                            This is routed only to kody.low@repl.it.
                          </DialogDescription>
                        </DialogHeader>
                        <div className="space-y-4 py-2">
                          <div className="space-y-2">
                            <label className="text-sm font-medium">Entity Type</label>
                            <Select
                              value={testEntityType}
                              onValueChange={(val: any) => { setTestEntityType(val); setTestResult(null); }}
                            >
                              <SelectTrigger data-testid="select-test-entity-type">
                                <SelectValue placeholder="Select type" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="group">Group</SelectItem>
                                <SelectItem value="team">Team</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-2">
                            <label className="text-sm font-medium">Threshold</label>
                            <Select
                              value={testThreshold.toString()}
                              onValueChange={(val: any) => { setTestThreshold(Number(val) as any); setTestResult(null); }}
                            >
                              <SelectTrigger data-testid="select-test-threshold">
                                <SelectValue placeholder="Select threshold" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="50">50%</SelectItem>
                                <SelectItem value="75">75%</SelectItem>
                                <SelectItem value="90">90%</SelectItem>
                                <SelectItem value="100">100%</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>

                          <div className="rounded-md border border-border p-3 bg-muted/30 space-y-1 text-sm text-muted-foreground">
                            <p className="font-medium text-foreground">Preview Payload</p>
                            <p>Entity: <span className="font-mono">{formatTestEmailLabel(testEntityType)}</span></p>
                            <p>Budget: <span className="font-mono">$10,000.00</span></p>
                            <p>Spend: <span className="font-mono">${formatTestEmailSpend(testThreshold).toFixed(2)}</span></p>
                          </div>

                          {testResult && (() => {
                            const presentation = getTestEmailResultView(testResult);
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
                                {presentation.tone === 'success' ? (
                                  <CheckCircle className="h-4 w-4 shrink-0 mt-0.5" />
                                ) : (
                                  <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
                                )}
                                <div className="space-y-1 text-sm">
                                  <p className="font-medium">{presentation.title}</p>
                                  {presentation.tone === 'success' ? (
                                    <>
                                      <p>Sender: <span className="font-mono text-xs">{testResult.senderEmail}</span></p>
                                      <p>Message ID: <span className="font-mono text-xs">{testResult.messageId}</span></p>
                                    </>
                                  ) : (
                                    <p>{presentation.detail}</p>
                                  )}
                                </div>
                              </div>
                            </div>
                            );
                          })()}
                        </div>
                        <DialogFooter>
                          <Button
                            variant="secondary"
                            onClick={() => setTestModalOpen(false)}
                            disabled={sendEmailTest.isPending}
                          >
                            Close
                          </Button>
                          <Button
                            onClick={handleSendTestEmail}
                            disabled={sendEmailTest.isPending}
                            data-testid="button-send-test-email"
                          >
                            <Send className={`h-4 w-4 mr-2 ${sendEmailTest.isPending ? 'animate-pulse' : ''}`} />
                            {sendEmailTest.isPending ? 'Sending...' : 'Send Test'}
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  )}
                </div>
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-lg border border-border" data-testid="status-checker">
                <div className="flex items-start sm:items-center gap-3">
                  <CheckCircle className="h-5 w-5 text-chart-1 shrink-0 mt-0.5 sm:mt-0" />
                  <div>
                    <p className="text-sm font-medium">Background Checker</p>
                    <p className="text-xs text-muted-foreground">
                      Runs every {status.checkerIntervalMinutes} minutes
                      {status.lastCheckAt && (
                        <> · Last successful evaluation {formatDistanceToNow(new Date(status.lastCheckAt), { addSuffix: true })}</>
                      )}
                      {status.lastEvaluatedDataAsOf && (
                        <> · Data through {new Date(status.lastEvaluatedDataAsOf).toLocaleString()}</>
                      )}
                      {status.lastCheckerSkipReason && (
                        <> · Last attempt skipped: {status.lastCheckerSkipReason}</>
                      )}
                    </p>
                  </div>
                </div>
                <Badge className="w-fit" variant="default">Active</Badge>
              </div>

              <div
                className="flex flex-col gap-3 p-3 rounded-lg border border-border"
                data-testid="status-billing-period"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    {status.billingPeriodFallback || !status.billingPeriodFresh ? (
                      <AlertCircle className="h-5 w-5 text-chart-2 shrink-0 mt-0.5" />
                    ) : (
                      <CheckCircle className="h-5 w-5 text-chart-1 shrink-0 mt-0.5" />
                    )}
                    <div>
                      <p className="text-sm font-medium">Enterprise Billing Period</p>
                      <p className="text-xs text-muted-foreground">{status.billingPeriodLabel}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Reporting range: {status.reportingRangeLabel}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {status.billingPeriodFallback
                          ? 'Using the safe fallback until Enterprise billing metadata is available.'
                          : status.billingPeriodFresh
                            ? `Resolved ${formatDistanceToNow(new Date(status.billingPeriodFetchedAt!), { addSuffix: true })}`
                            : 'Stored billing metadata is more than 24 hours old.'}
                      </p>
                    </div>
                  </div>
                  <Badge variant={status.billingPeriodFallback || !status.billingPeriodFresh ? 'secondary' : 'default'}>
                    {status.billingPeriodFallback ? 'Fallback' : status.billingPeriodFresh ? 'Current' : 'Stale'}
                  </Badge>
                </div>
                {status.billingPeriodDiffersFromReportingCutoff && (
                  <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs">
                    The Enterprise billing period starts on{' '}
                    {new Date(status.billingPeriodStart).toLocaleDateString()}. The default dashboard
                    now starts there instead of using the earlier May 20 data-availability cutoff.
                  </div>
                )}
              </div>

              <div
                className="flex flex-col gap-3 p-3 rounded-lg border border-border"
                data-testid="status-account-total-verification"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    {!status.accountTotalVerification ||
                    status.accountTotalVerification.outcome === 'failed' ? (
                      <AlertCircle className="h-5 w-5 text-chart-2 shrink-0 mt-0.5" />
                    ) : (
                      <CheckCircle className="h-5 w-5 text-chart-1 shrink-0 mt-0.5" />
                    )}
                    <div>
                      <p className="text-sm font-medium">Account Total Verification</p>
                      {!status.accountTotalVerification ? (
                        <p className="text-xs text-muted-foreground">Not yet verified</p>
                      ) : (
                        <>
                          <p className="text-xs text-muted-foreground">
                            Checked{' '}
                            {formatDistanceToNow(
                              new Date(status.accountTotalVerification.verifiedAt),
                              { addSuffix: true },
                            )}
                            {status.accountTotalVerification.deltaUsd != null
                              ? ` · Delta $${status.accountTotalVerification.deltaUsd.toFixed(2)}`
                              : ''}
                          </p>
                          {status.accountTotalVerification.error && (
                            <p className="text-xs text-destructive mt-1">
                              {status.accountTotalVerification.error}
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                  <Badge
                    variant={
                      !status.accountTotalVerification ||
                      status.accountTotalVerification.outcome === 'failed'
                        ? 'secondary'
                        : 'default'
                    }
                  >
                    {!status.accountTotalVerification
                      ? 'Pending'
                      : status.accountTotalVerification.outcome === 'healed'
                        ? 'Healed'
                        : status.accountTotalVerification.outcome === 'success'
                          ? 'Verified'
                          : 'Failed'}
                  </Badge>
                </div>
              </div>

              {(!status.enterpriseApiConfigured || !status.enterpriseApiOk) && (
                <div className="p-4 rounded-lg bg-destructive/10 border border-destructive/20 flex items-start gap-3">
                  <AlertCircle className="h-5 w-5 text-destructive mt-0.5" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-destructive">Action Required</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Set the REPLIT_ENTERPRISE_API_KEY environment variable to enable usage tracking.
                    </p>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">Unable to load status</p>
          )}
        </CardContent>
      </Card>

      {showAdminControls && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Rebuild Usage Range</CardTitle>
              <CardDescription>
                Re-fetch every usage scope for one range. Existing data remains available if the rebuild fails.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <RangeFilter />
              <Button
                onClick={handleRebuildRange}
                disabled={
                  rebuildRange.isPending ||
                  (rangeType === 'custom' && (!startDate || !endDate))
                }
                data-testid="button-rebuild-range"
              >
                <RefreshCw className={`h-4 w-4 mr-2 ${rebuildRange.isPending ? 'animate-spin' : ''}`} />
                {rebuildRange.isPending ? 'Queueing…' : 'Rebuild selected range'}
              </Button>
            </CardContent>
          </Card>

      <Card>
        <CardHeader>
          <CardTitle>Account-wide Editors</CardTitle>
          <CardDescription>
            Replit users who can edit allocated pools and run checks without managing settings or access.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              placeholder="Stable Replit user ID"
              value={newEditorUserId}
              onChange={(event) => setNewEditorUserId(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleAddEditor();
              }}
              data-testid="input-new-editor"
            />
            <Button
              onClick={handleAddEditor}
              disabled={addEditor.isPending || !newEditorUserId.trim()}
              data-testid="button-add-editor"
            >
              <Plus className="h-4 w-4 mr-2" />
              Add
            </Button>
          </div>
          {editorsLoading ? (
            <div className="h-12 bg-muted animate-pulse-glow rounded" />
          ) : editors && editors.length > 0 ? (
            <div className="space-y-2">
              {editors.map((editor) => (
                <div key={editor.userId} className="flex items-center justify-between p-3 rounded-lg border border-border">
                  <div>
                    <p className="text-sm font-medium">{editor.email || editor.userId}</p>
                    <p className="text-xs text-muted-foreground font-mono">{editor.userId}</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDeleteEditor(editor.userId)}
                    disabled={deleteEditor.isPending}
                    data-testid={`button-delete-editor-${editor.userId}`}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No managed editors configured.</p>
          )}
        </CardContent>
      </Card>
        </>
      )}

    </div>
  );
}
