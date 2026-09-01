import {
  Bell,
  CalendarRange,
  CircleDollarSign,
  ExternalLink,
  Info,
  Layers3,
  MousePointerClick,
  Users,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

const CREDIT_REQUEST_URL =
  'https://airtable.com/appDXDfAHCXfJWF94/pag0RCmIauEcWroiy/form';

function Step({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border bg-background text-xs font-semibold">
        {number}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-sm leading-5 text-muted-foreground">{children}</p>
      </div>
    </li>
  );
}

function GuideSection({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: typeof Users;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="px-4 py-4 md:px-5">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 rounded-md border bg-muted/40 p-2 text-muted-foreground">
            <Icon className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="space-y-1">
            <CardTitle className="text-base">{title}</CardTitle>
            {description && <CardDescription className="leading-5">{description}</CardDescription>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4 md:px-5">{children}</CardContent>
    </Card>
  );
}

function BulletList({ children }: { children: React.ReactNode }) {
  return (
    <ul className="space-y-2 text-sm leading-5 text-muted-foreground [&>li]:relative [&>li]:pl-4 [&>li]:before:absolute [&>li]:before:left-0 [&>li]:before:top-[0.55rem] [&>li]:before:h-1 [&>li]:before:w-1 [&>li]:before:rounded-full [&>li]:before:bg-muted-foreground/60">
      {children}
    </ul>
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
          Budget Monitor User Guide
        </h1>
        <p className="mt-1 text-sm text-muted-foreground md:text-base">
          Understand your scoped usage, allocated pools, and email activity.
        </p>
      </header>

      <Card className="border-primary/25 bg-primary/[0.03]">
        <CardHeader className="px-4 py-4 md:px-5">
          <CardTitle className="text-base">Quick Start</CardTitle>
          <CardDescription>Three steps to find and understand the information you need.</CardDescription>
        </CardHeader>
        <CardContent className="px-4 pb-4 md:px-5">
          <ol className="grid gap-4 md:grid-cols-3">
            <Step number={1} title="Choose a date range">
              Use the date-range control to set the period shown across the dashboard.
            </Step>
            <Step number={2} title="Review the Dashboard">
              Check visible spend, allocated pools, Remaining, and percentage used.
            </Step>
            <Step number={3} title="Open the details">
              Select an authorized group for member and project details, or open <strong>Email Activity</strong> for notification history.
            </Step>
          </ol>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <GuideSection
          icon={CalendarRange}
          title="Choose the usage period"
          description="The selected date range controls the usage shown throughout the dashboard and authorized group details."
        >
          <BulletList>
            <li>
              A per-user total adds that user’s usage across <strong className="text-foreground">all metric types</strong> in the workspaces you can see.
            </li>
            <li>
              If the user belongs to multiple groups in one workspace, their <strong className="text-foreground">shared membership is counted once</strong> there.
            </li>
            <li>Usage from distinct visible workspaces is added together.</li>
          </BulletList>
        </GuideSection>

        <GuideSection
          icon={Users}
          title="Understand headline spend"
          description="Group and team headline spend uses workspace-aware member rollups."
        >
          <BulletList>
            <li>
              Each workspace charge is <strong className="text-foreground">assigned once using stable group attribution</strong>, preventing shared membership from duplicating the same charge.
            </li>
            <li>
              Usage that belongs to a visible workspace but cannot be assigned to a group is preserved in a <strong className="text-foreground">“No group” row</strong>. It is not silently dropped.
            </li>
          </BulletList>
        </GuideSection>

        <GuideSection
          icon={Layers3}
          title="Compare headline and project totals"
          description="The two views organize the same kind of usage for different questions."
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border bg-muted/20 p-3">
              <p className="text-sm font-medium">Headline spend</p>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">
                A member-rollup view that follows workspace-aware member attribution.
              </p>
            </div>
            <div className="rounded-md border bg-muted/20 p-3">
              <p className="text-sm font-medium">Projects table</p>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">
                A project-attributed view in an authorized group detail that organizes charges by project.
              </p>
            </div>
          </div>
          <div className="mt-3 flex gap-2 rounded-md border bg-muted/30 p-3">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm leading-5 text-muted-foreground">
              <strong className="text-foreground">Note:</strong> These totals may differ because they intentionally answer different questions.
            </p>
          </div>
        </GuideSection>

        <GuideSection
          icon={CircleDollarSign}
          title="Read allocated pool status"
          description="Use the budget columns and summary cards to see how current spend compares with its allocation."
        >
          <dl className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border p-3">
              <dt className="text-sm font-medium">Allocated pool</dt>
              <dd className="mt-1 text-sm leading-5 text-muted-foreground">The budget assigned to a group or team.</dd>
            </div>
            <div className="rounded-md border p-3">
              <dt className="text-sm font-medium">Remaining</dt>
              <dd className="mt-1 text-sm leading-5 text-muted-foreground">Remaining is the allocated pool minus current headline spend.</dd>
            </div>
            <div className="rounded-md border p-3">
              <dt className="text-sm font-medium">Percentage used</dt>
              <dd className="mt-1 text-sm leading-5 text-muted-foreground">Headline spend divided by the allocated pool.</dd>
            </div>
            <div className="rounded-md border p-3">
              <dt className="text-sm font-medium">Over Threshold</dt>
              <dd className="mt-1 text-sm leading-5 text-muted-foreground">The “Over Threshold” count includes visible pools at or above 75%.</dd>
            </div>
          </dl>
          <div className="mt-3 flex gap-2 rounded-md border bg-muted/30 p-3">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm leading-5 text-muted-foreground">
              <strong className="text-foreground">Important:</strong> Only pools and usage in your authorized scope contribute to Workspace Admin summary figures. A dash or loading value means the dashboard does not yet have a complete value for that field. Wait for loading to finish before comparing totals or percentage used.
            </p>
          </div>
        </GuideSection>

        <GuideSection
          icon={Bell}
          title="Review automated email alerts"
          description="Alerts track configured group or team allocated pools through the billing period."
        >
          <BulletList>
            <li>Automated emails evaluate configured pools at <strong className="text-foreground">50%, 75%, 90%, and 100%</strong>.</li>
            <li>Each threshold is sent at most once per billing period.</li>
            <li>A newly crossed threshold becomes eligible on the next successful check.</li>
            <li>If delivery fails or email delivery is unavailable, that threshold remains retryable.</li>
          </BulletList>
          <div className="mt-3 rounded-md border bg-muted/30 p-3">
            <p className="text-sm leading-5 text-muted-foreground">
              <strong className="text-foreground">Email Activity is read-only</strong> and limited to authorized data. It shows the spend captured when an email was sent and the current spend, so those values can differ as usage changes.
            </p>
          </div>
        </GuideSection>

        <GuideSection
          icon={MousePointerClick}
          title="Navigate the dashboard"
          description="Move between scoped summaries, authorized details, and notification history."
        >
          <ol className="space-y-3">
            <Step number={1} title="Start on Dashboard">
              Review scoped summary figures and group rows.
            </Step>
            <Step number={2} title="Select an authorized group">
              Open its member and project details.
            </Step>
            <Step number={3} title="Adjust the date range">
              Use the date-range control to change the period shown.
            </Step>
            <Step number={4} title="Open Email Activity">
              Review notification history for the data you are authorized to see.
            </Step>
          </ol>
        </GuideSection>
      </div>

      <Card className="border-primary/30">
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between md:p-5">
          <div>
            <p className="text-sm font-semibold">Need more capacity?</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Submit the approved external request form for additional credits.
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