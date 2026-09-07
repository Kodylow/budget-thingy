import { useMemo, useState, useRef, useCallback, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetTeamAllocationAuditQueryKey,
  getGetTeamBudgetHistoryQueryKey,
  useGetTeamAllocationAudit,
  useGetTeamBudgetHistory,
  useUpdateTeamAnnualAllocation,
  useUpdateTeamVisibility,
  useAddTeamMonthlyAllocation,
  type TeamBudgetHistoryTeam,
} from '@workspace/api-client-react';
import { AlertTriangle, ExternalLink, Eye, EyeOff, Pencil, Plus, Search, ChevronDown, History, ShieldCheck } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useAuthContext } from '@/components/auth-context';
import { invalidateBudgetCaches } from '@/lib/budget-cache';
import { buildAllocationRow, parsePeriod, sumUsd } from '@/lib/allocation-ledger';
import { useToast } from '@/hooks/use-toast';
import {
  allocationPayloadFingerprint,
  filterVisibleAudits,
  filterVisibleTeams,
  getAllocationPermissions,
  normalizeMonthlyAllocation,
  parseAllocationAmount,
  type AllocationDraft,
} from './team-budgets-allocation';

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});

function CellValue({ value, isZeroFaded = true }: { value: number, isZeroFaded?: boolean }) {
  if (value === 0 && isZeroFaded) {
    return <span className="text-muted-foreground/30">—</span>;
  }
  return <span>{currency.format(value)}</span>;
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

function AddAllocationDialog({ teams, onSuccess }: { teams: TeamBudgetHistoryTeam[], onSuccess: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'form' | 'confirm'>('form');

  const [teamName, setTeamName] = useState('');
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [amount, setAmount] = useState('');
  const [formError, setFormError] = useState('');

  const requestRef = useRef<{ payload: string; key: string; draft: AllocationDraft } | null>(null);
  const submittingRef = useRef(false);

  const addMutation = useAddTeamMonthlyAllocation({ mutation: { retry: false } });

  const handleConfirm = () => {
    if (submittingRef.current) return;
    const request = requestRef.current;
    if (!request) {
      setStep('form');
      setFormError('Review the allocation before saving.');
      return;
    }
    submittingRef.current = true;
    addMutation.mutate({
      teamName: request.draft.teamName,
      data: {
        month: request.draft.month,
        amountUsd: request.draft.amountUsd,
        idempotencyKey: request.key
      }
    }, {
      onSuccess: () => {
        onSuccess();
        toast({
          title: 'Monthly addition saved',
          description: `${currency.format(request.draft.amountUsd)} was added to ${request.draft.teamName} for ${request.draft.month}. No platform limit was changed.`,
        });
        setOpen(false);
        setStep('form');
        setTeamName('');
        setAmount('');
        requestRef.current = null;
        setFormError('');
        addMutation.reset();
      },
      onSettled: () => { submittingRef.current = false; },
    });
  };

  const reviewedDraft = requestRef.current?.draft;

  const handleReview = () => {
    const normalized = normalizeMonthlyAllocation(teamName, month, amount);
    if (!normalized.draft) {
      setFormError(normalized.error ?? 'Check the allocation details.');
      return;
    }
    const payload = allocationPayloadFingerprint(normalized.draft);
    if (requestRef.current?.payload !== payload) {
      requestRef.current = { payload, key: crypto.randomUUID(), draft: normalized.draft };
    }
    setFormError('');
    addMutation.reset();
    setStep('confirm');
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!submittingRef.current) setOpen(next); }}>
      <DialogTrigger asChild>
        <Button size="sm" className="w-full sm:w-auto" data-testid="button-new-monthly-allocation"><Plus className="mr-2 h-4 w-4" />New monthly addition</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add monthly funding</DialogTitle>
          <DialogDescription>
            Add a dated entry to the local allocation ledger. This does not change a Replit platform limit.
          </DialogDescription>
        </DialogHeader>

        {step === 'form' ? (
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="allocation-team">Team</Label>
              <Select value={teamName} onValueChange={setTeamName}>
                <SelectTrigger id="allocation-team"><SelectValue placeholder="Select team" /></SelectTrigger>
                <SelectContent className="max-h-[300px]">
                   {teams.map(t => (
                    <SelectItem key={t.teamName} value={t.teamName}>{t.teamName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="allocation-month">Month (YYYY-MM)</Label>
               <Input id="allocation-month" data-testid="input-monthly-allocation-month" type="month" value={month} onChange={e => setMonth(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="allocation-amount">Amount (USD)</Label>
               <Input id="allocation-amount" data-testid="input-monthly-allocation-amount" inputMode="decimal" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" aria-describedby={formError ? 'monthly-allocation-error' : undefined} />
            </div>
             {formError && <p id="monthly-allocation-error" className="text-sm text-destructive" role="alert" data-testid="status-monthly-allocation-validation">{formError}</p>}
          </div>
        ) : (
          <div className="space-y-4 py-4">
             <div className="grid gap-3 rounded-md border bg-muted/30 p-4 text-sm sm:grid-cols-3" data-testid="summary-monthly-allocation-review">
               <div className="min-w-0"><span className="block text-xs text-muted-foreground">Team</span><strong className="break-words">{reviewedDraft?.teamName}</strong></div>
               <div><span className="block text-xs text-muted-foreground">Month</span><strong>{reviewedDraft?.month}</strong></div>
               <div><span className="block text-xs text-muted-foreground">Addition</span><strong>{currency.format(reviewedDraft?.amountUsd ?? 0)}</strong></div>
            </div>
            {addMutation.isError && (
               <Alert variant="destructive" data-testid="status-monthly-allocation-uncertain">
                 <AlertTriangle className="h-4 w-4" />
                 <AlertTitle>Save outcome was not confirmed</AlertTitle>
                 <AlertDescription>
                   {addMutation.error?.message || 'The request did not complete.'} Reopen this dialog if needed, then retry this same addition. Its request ID is retained to prevent a duplicate entry.
                 </AlertDescription>
               </Alert>
            )}
          </div>
        )}

        <DialogFooter>
          {step === 'form' ? (
             <Button onClick={handleReview} data-testid="button-review-monthly-allocation">Review addition</Button>
          ) : (
             <>
               <Button variant="outline" onClick={() => setStep('form')} disabled={addMutation.isPending || addMutation.isError} data-testid="button-back-monthly-allocation">Back</Button>
               <Button onClick={handleConfirm} disabled={addMutation.isPending} data-testid="button-save-monthly-allocation">
                 {addMutation.isPending ? 'Saving…' : addMutation.isError ? 'Retry same addition' : 'Save monthly addition'}
               </Button>
             </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditableOpeningFunding({
  teamName,
  baselineAllocation,
  startingAllocation,
  canEdit,
  onSuccess,
}: {
  teamName: string;
  baselineAllocation: number;
  startingAllocation: number;
  canEdit: boolean;
  onSuccess: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'entry' | 'review'>('entry');
  const [draft, setDraft] = useState(String(baselineAllocation));
  const [reviewedAmount, setReviewedAmount] = useState<number | null>(null);
  const [validationError, setValidationError] = useState('');
  const updateMutation = useUpdateTeamAnnualAllocation({ mutation: { retry: false } });

  if (!canEdit) {
    return (
      <CellValue value={startingAllocation} isZeroFaded={false} />
    );
  }

  const beginEdit = () => {
    setDraft(baselineAllocation.toFixed(2));
    setReviewedAmount(null);
    setValidationError('');
    setStep('entry');
    updateMutation.reset();
  };

  const review = () => {
    const parsed = parseAllocationAmount(draft, { allowZero: true });
    if (parsed.value === undefined) {
      setValidationError(parsed.error ?? 'Enter a valid amount.');
      return;
    }
    setReviewedAmount(parsed.value);
    setValidationError('');
    updateMutation.reset();
    setStep('review');
  };

  const save = () => {
    if (reviewedAmount === null || updateMutation.isPending) return;
    const amountToSave = reviewedAmount;
    updateMutation.mutate({
      teamName,
      data: { annualAllocationUsd: amountToSave },
    }, {
      onSuccess: () => {
        onSuccess();
        toast({
          title: 'Opening funding saved',
          description: `${teamName} now has ${currency.format(amountToSave)} in undated opening funding. No platform limit was changed.`,
        });
        setOpen(false);
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => {
      if (updateMutation.isPending) return;
      setOpen(next);
      if (next) beginEdit();
    }}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          className="ml-auto h-8 gap-2 px-2 font-mono font-normal tabular-nums"
           aria-label={`Edit opening baseline for ${teamName}`}
          data-testid={`button-edit-opening-funding-${teamName}`}
        >
          <CellValue value={startingAllocation} isZeroFaded={false} />
          <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="break-words">Update opening funding</DialogTitle>
          <DialogDescription>
            Change only the undated opening baseline for <span className="break-words">{teamName}</span>. Carried, undated, and January–July additions in the starting allocation are preserved and will not be added twice.
          </DialogDescription>
        </DialogHeader>
        {step === 'entry' ? (
          <div className="space-y-2 py-4">
            <Label htmlFor={`opening-funding-${teamName}`}>Amount (USD)</Label>
            <Input
              id={`opening-funding-${teamName}`}
              autoFocus
              inputMode="decimal"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              aria-describedby={validationError ? `opening-funding-error-${teamName}` : undefined}
              data-testid={`input-opening-funding-${teamName}`}
            />
            {validationError && (
              <p id={`opening-funding-error-${teamName}`} className="text-sm text-destructive" role="alert">
                {validationError}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-4 py-4">
            <div className="grid gap-3 rounded-md border bg-muted/30 p-4 text-sm sm:grid-cols-2" data-testid={`summary-opening-funding-${teamName}`}>
              <div><span className="block text-xs text-muted-foreground">Current opening baseline</span><strong>{currency.format(baselineAllocation)}</strong></div>
              <div><span className="block text-xs text-muted-foreground">Proposed opening baseline</span><strong>{currency.format(reviewedAmount ?? 0)}</strong></div>
              <div><span className="block text-xs text-muted-foreground">Historic additions preserved</span><strong>{currency.format(startingAllocation - baselineAllocation)}</strong></div>
              <div><span className="block text-xs text-muted-foreground">Proposed starting allocation</span><strong>{currency.format((reviewedAmount ?? 0) + startingAllocation - baselineAllocation)}</strong></div>
            </div>
            {updateMutation.isError && (
              <Alert variant="destructive" data-testid={`status-opening-funding-error-${teamName}`}>
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Save outcome not confirmed</AlertTitle>
                <AlertDescription>
                  {updateMutation.error?.message || 'The response may have been lost.'} Refresh current funding before deliberately trying again. This screen will not retry automatically.
                </AlertDescription>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => {
                    onSuccess();
                    setOpen(false);
                  }}
                  data-testid={`button-refresh-opening-funding-${teamName}`}
                >
                  Refresh current funding
                </Button>
              </Alert>
            )}
          </div>
        )}
        <DialogFooter>
          {step === 'entry' ? (
            <Button onClick={review} data-testid={`button-review-opening-funding-${teamName}`}>Review change</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => setStep('entry')} disabled={updateMutation.isPending}>Back</Button>
              <Button
                onClick={save}
                 disabled={updateMutation.isPending || reviewedAmount === baselineAllocation}
                data-testid={`button-save-opening-funding-${teamName}`}
              >
                {updateMutation.isPending ? 'Saving…' : updateMutation.isError ? 'Try save again' : 'Save opening funding'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function TeamBudgets() {
  const { capabilities, authorizationKey, auth, isPreviewing } = useAuthContext();
  const { canEdit, canManageVisibility, canViewAudit } = getAllocationPermissions(capabilities, isPreviewing || auth?.previewReadOnly === true);
  const [auditCursors, setAuditCursors] = useState<Array<number | undefined>>([undefined]);
  const auditBeforeId = auditCursors[auditCursors.length - 1];
  const auditParams = auditBeforeId === undefined ? {} : { beforeId: auditBeforeId };
  useEffect(() => {
    setAuditCursors([undefined]);
  }, [authorizationKey]);

  const queryClient = useQueryClient();
  const historyQuery = useGetTeamBudgetHistory({
    query: { queryKey: getGetTeamBudgetHistoryQueryKey(), refetchOnMount: 'always' },
  });
  const auditQuery = useGetTeamAllocationAudit(auditParams, {
    query: { queryKey: getGetTeamAllocationAuditQueryKey(auditParams), refetchOnMount: 'always', enabled: canViewAudit },
  });

  const teams = useMemo(
    () => filterVisibleTeams([...(historyQuery.data?.teams ?? [])], canManageVisibility)
      .sort((a, b) =>
      a.teamName.localeCompare(b.teamName, 'en', { sensitivity: 'base' })),
    [historyQuery.data?.teams, canManageVisibility],
  );

  const availableYears = useMemo(() => {
    const years = new Set<number>();
    teams.forEach((team) => {
      team.adjustments.forEach((adj) => {
        const p = parsePeriod(adj.submissionPeriod);
        if (!p.unparseable) years.add(p.year);
      });
    });
    const currentYear = new Date().getFullYear();
    years.add(currentYear);
    return Array.from(years).sort((a, b) => b - a);
  }, [teams]);

  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear());
  const [searchQuery, setSearchQuery] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);

  const [optimisticVisibility, setOptimisticVisibility] = useState<Record<string, boolean>>({});

  const updateVisibility = useUpdateTeamVisibility();

  const handleToggleVisibility = useCallback((team: TeamBudgetHistoryTeam) => {
    if (!canManageVisibility) return;
    const previous = optimisticVisibility[team.teamName] ?? team.isHidden;
    const nextValue = !previous;
    setOptimisticVisibility((old) => ({ ...old, [team.teamName]: nextValue }));
    updateVisibility.mutate({ teamName: team.teamName, data: { isHidden: nextValue } }, {
      onSuccess: () => {
        setOptimisticVisibility((old) => withoutKey(old, team.teamName));
        invalidateBudgetCaches(queryClient);
      },
      onError: () => setOptimisticVisibility((old) => ({ ...old, [team.teamName]: previous })),
    });
  }, [canManageVisibility, optimisticVisibility, updateVisibility, queryClient]);

  const rowData = useMemo(() => {
    return teams.map(team => ({
      ...buildAllocationRow(team, selectedYear),
      isHidden: optimisticVisibility[team.teamName] ?? team.isHidden,
    }));
  }, [teams, selectedYear, optimisticVisibility]);

  const filteredRows = useMemo(() => {
    return rowData.filter(r => {
      if (!showHidden && r.isHidden) return false;
      if (searchQuery && !r.team.teamName.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      return true;
    });
  }, [rowData, showHidden, searchQuery]);

  const visibleAuditChanges = useMemo(
    () => filterVisibleAudits(
      auditQuery.data?.changes ?? [],
      new Set(teams.map((team) => team.teamName)),
      canManageVisibility,
    ),
    [auditQuery.data?.changes, canManageVisibility, teams],
  );

  const footerTotals = useMemo(() => {
    const result = {
      startingAllocation: 0,
      august: 0,
      september: 0,
      laterAdditions: 0,
      futureAdditions: 0,
      rowTotal: 0
    };
    filteredRows.forEach(r => {
      result.startingAllocation = sumUsd([result.startingAllocation, r.startingAllocation]);
      result.august = sumUsd([result.august, r.august]);
      result.september = sumUsd([result.september, r.september]);
      result.laterAdditions = sumUsd([result.laterAdditions, r.laterAdditions]);
      result.futureAdditions = sumUsd([result.futureAdditions, r.futureAdditions]);
      result.rowTotal = sumUsd([result.rowTotal, r.rowTotal]);
    });
    return result;
  }, [filteredRows]);

  if (historyQuery.isLoading && !historyQuery.data) {
    return <div className="p-8 space-y-4"><Skeleton className="h-12 w-full max-w-sm" /><Skeleton className="h-96 w-full" /></div>;
  }
  if (historyQuery.isError && !historyQuery.data) {
    return (
      <div className="flex flex-col items-center gap-3 p-12 text-center text-sm text-muted-foreground" role="alert">
        <span>Budget allocations are unavailable.</span>
        <Button variant="outline" size="sm" onClick={() => void historyQuery.refetch()}>Retry</Button>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-[1280px] space-y-8 px-4 py-6 pb-24 md:px-8 md:py-8" data-testid="page-team-budgets">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0 space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl" data-testid="text-team-budgets-title">Budget allocations</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
             Manage local planning funding. Undated opening funding, dated monthly additions, and carried-forward additions remain separate from platform limits.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {canEdit && <AddAllocationDialog key={authorizationKey} teams={teams} onSuccess={() => invalidateBudgetCaches(queryClient)} />}
        </div>
      </div>

      {historyQuery.isError && historyQuery.data && (
        <div className="flex items-center justify-between gap-3 border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm" role="status">
          <span>Refresh failed — showing the last available allocations.</span>
          <Button variant="outline" size="sm" onClick={() => void historyQuery.refetch()}>Retry</Button>
        </div>
      )}

      <Card className="overflow-hidden rounded-md shadow-none">
        <CardHeader className="border-b bg-card pb-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="relative block w-full sm:w-64">
              <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Find a team</span>
              <Search className="absolute left-3 top-[34px] h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search teams..."
                aria-label="Search teams"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="h-9 bg-background pl-9"
              />
            </label>
            <label className="block w-full sm:w-28">
              <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Year</span>
              <Select value={String(selectedYear)} onValueChange={v => setSelectedYear(Number(v))}>
              <SelectTrigger aria-label="Allocation year" className="h-9 bg-background">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableYears.map(yr => (
                  <SelectItem key={yr} value={String(yr)}>{yr}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            </label>
          </div>
           {canManageVisibility && (
             <div className="flex items-center gap-2">
               <Switch id="show-hidden" checked={showHidden} onCheckedChange={setShowHidden} data-testid="switch-show-hidden-teams" />
               <Label htmlFor="show-hidden" className="cursor-pointer text-sm font-normal text-muted-foreground">Show hidden teams</Label>
             </div>
           )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="flex items-center justify-between border-b bg-muted/20 px-4 py-3">
            <div className="text-sm">
              <strong>Funding ledger</strong>
              <span className="ml-2 text-muted-foreground">Selected year: {selectedYear}</span>
            </div>
            <Badge variant="outline" className="font-normal">{filteredRows.length} teams</Badge>
        </div>

        {(footerTotals.laterAdditions !== 0 || footerTotals.futureAdditions !== 0) && (
          <Collapsible className="border-b bg-muted/20">
            <CollapsibleTrigger asChild>
              <Button variant="ghost" className="h-auto w-full justify-between gap-4 rounded-none px-3 py-3 text-left font-normal sm:px-4">
                <span>
                  <strong>Later-dated funding details</strong>
                  <span className="ml-2 text-muted-foreground">
                    {footerTotals.laterAdditions !== 0 && `${currency.format(footerTotals.laterAdditions)} included from October–December`}
                    {footerTotals.laterAdditions !== 0 && footerTotals.futureAdditions !== 0 && ' · '}
                    {footerTotals.futureAdditions !== 0 && `${currency.format(footerTotals.futureAdditions)} after ${selectedYear} not included`}
                  </span>
                </span>
                <ChevronDown className="h-4 w-4 shrink-0" />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="border-t px-3 py-3 sm:px-4">
              <p className="mb-3 text-xs text-muted-foreground">
                Total = Starting allocation + August + September + October–December {selectedYear}. Additions after {selectedYear} remain in the ledger but are not part of this selected-year total.
              </p>
              <div className="max-w-full overflow-x-auto">
                <table className="w-full min-w-[480px] text-sm">
                  <thead className="text-muted-foreground">
                    <tr>
                      <th className="pb-2 text-left font-medium">Team</th>
                      <th className="pb-2 text-right font-medium">October</th>
                      <th className="pb-2 text-right font-medium">November</th>
                      <th className="pb-2 text-right font-medium">December</th>
                      <th className="pb-2 text-right font-medium">After {selectedYear}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.filter(row => row.laterAdditions !== 0 || row.futureAdditions !== 0).map(row => (
                      <tr key={row.team.teamName} className="border-t">
                        <th className="py-2 text-left font-medium">{row.team.teamName}</th>
                        {row.monthsData.slice(9).map((value, index) => (
                          <td key={index} className="py-2 text-right tabular-nums"><CellValue value={value} /></td>
                        ))}
                        <td className="py-2 text-right tabular-nums"><CellValue value={row.futureAdditions} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}

        <div className="relative w-full max-w-full overflow-x-auto overscroll-contain" tabIndex={0} aria-label="Budget allocation ledger">
          <table className="w-full min-w-[820px] border-separate border-spacing-0 whitespace-nowrap text-sm [&_td]:border-b [&_td]:border-border [&_th]:border-b [&_th]:border-border" data-testid="table-team-budget-history">
            <thead className="sticky top-0 z-30 bg-muted/90 backdrop-blur text-muted-foreground shadow-[0_1px_0_0_hsl(var(--border))]">
              <tr>
                 <th className="sticky left-0 top-0 z-40 w-48 min-w-48 bg-muted/95 p-3 text-left font-medium shadow-[inset_-1px_0_0_0_hsl(var(--border))] sm:w-64 sm:min-w-64">Team</th>
                 <th className="p-3 text-right font-medium" title="Opening baseline, carried and undated additions, and January–July additions">Starting allocation</th>
                 <th className="p-3 text-right font-medium" title={`August ${selectedYear} additions`}>August</th>
                 <th className="p-3 text-right font-medium" title={`September ${selectedYear} additions`}>September</th>
                  <th className="p-3 text-right font-medium" title={`October–December ${selectedYear} additions`}>Later additions</th>
                 <th className="p-3 text-right font-bold" title={`All funding through ${selectedYear}, including disclosed October–December additions`}>
                   Total <span className="block text-xs font-normal">through {selectedYear}</span>
                 </th>
                 {canManageVisibility && <th aria-label="Visibility" className="w-[52px] min-w-[52px] p-3"></th>}
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 ? (
                <tr>
                    <td colSpan={canManageVisibility ? 7 : 6} className="p-12 text-center text-muted-foreground">
                    No teams found.
                  </td>
                </tr>
              ) : (
                filteredRows.map(row => (
                  <tr key={row.team.teamName} className={`group hover:bg-muted/50 transition-colors ${row.isHidden ? 'text-muted-foreground bg-muted/30' : ''}`}>
                    <th scope="row" className="sticky left-0 z-20 w-48 min-w-48 bg-card p-3 text-left font-medium shadow-[inset_-1px_0_0_0_hsl(var(--border))] group-hover:bg-muted sm:w-64 sm:min-w-64">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 truncate" title={row.team.teamName}>{row.team.teamName}</span>
                        {row.isHidden && <Badge variant="secondary" className="text-[10px] uppercase px-1.5 py-0 h-4">Hidden</Badge>}
                      </div>
                    </th>
                    <td className="p-3 text-right font-mono tabular-nums shadow-[inset_-1px_0_0_0_hsl(var(--border))]">
                       <EditableOpeningFunding
                         key={`${authorizationKey}:${row.team.teamName}`}
                         teamName={row.team.teamName}
                         baselineAllocation={row.baseline}
                         startingAllocation={row.startingAllocation}
                        canEdit={canEdit}
                         onSuccess={() => invalidateBudgetCaches(queryClient)}
                      />
                    </td>
                    <td className="p-3 text-right font-mono tabular-nums"><CellValue value={row.august} /></td>
                    <td className="p-3 text-right font-mono tabular-nums"><CellValue value={row.september} /></td>
                    <td className="p-3 text-right font-mono tabular-nums"><CellValue value={row.laterAdditions} /></td>
                     <td className="p-3 text-right font-mono font-bold tabular-nums">
                      <CellValue value={row.rowTotal} isZeroFaded={false} />
                    </td>
                     {canManageVisibility && (
                      <td className="w-[52px] min-w-[52px] p-3 text-center">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
                          onClick={() => handleToggleVisibility(row.team)}
                          title={row.isHidden ? "Show team" : "Hide team"}
                           aria-label={row.isHidden ? `Show ${row.team.teamName}` : `Hide ${row.team.teamName}`}
                          data-testid={`button-toggle-team-visibility-${row.team.teamName}`}
                        >
                          {row.isHidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                        </Button>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
            {filteredRows.length > 0 && (
              <tfoot className="sticky bottom-0 z-30 bg-muted font-bold text-foreground">
                <tr>
                  <th className="sticky left-0 bottom-0 z-40 w-48 min-w-48 bg-muted p-3 text-left shadow-[inset_-1px_0_0_0_hsl(var(--border)),inset_0_1px_0_0_hsl(var(--border))] sm:w-64 sm:min-w-64">Total</th>
                  <td className="p-3 text-right shadow-[inset_-1px_0_0_0_hsl(var(--border)),inset_0_1px_0_0_hsl(var(--border))] tabular-nums">
                    <CellValue value={footerTotals.startingAllocation} isZeroFaded={false} />
                  </td>
                  <td className="p-3 text-right shadow-[inset_0_1px_0_0_hsl(var(--border))] tabular-nums">
                    <CellValue value={footerTotals.august} isZeroFaded={false} />
                  </td>
                  <td className="p-3 text-right shadow-[inset_0_1px_0_0_hsl(var(--border))] tabular-nums">
                    <CellValue value={footerTotals.september} isZeroFaded={false} />
                  </td>
                   <td className="p-3 text-right shadow-[inset_0_1px_0_0_hsl(var(--border))] tabular-nums">
                     <CellValue value={footerTotals.laterAdditions} isZeroFaded={false} />
                   </td>
                   <td className="p-3 text-right shadow-[inset_0_1px_0_0_hsl(var(--border))] tabular-nums">
                    <CellValue value={footerTotals.rowTotal} isZeroFaded={false} />
                  </td>
                   {canManageVisibility && <td className="w-[52px] min-w-[52px] p-3 shadow-[inset_0_1px_0_0_hsl(var(--border))]"></td>}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
        </CardContent>
      </Card>

      <div className="border-t pt-2">
        <Collapsible open={auditOpen} onOpenChange={setAuditOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="h-12 w-full justify-between px-0 text-left" data-testid="disclosure-allocation-audit">
               <span className="flex items-center gap-2 font-semibold"><History className="h-4 w-4 text-primary" />Allocation sources and audit history</span>
              <ChevronDown className={`h-4 w-4 transition-transform ${auditOpen ? 'rotate-180' : ''}`} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-6 pt-4">
            <Card className="rounded-md shadow-none">
              <CardHeader>
                <CardTitle className="text-lg">Source issues</CardTitle>
                <CardDescription>Approved records that were not included in allocation totals.</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {(!historyQuery.data?.issues || historyQuery.data.issues.length === 0) ? (
                  <p className="p-8 text-center text-sm text-muted-foreground">No active source issues.</p>
                ) : (
                  <div className="max-w-full overflow-x-auto overscroll-contain" tabIndex={0} aria-label="Allocation source issues">
                    <table className="w-full min-w-[900px] text-sm">
                      <thead className="bg-muted/20 text-left text-xs uppercase text-muted-foreground">
                        <tr><th className="px-5 py-3">Source record</th><th className="px-5 py-3">Team</th><th className="px-5 py-3">Amount / period</th><th className="px-5 py-3">State</th><th className="px-5 py-3">Reason</th></tr>
                      </thead>
                      <tbody>
                        {historyQuery.data.issues.map((issue) => (
                          <tr key={`${issue.source}-${issue.recordId}`} className="border-t">
                            <td className="px-5 py-4 font-mono text-xs">
                              {issue.sourceUrl ? (
                                <a className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline" href={issue.sourceUrl} target="_blank" rel="noreferrer">
                                  {issue.recordId}<ExternalLink className="h-3 w-3" />
                                </a>
                              ) : issue.recordId}
                              <div className="mt-1 text-muted-foreground">{issue.sourceKind}</div>
                            </td>
                            <td className="px-5 py-4">{issue.teamName ?? issue.sourceTeamName ?? 'Unknown'}</td>
                            <td className="px-5 py-4 tabular-nums">{issue.amountUsd == null ? '—' : currency.format(issue.amountUsd)} · {issue.submissionPeriod ?? '—'}</td>
                            <td className="px-5 py-4"><Badge variant="outline">{issue.matchState}</Badge></td>
                            <td className="px-5 py-4">{issue.error ?? 'No reason supplied'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>

            {canEdit && (
              <Card className="rounded-md shadow-none">
                <CardHeader>
                   <CardTitle className="text-lg">Allocation audit history</CardTitle>
                   <CardDescription>Opening funding and monthly additions are recorded newest first{canManageVisibility ? ', with administrator visibility changes' : ''}.</CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  {auditQuery.isLoading && !auditQuery.data ? (
                    <div className="p-6"><Skeleton className="h-20 w-full" /></div>
                  ) : auditQuery.isError && !auditQuery.data ? (
                    <div className="flex flex-col items-center gap-3 p-8 text-center text-sm text-muted-foreground" role="alert">
                      <span>Allocation history is unavailable.</span>
                      <Button variant="outline" size="sm" onClick={() => void auditQuery.refetch()}>Retry</Button>
                    </div>
                  ) : visibleAuditChanges.length === 0 ? (
                    <div className="space-y-3 p-8 text-center text-sm text-muted-foreground">
                      <p>{auditBeforeId ? 'No older administrator changes.' : 'No administrator changes recorded yet.'}</p>
                      {auditCursors.length > 1 && (
                        <Button variant="outline" size="sm" onClick={() => setAuditCursors((current) => current.slice(0, -1))}>
                          Previous
                        </Button>
                      )}
                    </div>
                  ) : (
                    <div>
                      <p className="px-5 py-3 text-xs text-muted-foreground">
                        Page {auditCursors.length} · up to 200 changes per page.
                      </p>
                      {auditQuery.isError && (
                        <div className="mx-5 mb-3 flex items-center justify-between border border-destructive/30 bg-destructive/5 p-3 text-sm">
                          <span>Refresh failed. Showing the last successful history page.</span>
                          <Button variant="outline" size="sm" onClick={() => void auditQuery.refetch()}>Retry</Button>
                        </div>
                      )}
                      <div className="max-w-full overflow-x-auto overscroll-contain" tabIndex={0} aria-label="Allocation audit history">
                      <table className="w-full min-w-[760px] text-sm">
                        <thead className="bg-muted/20 text-left text-xs uppercase text-muted-foreground">
                          <tr><th className="px-5 py-3">When</th><th className="px-5 py-3">Team</th><th className="px-5 py-3">Field</th><th className="px-5 py-3">Change</th><th className="px-5 py-3">Actor</th></tr>
                        </thead>
                        <tbody>
                          {visibleAuditChanges.map((change) => (
                            <tr key={change.id} className="border-t">
                              <td className="px-5 py-4 whitespace-nowrap">{new Date(change.timestamp).toLocaleString()}</td>
                              <td className="px-5 py-4 font-medium">{change.teamName}</td>
                              <td className="px-5 py-4">{change.field === 'annualAllocationUsd' ? 'Undated opening funding' : change.field === 'monthlyAllocationAddition' ? 'Monthly addition' : 'Visibility'}</td>
                              <td className="px-5 py-4 tabular-nums">
                                {change.field === 'monthlyAllocationAddition' && typeof change.newValue === 'object'
                                  ? `${change.newValue.month}: +${currency.format(change.newValue.amountUsd)}`
                                  : change.field === 'annualAllocationUsd'
                                  ? `${currency.format(Number(change.oldValue))} → ${currency.format(Number(change.newValue))}`
                                  : `${change.oldValue ? 'Hidden' : 'Visible'} → ${change.newValue ? 'Hidden' : 'Visible'}`}
                              </td>
                              <td className="px-5 py-4 font-mono text-xs">{change.actor}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      </div>
                      <div className="flex flex-wrap justify-end gap-2 border-t px-3 py-4 sm:px-5">
                        <Button
                          variant="outline"
                          disabled={auditCursors.length === 1 || auditQuery.isFetching}
                          onClick={() => setAuditCursors((current) => current.slice(0, -1))}
                        >
                          Previous
                        </Button>
                        <Button
                          variant="outline"
                          disabled={auditQuery.isFetching || (auditQuery.data?.changes.length ?? 0) < 200}
                          onClick={() => setAuditCursors((current) => [
                            ...current,
                            auditQuery.data?.changes.at(-1)?.id,
                          ])}
                        >
                          Next
                        </Button>
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </CollapsibleContent>
        </Collapsible>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="h-4 w-4 text-primary" />
        Planning allocations do not change Replit platform limits.
      </div>
    </div>
  );
}
