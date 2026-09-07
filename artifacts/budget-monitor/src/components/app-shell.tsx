import { Link, useLocation, useSearch } from 'wouter';
import { type ReactNode, useEffect, useState } from 'react';
import {
  LayoutDashboard,
  Bell,
  Settings,
  LogOut,
  ShieldCheck,
  Building2,
  Menu,
  X,
  Users,
  WalletCards,
  BookOpen,
  Check,
  ChevronsUpDown,
  CircleUser,
  TriangleAlert,
  FolderCode,
  BarChart3,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAuthContext } from '@/components/auth-context';
import { ApiDiagnostics } from '@/components/api-diagnostics';
import {
  AdminDataQualityProvider,
  AdminDataQualityTrigger,
} from '@/components/admin-data-quality';
import { useVisibleViewport } from '@/lib/use-visible-viewport';
import { reportingNavigationHref, reportingNavigationKey } from '@/lib/reporting-navigation';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  getGetTeamsBudgetsQueryKey,
  getListDirectoryMembersQueryKey,
  getListVisibleWorkspacesQueryKey,
  useGetTeamsBudgets,
  useListDirectoryMembers,
  useListVisibleWorkspaces,
  type DirectoryMember,
  type TeamBudget,
  type VisibleWorkspace,
} from '@workspace/api-client-react';

interface AppShellProps {
  children: ReactNode;
}

interface MobileNavigation {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

interface PreviewOptions {
  workspaces: VisibleWorkspace[];
  teams: TeamBudget[];
  members: DirectoryMember[];
}

interface PreviewOptionsState extends PreviewOptions {
  isLoading: boolean;
  isError: boolean;
  retry: () => void;
}
function useMobileNavigation(): MobileNavigation {
  const [location] = useLocation();
  const search = useSearch();
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    setIsOpen(false);
  }, [location, search]);

  return {
    isOpen,
    open: () => setIsOpen(true),
    close: () => setIsOpen(false),
  };
}

function usePreviewOptions(canPreviewRbac: boolean, isPreviewing: boolean, isOpen: boolean): PreviewOptionsState {
  const workspacesQuery = useListVisibleWorkspaces({
    query: { enabled: canPreviewRbac && !isPreviewing && isOpen, queryKey: getListVisibleWorkspacesQueryKey() },
  });
  const membersQuery = useListDirectoryMembers({}, {
    query: { enabled: canPreviewRbac && !isPreviewing && isOpen, queryKey: getListDirectoryMembersQueryKey({}) },
  });
  const teamsQuery = useGetTeamsBudgets({
    query: { enabled: canPreviewRbac && !isPreviewing && isOpen, queryKey: getGetTeamsBudgetsQueryKey() },
  });
  const workspacesData = workspacesQuery.data;
  const membersData = membersQuery.data;
  const teamsData = teamsQuery.data;
  const [options, setOptions] = useState<PreviewOptions>({
    workspaces: [],
    teams: [],
    members: [],
  });

  useEffect(() => {
    if (isPreviewing) return;
    setOptions((current) => ({
      workspaces: workspacesData ?? current.workspaces,
      teams: teamsData?.budgets ?? current.teams,
      members: membersData ?? current.members,
    }));
  }, [isPreviewing, workspacesData, teamsData, membersData]);

  const enabled = canPreviewRbac && !isPreviewing && isOpen;
  return {
    ...options,
    isLoading: enabled && [workspacesQuery, membersQuery, teamsQuery].some((query) => query.isLoading),
    isError: enabled && [workspacesQuery, membersQuery, teamsQuery].some((query) => query.isError),
    retry: () => {
      void Promise.all([
        workspacesQuery.refetch(),
        membersQuery.refetch(),
        teamsQuery.refetch(),
      ]);
    },
  };
}

function getNavSections(
  capabilities: ReturnType<typeof useAuthContext>['capabilities'],
  role: ReturnType<typeof useAuthContext>['role']
) {
  return [
    {
      label: 'Spend monitoring',
      id: 'spend-monitoring',
      items: [
        { path: '/', label: 'Home', icon: LayoutDashboard, show: true, testId: 'nav-dashboard' },
        { path: '/my-team', label: 'My Team', icon: Users, show: role !== 'denied' && role !== null, testId: 'nav-my-team' },
        { path: '/spend?tab=projects&viewScope=my', label: 'My Projects', icon: FolderCode, show: true, testId: 'nav-my-projects' },
        { path: '/org-insights', label: 'Org Insights', icon: Building2, show: capabilities.canViewAccountUsage === true, testId: 'nav-org-insights' },
        { path: '/spend', label: 'Spend', icon: WalletCards, show: true, testId: 'nav-spend' },
        { path: '/reports', label: 'Custom Reports', icon: BarChart3, show: isAccountAdminOrManager(role) || capabilities.canEditAllocations, testId: 'nav-custom-reports' },
      ],
    },
    {
      label: 'Management',
      id: 'management-admin',
      items: [
        { path: '/allocations', label: 'Budget allocations', icon: WalletCards, show: capabilities.canEditAllocations, testId: 'nav-allocations' },
        { path: '/limits', label: 'Limits', icon: ShieldCheck, show: capabilities.canWriteUserLimitsIn.length > 0, testId: 'nav-limits' },
        { path: '/alerts', label: 'Email activity', icon: Bell, show: role !== 'member' && role !== 'denied' && role !== null, testId: 'nav-alerts' },
        { path: '/access', label: 'Access', icon: Users, show: capabilities.canManageAccess, testId: 'nav-access' },
        { path: '/settings', label: 'Settings', icon: Settings, show: capabilities.canManageSystem || capabilities.canManageNotifications, testId: 'nav-settings' },
      ],
    },
    {
      label: 'Support',
      id: 'support',
      items: [
        { path: '/help', label: 'Help', icon: BookOpen, show: true, testId: 'nav-help' },
      ],
    },
  ].map((section) => ({
    ...section,
    items: section.items.filter((item) => item.show),
  })).filter((section) => section.items.length > 0);
}

function isAccountAdminOrManager(role: ReturnType<typeof useAuthContext>['role']): boolean {
  return role === 'account' || role === 'workspace_admin' || role === 'team_admin';
}

function getDisplayName(user: ReturnType<typeof useAuthContext>['user']): string {
  return (
    [user?.firstName, user?.lastName].filter(Boolean).join(' ') ||
    user?.email ||
    user?.id ||
    'Signed in'
  );
}

function getRoleLabel(
  isAccountAdmin: boolean,
  isWorkspaceAdmin: boolean,
  isTeamAdmin: boolean,
): string {
  if (isAccountAdmin) return 'Account admin';
  if (isWorkspaceAdmin) return 'Workspace admin';
  if (isTeamAdmin) return 'Team admin';
  return 'Member';
}

function getScopeLabel(
  isAccountAdmin: boolean,
  teamNames: string[] | undefined,
  workspaceIds: string[],
): string {
  if (isAccountAdmin) return 'All workspaces';
  if (teamNames?.length) return teamNames.join(', ');
  if (workspaceIds.length > 0) {
    return `${workspaceIds.length} workspace${workspaceIds.length === 1 ? '' : 's'}`;
  }
  return 'No workspaces';
}

function getAuthTeamNames(auth: ReturnType<typeof useAuthContext>['auth']): string[] {
  if (!auth || !('teamNames' in auth) || !Array.isArray(auth.teamNames)) return [];
  return auth.teamNames.filter((teamName): teamName is string => typeof teamName === 'string');
}

function matchesPreviewSearch(
  normalizedSearch: string,
  ...values: Array<string | null | undefined>
): boolean {
  return !normalizedSearch ||
    values.some((value) => value?.toLocaleLowerCase().includes(normalizedSearch));
}

function getSelectedPreviewLabel(
  preview: ReturnType<typeof useAuthContext>['preview'],
  options: PreviewOptions,
): string {
  if (!preview) return 'My real access';
  if (preview.startsWith('workspace_admin:')) {
    const id = preview.slice('workspace_admin:'.length);
    const workspace = options.workspaces.find((item) => item.workspaceId === id);
    return `Workspace · ${workspace?.workspaceName ?? id}`;
  }
  if (preview.startsWith('team_admin:')) {
    return `Team · ${preview.slice('team_admin:'.length)}`;
  }
  const id = preview.slice('member:'.length);
  const member = options.members.find((item) => item.userId === id);
  return `Member · ${member?.name || member?.username || member?.email || 'Selected member'}`;
}

function MobileTopBar({ isOpen, open }: Pick<MobileNavigation, 'isOpen' | 'open'>) {
  const search = useSearch();
  return (
    <div className="xl:hidden flex-none h-14 border-b border-border bg-background flex items-center justify-between px-4 sticky top-0 z-30">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="-ml-2 h-9 w-9"
          onClick={open}
          aria-controls="app-navigation"
          aria-expanded={isOpen}
          data-testid="button-open-navigation"
        >
          <Menu className="h-5 w-5" />
          <span className="sr-only">Open menu</span>
        </Button>
        <Link
          href={reportingNavigationHref('/', search)}
          data-testid="link-overview-brand-mobile"
          className="flex min-h-11 min-w-0 items-center gap-2 rounded-sm font-display text-sm font-bold leading-tight tracking-tight text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <img src={`${import.meta.env.BASE_URL}replit-logo.svg`} alt="" width="18" height="18" className="h-[18px] w-[18px] shrink-0" />
          Replit Budget Monitor
        </Link>
      </div>
    </div>
  );
}

function Navigation({ location }: { location: string }) {
  const { capabilities, role } = useAuthContext();
  const search = useSearch();
  const sections = getNavSections(capabilities, role);

  return (
    <nav className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
      <div className="space-y-5">
        {sections.map((section) => (
          <section key={section.label} aria-labelledby={`nav-section-${section.id}`}>
            <h2
              id={`nav-section-${section.id}`}
              className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-widest text-muted-foreground"
            >
              {section.label}
            </h2>
            <ul className="space-y-1">
              {section.items.map((item) => {
                const Icon = item.icon;
                const isActive = reportingNavigationKey(location, search) === item.path;
                return (
                  <li key={item.path}>
                    <Link
                      href={reportingNavigationHref(item.path, search)}
                      className={`flex min-h-11 items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors md:py-2 ${
                        isActive
                          ? 'bg-primary/10 text-primary'
                          : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                      }`}
                      data-testid={item.testId}
                      aria-current={isActive ? 'page' : undefined}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </nav>
  );
}

interface PreviewGroupProps {
  options: PreviewOptions;
  normalizedSearch: string;
  choosePreview: (value: string) => void;
}

function WorkspacePreviewOptions({
  options,
  normalizedSearch,
  choosePreview,
}: PreviewGroupProps) {
  return (
    <CommandGroup heading="Workspaces">
      {options.workspaces
        .filter((workspace) => matchesPreviewSearch(
          normalizedSearch,
          workspace.workspaceName,
          workspace.workspaceId,
        ))
        .map((workspace) => {
          const value = `workspace_admin:${workspace.workspaceId}`;
          return (
            <CommandItem key={workspace.workspaceId} value={value} onSelect={() => choosePreview(value)}>
              <Building2 />
              <span className="truncate">{workspace.workspaceName}</span>
            </CommandItem>
          );
        })}
    </CommandGroup>
  );
}

function TeamPreviewOptions({ options, normalizedSearch, choosePreview }: PreviewGroupProps) {
  return (
    <CommandGroup heading="Teams">
      {options.teams
        .filter((team) => matchesPreviewSearch(normalizedSearch, team.teamName))
        .map((team) => {
          const value = `team_admin:${team.teamName}`;
          return (
            <CommandItem key={team.teamName} value={value} onSelect={() => choosePreview(value)}>
              <ShieldCheck />
              <span className="truncate">{team.teamName}</span>
            </CommandItem>
          );
        })}
    </CommandGroup>
  );
}

function MemberPreviewOptions({ options, normalizedSearch, choosePreview }: PreviewGroupProps) {
  const matchingMembers = normalizedSearch.length >= 2
    ? options.members
        .filter((member) => matchesPreviewSearch(
          normalizedSearch,
          member.name,
          member.username,
          member.email,
          member.userId,
        ))
    : [];

  return (
    <CommandGroup heading="Members">
      {normalizedSearch.length < 2 ? (
        <div className="px-2 py-3 text-xs text-muted-foreground">
          Type at least 2 characters to search members.
        </div>
      ) : matchingMembers.length ? (
        matchingMembers.map((member) => {
          const value = `member:${member.userId}`;
          return (
            <CommandItem key={member.userId} value={value} onSelect={() => choosePreview(value)}>
              <Users />
              <span className="truncate">{member.name || member.username || member.email}</span>
            </CommandItem>
          );
        })
      ) : (
        <div className="px-2 py-3 text-xs text-muted-foreground">No members found.</div>
      )}
    </CommandGroup>
  );
}

function PreviewPicker() {
  const {
    preview, canPreviewRbac, setPreview, resetPreview, isPreviewing, auth,
  } = useAuthContext();
  const [isOpen, setIsOpen] = useState(false);
  const options = usePreviewOptions(canPreviewRbac, isPreviewing, isOpen);
  const [search, setSearch] = useState('');
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const choosePreview = (value: string) => {
    if (value === 'real') {
      resetPreview();
    } else if (
      value.startsWith('workspace_admin:') ||
      value.startsWith('team_admin:') ||
      value.startsWith('member:')
    ) {
      setPreview(value as typeof preview);
    }
    setIsOpen(false);
    setSearch('');
  };

  if (!canPreviewRbac) return null;
  const isPreviewReadOnly = auth?.previewReadOnly === true;

  return (
    <div className="space-y-1.5 border-t border-sidebar-border pt-2" data-testid="rbac-preview-control">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
          RBAC preview
        </span>
        {isPreviewing && (
          <div className="flex gap-1.5">
            {isPreviewReadOnly && (
              <Badge variant="outline" className="text-[9px] border-muted bg-muted/50">
                Read-only
              </Badge>
            )}
            <Badge variant="outline" className="text-[9px] border-amber-500 text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/30">
              Simulated
            </Badge>
          </div>
        )}
      </div>
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={isOpen}
            className="h-auto min-h-9 w-full justify-between gap-2 px-2.5 py-2 text-left text-xs font-normal bg-background"
            data-testid="select-rbac-preview"
          >
            <span className="min-w-0 truncate">{getSelectedPreviewLabel(preview, options)}</span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" side="top" className="w-[min(22rem,calc(100vw-2rem))] p-0 z-50">
          <Command shouldFilter={false}>
            <CommandInput
              value={search}
              onValueChange={setSearch}
              placeholder="Search workspace, team, or member…"
              data-testid="input-rbac-preview-search"
            />
            <CommandList className="max-h-64">
              {options.isError && (
                <div className="m-2 border border-destructive/30 bg-destructive/5 p-3 text-xs" role="alert" data-testid="status-rbac-preview-options-error">
                  <p>Some preview choices couldn&apos;t be loaded.</p>
                  <Button variant="link" size="sm" className="mt-1 h-auto p-0 text-xs" onClick={options.retry}>
                    Retry
                  </Button>
                </div>
              )}
              {options.isLoading && (
                <div className="px-2 py-2 text-xs text-muted-foreground" role="status">Loading preview choices…</div>
              )}
              <CommandEmpty>No matching access view.</CommandEmpty>
              <CommandGroup heading="Your access">
                <CommandItem value="real" onSelect={() => choosePreview('real')}>
                  <Check className={!preview ? 'opacity-100' : 'opacity-0'} />
                  My real access
                </CommandItem>
              </CommandGroup>
              <WorkspacePreviewOptions
                options={options}
                normalizedSearch={normalizedSearch}
                choosePreview={choosePreview}
              />
              <TeamPreviewOptions
                options={options}
                normalizedSearch={normalizedSearch}
                choosePreview={choosePreview}
              />
              <MemberPreviewOptions
                options={options}
                normalizedSearch={normalizedSearch}
                choosePreview={choosePreview}
              />
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {isPreviewing && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-full justify-start px-2 text-xs text-primary hover:text-primary hover:bg-primary/5"
          onClick={resetPreview}
          data-testid="button-reset-rbac-preview"
        >
          Reset to my real view
        </Button>
      )}
    </div>
  );
}

function IdentityPanel() {
  const {
    user, isAccountAdmin, isTeamAdmin, isWorkspaceAdmin, auth, workspaceIds, logout,
  } = useAuthContext();
  if (!user) return null;

  const displayName = getDisplayName(user);
  const roleLabel = getRoleLabel(isAccountAdmin, isWorkspaceAdmin, isTeamAdmin);
  const scopeLabel = getScopeLabel(isAccountAdmin, getAuthTeamNames(auth), workspaceIds);
  const isPreviewReadOnly = auth?.previewReadOnly === true;

  return (
    <div
      className="shrink-0 space-y-3 border-t border-sidebar-border bg-sidebar p-4"
      data-testid="auth-identity"
    >
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <CircleUser className="h-4 w-4 text-muted-foreground shrink-0" />
          <span
            className="text-sm font-medium text-sidebar-foreground truncate"
            title={displayName}
            data-testid="text-identity-name"
          >
            {displayName}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge
            variant={isAccountAdmin ? 'default' : 'secondary'}
            className="text-[10px]"
            data-testid="badge-role"
          >
            {roleLabel}
          </Badge>
          {isPreviewReadOnly && (
            <Badge variant="outline" className="text-[10px]" data-testid="badge-readonly">
              Read-only
            </Badge>
          )}
        </div>
        <div
          className="flex items-start gap-2 text-xs text-muted-foreground"
          data-testid="text-scope"
        >
          <Building2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span className="break-words" title={scopeLabel}>{scopeLabel}</span>
        </div>
        <PreviewPicker />
      </div>
      <AdminDataQualityTrigger />
      <ApiDiagnostics />
      <Button
        variant="outline"
        size="sm"
        className="w-full justify-start"
        onClick={logout}
        data-testid="button-logout"
      >
        <LogOut className="mr-2 h-4 w-4 shrink-0" />
        Log out
      </Button>
    </div>
  );
}

function DesktopIdentityMenu() {
  const {
    user, isAccountAdmin, isTeamAdmin, isWorkspaceAdmin, auth, workspaceIds, logout, isPreviewing,
  } = useAuthContext();
  if (!user) return null;

  const displayName = getDisplayName(user);
  const roleLabel = getRoleLabel(isAccountAdmin, isWorkspaceAdmin, isTeamAdmin);
  const scopeLabel = getScopeLabel(isAccountAdmin, getAuthTeamNames(auth), workspaceIds);
  const isPreviewReadOnly = auth?.previewReadOnly === true;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="ml-2 gap-2 pl-2 pr-3 relative" aria-label="Account menu" data-testid="button-account-menu">
          <CircleUser className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium truncate max-w-[120px]">{displayName}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-4 flex flex-col gap-3 z-50">
        <div className="space-y-1">
           <div className="font-medium">{displayName}</div>
           <div className="flex flex-wrap items-center gap-1.5 mt-1">
             <Badge variant={isAccountAdmin ? 'default' : 'secondary'} className="text-[10px]">
               {roleLabel}
             </Badge>
             {isPreviewReadOnly && (
               <Badge variant="outline" className="text-[10px]">Read-only</Badge>
             )}
           </div>
           <div className="text-xs text-muted-foreground flex items-start gap-1.5 mt-2">
             <Building2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />
             <span>{scopeLabel}</span>
           </div>
        </div>
        <PreviewPicker />
         <AdminDataQualityTrigger />
        <ApiDiagnostics />
        <Button variant="outline" size="sm" className="w-full justify-start mt-1" onClick={logout}>
          <LogOut className="mr-2 h-4 w-4" />
          Log out
        </Button>
      </PopoverContent>
    </Popover>
  );
}

function DesktopTopBar({ location }: { location: string }) {
  const { capabilities, role } = useAuthContext();
  const search = useSearch();
  const sections = getNavSections(capabilities, role);

  const primarySection = sections.find(s => s.label === 'Spend monitoring');
  const managementSection = sections.find(s => s.label === 'Management');
  const supportSection = sections.find(s => s.label === 'Support');

  return (
    <header className="hidden xl:flex items-center h-16 border-b border-border bg-card px-5 shrink-0 z-30">
      <div className="mr-5 flex shrink-0 items-center">
        <Link
          href={reportingNavigationHref('/', search)}
          data-testid="link-overview-brand"
          className="flex items-center gap-2 rounded-sm font-display text-base font-semibold tracking-tight text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <img src={`${import.meta.env.BASE_URL}replit-logo.svg`} alt="" width="20" height="20" className="h-5 w-5 shrink-0" />
          Replit Budget Monitor
        </Link>
      </div>

      <nav className="flex items-center gap-1 flex-1">
        {primarySection?.items.map(item => {
          const isActive = reportingNavigationKey(location, search) === item.path;
          return (
            <Link
              key={item.path}
              href={reportingNavigationHref(item.path, search)}
              className={`px-2.5 py-2 text-sm whitespace-nowrap font-medium rounded-md transition-colors ${
                isActive ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              }`}
              data-testid={item.testId}
              aria-current={isActive ? 'page' : undefined}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="flex items-center gap-1">
        {supportSection?.items.map(item => {
          const isActive = reportingNavigationKey(location, search) === item.path;
          return (
            <Link
              key={item.path}
              href={reportingNavigationHref(item.path, search)}
              className={`rounded-md px-3 py-2 text-sm font-medium ${
                isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              }`}
              data-testid={item.testId}
              aria-current={isActive ? 'page' : undefined}
            >
              {item.label}
            </Link>
          );
        })}

        {managementSection && managementSection.items.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground font-medium px-3">
                Management
                <ChevronsUpDown className="ml-1.5 h-3.5 w-3.5 opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56 z-50">
              <DropdownMenuLabel className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Management</DropdownMenuLabel>
              {managementSection.items.map(item => {
                const Icon = item.icon;
                const isActive = location === item.path;
                return (
                  <DropdownMenuItem asChild key={item.path}>
                    <Link href={item.path} className="flex items-center w-full cursor-pointer" data-testid={item.testId} aria-current={isActive ? 'page' : undefined}>
                      <Icon className="mr-2 h-4 w-4 text-muted-foreground" />
                      {item.label}
                    </Link>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <div className="w-px h-5 bg-border mx-1" />

        <DesktopIdentityMenu />
      </div>
    </header>
  );
}

function ActivePreviewBanner() {
  const { preview, canPreviewRbac, resetPreview, isPreviewing, auth } = useAuthContext();
  const options = usePreviewOptions(canPreviewRbac, isPreviewing, isPreviewing);

  if (!isPreviewing) return null;
  const isPreviewReadOnly = auth?.previewReadOnly === true;

  return (
    <div data-testid="active-preview-banner" className="bg-amber-100 dark:bg-amber-900/30 border-b border-amber-200 dark:border-amber-900/50 px-4 py-2.5 flex flex-col gap-2 sm:flex-row sm:items-center justify-between text-amber-900 dark:text-amber-200 text-sm shrink-0 z-40">
      <div className="flex min-w-0 flex-wrap items-center gap-2 break-words">
        <span className="font-bold flex items-center gap-1.5"><TriangleAlert className="h-4 w-4"/> Active Preview:</span>
        <span className="font-medium">{getSelectedPreviewLabel(preview, options)}</span>
        {isPreviewReadOnly && <Badge variant="outline" className="border-amber-500 text-amber-800 dark:text-amber-300 text-[10px]">Read-only</Badge>}
      </div>
      <Button variant="outline" size="sm" onClick={resetPreview} className="h-7 border-amber-300 text-amber-900 dark:text-amber-200 hover:bg-amber-200 dark:hover:bg-amber-900/50 bg-amber-50/50 dark:bg-amber-950/50 shrink-0">
        Reset to real view
      </Button>
    </div>
  );
}

interface SidebarProps extends MobileNavigation {
  location: string;
}

function MobileSidebar({ location, isOpen, close }: SidebarProps) {
  const search = useSearch();
  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && close()}>
      <SheetContent
        id="app-navigation"
        side="left"
        className="w-72 max-w-[calc(100vw-2rem)] p-0 flex flex-col bg-sidebar"
        aria-describedby="app-navigation-desc"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          document.querySelector<HTMLButtonElement>('[data-testid="button-open-navigation"]')?.focus();
        }}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-sidebar-border p-4 md:p-6">
          <div className="min-w-0 pr-10">
            <SheetTitle className="font-display text-lg font-bold text-foreground tracking-tight">
              <Link
                href={reportingNavigationHref('/', search)}
                onClick={close}
                className="flex items-center gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <img src={`${import.meta.env.BASE_URL}replit-logo.svg`} alt="" width="20" height="20" className="h-5 w-5 shrink-0" />
                Replit Budget Monitor
              </Link>
            </SheetTitle>
            <p id="app-navigation-desc" className="sr-only">Main navigation</p>
          </div>
        </div>
        <Navigation location={location} />
        <IdentityPanel />
      </SheetContent>
    </Sheet>
  );
}

export { getNavSections };
export function AppShell({ children }: AppShellProps) {
  useVisibleViewport();
  const [location] = useLocation();
  const mobileNavigation = useMobileNavigation();

  return (
    <AdminDataQualityProvider>
      <div className="app-shell flex h-[100dvh] flex-col overflow-hidden bg-background text-foreground relative">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:px-4 focus:py-2 focus:bg-background focus:border focus:z-50 focus:rounded-md focus:shadow-md">
        Skip to content
      </a>
      <ActivePreviewBanner />
      <DesktopTopBar location={location} />
      <MobileTopBar isOpen={mobileNavigation.isOpen} open={mobileNavigation.open} />
      <MobileSidebar location={location} {...mobileNavigation} />

      <main id="main-content" tabIndex={-1} className="min-h-0 min-w-0 flex-1 relative overflow-x-hidden overflow-y-auto focus:outline-none">
        {children}
      </main>
      </div>
    </AdminDataQualityProvider>
  );
}
