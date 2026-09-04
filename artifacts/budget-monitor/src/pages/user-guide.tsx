import {
  ArrowRight,
  Building2,
  ExternalLink,
  Info,
  Layers3,
  RefreshCw,
  ShieldCheck,
  Users,
  WalletCards,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

const CREDIT_REQUEST_URL =
  'https://airtable.com/appDXDfAHCXfJWF94/pag0RCmIauEcWroiy/form';

const sections = [
  { id: 'hierarchy', label: 'Hierarchy' },
  { id: 'budgets', label: 'Allocations and limits' },
  { id: 'blocking', label: 'Blocking' },
  { id: 'roles', label: 'Roles' },
  { id: 'freshness', label: 'Freshness' },
] as const;

function GuideSection({
  id,
  icon: Icon,
  title,
  description,
  children,
}: {
  id: string;
  icon: typeof Users;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card id={id} className="scroll-mt-6">
      <CardHeader className="px-4 py-4 md:px-5">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 rounded-md border bg-muted/40 p-2 text-muted-foreground">
            <Icon className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="space-y-1">
            <CardTitle className="text-base">{title}</CardTitle>
            <CardDescription className="leading-5">{description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4 md:px-5">{children}</CardContent>
    </Card>
  );
}

function RuleList({ children }: { children: React.ReactNode }) {
  return (
    <ul className="space-y-2 text-sm leading-5 text-muted-foreground [&>li]:relative [&>li]:pl-4 [&>li]:before:absolute [&>li]:before:left-0 [&>li]:before:top-[0.55rem] [&>li]:before:h-1 [&>li]:before:w-1 [&>li]:before:rounded-full [&>li]:before:bg-muted-foreground/60">
      {children}
    </ul>
  );
}

function Callout({
  label,
  children,
}: {
  label: 'Example' | 'Important';
  children: React.ReactNode;
}) {
  return (
    <div className="mt-3 flex gap-2 rounded-md border bg-muted/30 p-3">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm leading-5 text-muted-foreground">
        <strong className="text-foreground">{label}:</strong> {children}
      </p>
    </div>
  );
}

export default function UserGuide() {
  return (
    <div
      className="mx-auto max-w-4xl space-y-4 p-4 md:space-y-5 md:p-8"
      data-testid="page-user-guide"
    >
      <header>
        <h1
          className="text-2xl font-bold tracking-tight md:text-3xl"
          data-testid="text-user-guide-title"
        >
          Budget Monitor Guide
        </h1>
        <p className="mt-1 text-sm text-muted-foreground md:text-base">
          How the directory is organized, how budgets differ, who can make changes, and when data refreshes.
        </p>
      </header>

      <Card className="border-primary/25 bg-primary/[0.03]">
        <CardHeader className="px-4 py-4 md:px-5">
          <CardTitle className="text-base">At a glance</CardTitle>
          <CardDescription>Keep these distinctions in mind when reviewing spend.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 px-4 pb-4 sm:grid-cols-2 md:px-5">
          {[
            ['1', 'Workspace → Team → Family → Role group is the canonical hierarchy.'],
            ['2', 'Annual allocations plan capacity; monthly Agent limits enforce usage.'],
            ['3', 'Only an applied Replit limit blocks paid services.'],
            ['4', 'Data as of identifies the newest usage included in the figures.'],
          ].map(([number, rule]) => (
            <div key={number} className="flex gap-3 rounded-md border bg-background p-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border bg-muted/40 text-xs font-semibold">
                {number}
              </span>
              <p className="text-sm leading-5">{rule}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <nav aria-label="Guide sections" className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Jump to
        </span>
        {sections.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className="rounded-full border bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {section.label}
          </a>
        ))}
      </nav>

      <div className="space-y-4">
        <GuideSection
          id="hierarchy"
          icon={Layers3}
          title="Canonical hierarchy"
          description="Every role group belongs to one family, team, and workspace."
        >
          <RuleList>
            <li><strong className="text-foreground">Workspace</strong> is the Replit workspace that owns the directory membership and usage.</li>
            <li><strong className="text-foreground">Team</strong> is the business planning level used for annual allocations and reporting.</li>
            <li><strong className="text-foreground">Family</strong> combines matching Admin, Member, and Viewer role groups within a workspace.</li>
            <li><strong className="text-foreground">Role group</strong> is the actual Replit group whose membership determines access and limit targets.</li>
            <li>A person shown in several role groups is deduplicated in family and team totals; spend stays with the workspace where it occurred.</li>
          </RuleList>
          <Callout label="Example">
            <span className="inline-flex flex-wrap items-center gap-1 text-foreground">
              Workspace A <ArrowRight className="h-3.5 w-3.5" /> Growth Team
              <ArrowRight className="h-3.5 w-3.5" /> Growth family
              <ArrowRight className="h-3.5 w-3.5" /> Growth Member group
            </span>
          </Callout>
        </GuideSection>

        <GuideSection
          id="budgets"
          icon={WalletCards}
          title="Annual allocations and monthly limits"
          description="These numbers answer different questions and should not be compared as if they were the same control."
        >
          <RuleList>
            <li>An <strong className="text-foreground">annual allocation</strong> is the team’s planning total: its admin-managed baseline plus approved adjustments.</li>
            <li>Changing an annual allocation does not write a Replit usage limit.</li>
            <li>A <strong className="text-foreground">monthly Agent limit</strong> resets on the billing cycle day and is the amount sent to Replit for enforcement.</li>
            <li>The default team monthly limit is the annual allocation divided by 12; account administrators may set a manual monthly value.</li>
            <li>Target overrides divide or redirect the team limit across specific workspace member groups. A target total difference is informational and does not prevent an apply.</li>
          </RuleList>
        </GuideSection>

        <GuideSection
          id="blocking"
          icon={Building2}
          title="What blocks usage"
          description="Dashboard allocations and alert thresholds inform operators; Replit limits enforce usage."
        >
          <RuleList>
            <li>Reaching an applied monthly Agent group or member limit blocks paid services covered by that Replit limit.</li>
            <li>Annual allocations, dashboard percentages, and email thresholds do not block usage by themselves.</li>
            <li>Saving a desired monthly limit in Budget Monitor does not change enforcement until an authorized account administrator applies it upstream.</li>
            <li>Legacy copies shown for reference are not member-group limit targets.</li>
          </RuleList>
          <Callout label="Important">
            A dashboard value above 100% can trigger guidance or email without blocking. Confirm the upstream limit status to know what Replit is enforcing.
          </Callout>
        </GuideSection>

        <GuideSection
          id="roles"
          icon={ShieldCheck}
          title="Roles and permissions"
          description="What you can see and change follows your highest applicable account, workspace, or team role."
        >
          <RuleList>
            <li><strong className="text-foreground">Enterprise account administrators</strong> see the full account and manage access, allocations, recipients, visibility, and upstream limits.</li>
            <li><strong className="text-foreground">Managed account editors</strong> can work with account-wide allocations and reporting, but cannot manage the editor allowlist as true account administrators do.</li>
            <li><strong className="text-foreground">Workspace administrators</strong> see their authorized workspace scope and can manage supported member limits there.</li>
            <li><strong className="text-foreground">Team administrators</strong> see the families they administer across the team’s represented workspaces.</li>
            <li><strong className="text-foreground">Members</strong> see their own usage, limits, and group memberships.</li>
          </RuleList>
        </GuideSection>

        <GuideSection
          id="freshness"
          icon={RefreshCw}
          title="Data as of and refresh behavior"
          description="The page refreshes automatically while keeping the latest usable values visible."
        >
          <RuleList>
            <li><strong className="text-foreground">Data as of</strong> is the newest usage timestamp included in the displayed figures, not the time the page was opened.</li>
            <li>Data views check for updated server results every 60 seconds. This does not change the backend ingestion cadence.</li>
            <li>Available numeric values remain visible during refreshes; they are not replaced by loading placeholders.</li>
            <li>Partial, stale, and request failures appear once as transient notifications. Repeated polling failures do not stack notices.</li>
            <li>When fresh data returns, the active notification clears without a success banner.</li>
          </RuleList>
        </GuideSection>
      </div>

      <Card className="border-primary/30">
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between md:p-5">
          <div>
            <p className="text-sm font-semibold">Need more annual capacity?</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Submit the approved request form for an allocation adjustment.
            </p>
          </div>
          <Button asChild className="w-full shrink-0 sm:w-auto" data-testid="link-request-credits">
            <a href={CREDIT_REQUEST_URL} target="_blank" rel="noopener noreferrer">
              Request additional credits
              <ExternalLink className="ml-2 h-4 w-4" aria-hidden="true" />
            </a>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}