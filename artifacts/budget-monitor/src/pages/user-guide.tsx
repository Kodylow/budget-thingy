import {
  ArrowRight,
  Building2,
  ExternalLink,
  Info,
  Layers3,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

const CREDIT_REQUEST_URL =
  'https://airtable.com/appDXDfAHCXfJWF94/pag0RCmIauEcWroiy/form';

const sections = [
  { id: 'team-formation', label: 'Team formation' },
  { id: 'team-members', label: 'Team members' },
  { id: 'comcast-workspace', label: 'Comcast workspace' },
  { id: 'multiple-workspaces', label: 'Multiple workspaces' },
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
          Budget Monitor Business Rules
        </h1>
        <p className="mt-1 text-sm text-muted-foreground md:text-base">
          How groups become teams, people are deduplicated, and spend is assigned to workspaces.
        </p>
      </header>

      <Card className="border-primary/25 bg-primary/[0.03]">
        <CardHeader className="px-4 py-4 md:px-5">
          <CardTitle className="text-base">Rules at a glance</CardTitle>
          <CardDescription>Four principles determine what appears in the Budget Monitor.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 px-4 pb-4 sm:grid-cols-2 md:px-5">
          {[
            ['1', 'Matching role groups roll up to one team.'],
            ['2', 'Admin takes precedence when a person has multiple roles.'],
            ['3', 'Legacy Comcast spend moves only when an eligible current workspace has spend.'],
            ['4', 'Spend is counted in the workspace where it occurred.'],
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

      <nav aria-label="Business rule sections" className="flex flex-wrap items-center gap-2">
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
          id="team-formation"
          icon={Layers3}
          title="Team formation"
          description="Groups with the same core name are combined into one team."
        >
          <RuleList>
            <li>
              Group names follow the pattern <strong className="text-foreground">AZ-Replit - XXX - Role</strong>.
            </li>
            <li>
              When <strong className="text-foreground">XXX</strong> matches, the Admin, Member, and Viewer groups roll up together.
            </li>
            <li>The resulting team is named XXX; the role suffix is not part of the team name.</li>
          </RuleList>
          <Callout label="Example">
            <span className="block">
              <span className="font-mono text-xs text-foreground">AZ-Replit - Comcast Advertising - Admin</span>
              <br />
              <span className="font-mono text-xs text-foreground">AZ-Replit - Comcast Advertising - Member</span>
              <br />
              <span className="font-mono text-xs text-foreground">AZ-Replit - Comcast Advertising - Viewer</span>
            </span>
            <span className="mt-2 flex items-center gap-1 font-medium text-foreground">
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              Comcast Advertising
            </span>
          </Callout>
        </GuideSection>

        <GuideSection
          id="team-members"
          icon={Users}
          title="Team members"
          description="Each person appears once on a Team page, even when they belong to more than one role group."
        >
          <RuleList>
            <li>Duplicate membership does not create duplicate people or duplicate spend.</li>
            <li>
              <strong className="text-foreground">Admin takes precedence over Member.</strong>
            </li>
            <li>If a person is both an Admin and a Member, the Team page shows only their Admin status.</li>
          </RuleList>
          <Callout label="Important">
            Role precedence controls which status is displayed. It does not add the person’s spend more than once.
          </Callout>
        </GuideSection>

        <GuideSection
          id="comcast-workspace"
          icon={Building2}
          title="Legacy Comcast workspace"
          description="Positive Comcast spend is reassigned when the user has an eligible non-Comcast workspace with positive spend."
        >
          <RuleList>
            <li>
              Comcast spend is transferred to the eligible non-Comcast workspace where that user has the highest positive spend.
            </li>
            <li>Admin still takes precedence over Member when the person has multiple role memberships.</li>
            <li>The transferred spend is counted once; overlapping roles do not duplicate it.</li>
            <li>
              If the user has no positive spend in a non-Comcast workspace, their Comcast spend remains in the Comcast workspace.
            </li>
          </RuleList>
          <Callout label="Important">
            Comcast-only users are unchanged. The dashboard does not invent a destination when there is no eligible non-Comcast workspace with positive spend.
          </Callout>
        </GuideSection>

        <GuideSection
          id="multiple-workspaces"
          icon={ShieldCheck}
          title="Users in multiple workspaces"
          description="Spend remains attached to the active workspace where it occurred."
        >
          <RuleList>
            <li>
              Excluding the Comcast workspace, a user’s spend is assigned only to the workspace where that spend occurred.
            </li>
            <li>The same spend is never copied across the user’s other workspaces.</li>
            <li>
              The eligible non-Comcast workspace with the <strong className="text-foreground">highest positive spend</strong> is the user’s primary workspace.
            </li>
            <li>Legacy Comcast spend is assigned to that primary workspace only when one exists.</li>
            <li>If eligible workspaces have equal spend, the workspace ID breaks the tie consistently.</li>
          </RuleList>
          <Callout label="Example">
            If a user spends $80 in Workspace A and $20 in Workspace B, those amounts remain in A and B. Workspace A is primary, so any Comcast workspace spend is assigned to Workspace A.
          </Callout>
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