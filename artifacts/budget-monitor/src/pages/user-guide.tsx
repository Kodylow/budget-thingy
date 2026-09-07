import { useAuthContext } from '@/components/auth-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  BookOpen,
  CheckCircle2,
  Download,
  ExternalLink,
  Info,
  RefreshCw,
  Search,
  ShieldCheck,
} from 'lucide-react';
import type { ReactNode } from 'react';

const walkthroughHref = `${import.meta.env.BASE_URL}guides/budget-monitor-walkthrough.pdf`;

export default function Help() {
  const { capabilities } = useAuthContext();

  return (
    <main className="mx-auto max-w-[1280px] space-y-8 px-4 py-6 md:px-8 md:py-8">
      <header className="max-w-3xl space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Use Budget Monitor</h1>
        <p className="text-sm leading-6 text-muted-foreground">
          Role-aware guidance for monitoring spend, allocations, and Agent limits across Comcast Enterprise.
        </p>
      </header>

      <section className="flex flex-col gap-5 rounded-md border border-primary/15 bg-primary/[0.035] px-5 py-6 sm:flex-row sm:items-center sm:justify-between md:px-6">
        <div className="flex min-w-0 gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
            <BookOpen className="h-5 w-5" aria-hidden />
          </div>
          <div>
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">Budget Monitor walkthrough</h2>
              <Badge variant="outline" className="text-[10px] font-medium">12 slides</Badge>
            </div>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              Open the approved 12-slide guide for members and team administrators. Learn how to
              monitor, investigate, manage limits, and interpret data freshness without changing data.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
          <Button asChild>
            <a
              href={walkthroughHref}
              target="_blank"
              rel="noopener"
              data-testid="help-open-walkthrough"
            >
              Open walkthrough (PDF) <ExternalLink className="ml-2 h-4 w-4" aria-hidden />
            </a>
          </Button>
          <Button variant="outline" asChild>
            <a href={walkthroughHref} download data-testid="help-download-walkthrough">
              Download <Download className="ml-2 h-4 w-4" aria-hidden />
            </a>
          </Button>
        </div>
      </section>

      <div className="grid gap-x-10 gap-y-8 md:grid-cols-2">
        <GuideSection index="01 · Monitor" title="Read current spend" icon={<Search className="h-4 w-4" />}>
            <p>
              <strong className="text-foreground">Overview</strong> summarizes actual spend for the selected
              period and scope. Use scope to switch among your spend, groups and workspaces you manage,
              and all spend you are authorized to see.
            </p>
            <p>
              The period and data-as-of text explain what the amount covers. Ordinary members see their
              own spend; account-wide labels appear only when you have that permission.
            </p>
            <p>
              <strong className="text-foreground">My Projects</strong> is the current self-owned project
              catalog. Published is the current count across that catalog, including projects without spend;
              it is separate from selected-period spend and current billing-cycle Agent limits.
            </p>
        </GuideSection>

        <GuideSection index="02 · Investigate" title="Find where it went" icon={<Search className="h-4 w-4" />}>
            <p>
              Open <strong className="text-foreground">Spend</strong> for searchable, sortable detail.
              Choose Groups, Members, Projects, or an available planning-pool view, then narrow the
              authorized scope with filters.
            </p>
            <p>
              Project rows show the current catalog, while their spend columns use the selected reporting
              period. They explain attribution, not a separate accounting total.
            </p>
            <div className="mt-4 flex items-start gap-2 rounded-md bg-muted/60 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
              Canonical member and group totals remain the source for monitoring.
            </div>
        </GuideSection>

        {capabilities.canWriteUserLimitsIn.length > 0 && (
          <GuideSection index="03 · Control" title="Set Agent limits" icon={<ShieldCheck className="h-4 w-4" />}>
            <p>
              <strong className="text-foreground">Limits</strong> shows current monthly Agent limits for
              eligible members. A platform limit may hard-block paid Agent usage when reached and resets
              with the billing cycle.
            </p>
            <p>
              Editing depends on workspace permissions. You can review and change limits only in
              workspaces where your current role grants that capability.
            </p>
            {capabilities.canEditAllocations && (
              <p>
                Budget allocations are planning baselines used for monitoring and alerts. They are distinct
                from monthly Agent limits and do not themselves block usage.
              </p>
            )}
          </GuideSection>
        )}

        <GuideSection index="04 · Verify" title="Check freshness and coverage" icon={<RefreshCw className="h-4 w-4" />}>
            <p>
              <strong className="text-foreground">Data as of</strong> is the last observed usage time,
              not the time you opened the page. A refreshing
              or stale message means the last successful values remain visible while newer data is sought.
            </p>
            <p>
              Partial coverage and unknown values are never zero. Administrators can open Data quality
              from the account menu for detailed coverage and attribution notes. Reporting dates and
              current billing-cycle limits remain separate.
            </p>
            <div className="mt-4 flex items-center gap-2 text-xs font-medium text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" aria-hidden />
              Guidance distinguishes reporting periods from billing-cycle controls
            </div>
        </GuideSection>
      </div>

      <Card className="rounded-md border-dashed shadow-none">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Keep these concepts separate</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-3">
          <Concept label="Spend" detail="Observed usage in the selected reporting period." />
          <Concept label="Allocation" detail="Planning baseline used for monitoring and alerts." />
          <Concept label="Agent limit" detail="Monthly platform control that can block paid usage." />
        </CardContent>
      </Card>
    </main>
  );
}

function GuideSection({
  index,
  title,
  icon,
  children,
}: {
  index: string;
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-border pt-5">
      <div className="flex items-center gap-2 text-primary">
        {icon}
        <p className="text-[11px] font-bold uppercase tracking-[0.16em]">{index}</p>
      </div>
      <h2 className="mt-2 text-xl font-semibold">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-6 text-muted-foreground">{children}</div>
    </section>
  );
}

function Concept({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="rounded-md border bg-muted/25 px-4 py-3">
      <p className="font-semibold">{label}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
    </div>
  );
}