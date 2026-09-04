import { Link, useLocation } from 'wouter';
import { ReactNode, useState, useEffect } from 'react';
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
  TrendingUp,
  BookUser,
  WalletCards,
  BookOpen,
  Check,
  ChevronsUpDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAuthContext } from '@/components/auth-context';
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

export function AppShell({ children }: AppShellProps) {
  const [location] = useLocation();
  const {
    user, isAccountAdmin, isTeamAdmin, isWorkspaceAdmin, capabilities, auth, workspaceIds, logout,
    preview, canPreviewRbac, setPreview, resetPreview, isPreviewing,
  } = useAuthContext();
  const { data: workspacesData } = useListVisibleWorkspaces({
    query: { enabled: canPreviewRbac && !isPreviewing, queryKey: getListVisibleWorkspacesQueryKey() },
  });
  const { data: membersData } = useListDirectoryMembers({}, {
    query: { enabled: canPreviewRbac && !isPreviewing, queryKey: getListDirectoryMembersQueryKey({}) },
  });
  const { data: teamsData } = useGetTeamsBudgets({
    query: { enabled: canPreviewRbac && !isPreviewing, queryKey: getGetTeamsBudgetsQueryKey() },
  });
  const [previewSearch, setPreviewSearch] = useState('');
  const [previewPickerOpen, setPreviewPickerOpen] = useState(false);
  const [previewOptions, setPreviewOptions] = useState<{
    workspaces: VisibleWorkspace[];
    teams: TeamBudget[];
    members: DirectoryMember[];
  }>({ workspaces: [], teams: [], members: [] });
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  useEffect(() => {
    setIsMobileMenuOpen(false);
  }, [location]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsMobileMenuOpen(false);
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, []);

  useEffect(() => {
    if (!isMobileMenuOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isMobileMenuOpen]);

  useEffect(() => {
    if (isPreviewing) return;
    setPreviewOptions((current) => ({
      workspaces: workspacesData ?? current.workspaces,
      teams: teamsData?.budgets ?? current.teams,
      members: membersData ?? current.members,
    }));
  }, [isPreviewing, workspacesData, teamsData, membersData]);

  // Workspace admins get scoped notification history but no account settings.
  const navSections = [
    {
      label: 'Overview',
      items: [
        { path: '/', label: 'Dashboard', icon: LayoutDashboard, show: true, testId: 'nav-dashboard' },
      ],
    },
    {
      label: 'Notifications',
      items: [
        { path: '/alerts', label: 'Email activity', icon: Bell, show: true, testId: 'nav-alerts' },
      ],
    },
    {
      label: 'Administration',
      items: [
        { path: '/user-guide', label: 'User Guide', icon: BookOpen, show: capabilities.canManageAccess, testId: 'nav-user-guide' },
        { path: '/settings', label: 'Settings', icon: Settings, show: capabilities.canManageAccess, testId: 'nav-settings' },
        { path: '/trends', label: 'Trends', icon: TrendingUp, show: true, testId: 'nav-trends' },
        { path: '/workspace-admins', label: 'Team Admins', icon: Users, show: isAccountAdmin, testId: 'nav-workspace-admins' },
        { path: '/workspace-directory', label: 'Workspace Directory', icon: BookUser, show: capabilities.canManageAccess, testId: 'nav-workspace-directory' },
        { path: '/team-budgets', label: 'Team Budgets', icon: WalletCards, show: capabilities.canEditAllocations, testId: 'nav-team-budgets' },
      ],
    },
  ].map((section) => ({
    ...section,
    items: section.items.filter((item) => item.show),
  })).filter((section) => section.items.length > 0);

  const displayName =
    [user?.firstName, user?.lastName].filter(Boolean).join(' ') ||
    user?.email ||
    user?.id ||
    'Signed in';

  const roleLabel = isAccountAdmin
    ? 'Account admin'
    : isWorkspaceAdmin
      ? 'Workspace admin'
      : isTeamAdmin
        ? 'Team admin'
      : 'Member';

  const scopeLabel = isAccountAdmin
      ? 'All workspaces'
      : auth?.teamNames.length
        ? auth.teamNames.join(', ')
      : workspaceIds.length > 0
        ? `${workspaceIds.length} workspace${workspaceIds.length === 1 ? '' : 's'}`
        : 'No workspaces';

  const handlePreviewChange = (value: string) => {
    if (value === 'real') {
      resetPreview();
    } else if (
      value.startsWith('workspace_admin:') ||
      value.startsWith('team_admin:') ||
      value.startsWith('member:')
    ) {
      setPreview(value as typeof preview);
    }
  };
  const normalizedSearch = previewSearch.trim().toLocaleLowerCase();
  const matchesSearch = (...values: Array<string | null | undefined>) =>
    !normalizedSearch || values.some((value) => value?.toLocaleLowerCase().includes(normalizedSearch));
  const selectedPreviewLabel = (() => {
    if (!preview) return 'My real access';
    if (preview.startsWith('workspace_admin:')) {
      const id = preview.slice('workspace_admin:'.length);
      return `Workspace · ${previewOptions.workspaces.find((item) => item.workspaceId === id)?.workspaceName ?? id}`;
    }
    if (preview.startsWith('team_admin:')) {
      return `Team · ${preview.slice('team_admin:'.length)}`;
    }
    const id = preview.slice('member:'.length);
    const member = previewOptions.members.find((item) => item.userId === id);
    return `Member · ${member?.name || member?.username || member?.email || 'Selected member'}`;
  })();
  const matchingMembers = normalizedSearch.length >= 2
    ? previewOptions.members
        .filter((member) => matchesSearch(member.name, member.username, member.email, member.userId))
        .slice(0, 50)
    : [];
  const choosePreview = (value: string) => {
    handlePreviewChange(value);
    setPreviewPickerOpen(false);
    setPreviewSearch('');
  };

  return (
    <div className="flex min-h-[100dvh] bg-background flex-col md:h-[100dvh] md:flex-row md:overflow-hidden">
      {/* Mobile Top Bar */}
      <div className="md:hidden flex-none h-14 border-b border-border bg-background flex items-center justify-between px-4 sticky top-0 z-30">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="-ml-2 h-9 w-9"
            onClick={() => setIsMobileMenuOpen(true)}
            aria-controls="app-navigation"
            aria-expanded={isMobileMenuOpen}
            data-testid="button-open-navigation"
          >
            <Menu className="h-5 w-5" />
            <span className="sr-only">Open menu</span>
          </Button>
          <span className="font-bold tracking-tight text-foreground">Budget Monitor</span>
        </div>
      </div>

      {/* Mobile Overlay */}
      {isMobileMenuOpen && (
        <div
          className="fixed inset-0 bg-background/80 backdrop-blur-sm z-40 md:hidden"
          onClick={() => setIsMobileMenuOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        id="app-navigation"
        aria-label="Primary navigation"
        className={`
          fixed inset-y-0 left-0 z-50 flex h-[100dvh] w-72 flex-col border-r border-sidebar-border bg-sidebar transform transition-transform duration-200 ease-in-out
          md:relative md:inset-auto md:w-64 md:shrink-0 md:translate-x-0
          ${isMobileMenuOpen ? 'translate-x-0 visible' : '-translate-x-full invisible md:visible'}
        `}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-sidebar-border p-4 md:p-6">
          <div>
            <h1 className="text-lg font-bold text-sidebar-foreground tracking-tight">
              Budget Monitor
            </h1>
            <p className="text-xs text-muted-foreground mt-1">
              Comcast Enterprise
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden h-8 w-8 text-muted-foreground"
            onClick={() => setIsMobileMenuOpen(false)}
            data-testid="button-close-navigation"
          >
            <X className="h-5 w-5" />
            <span className="sr-only">Close menu</span>
          </Button>
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="space-y-5">
            {navSections.map((section) => (
              <section key={section.label} aria-labelledby={`nav-section-${section.label.toLowerCase()}`}>
                <h2
                  id={`nav-section-${section.label.toLowerCase()}`}
                  className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
                >
                  {section.label}
                </h2>
                <ul className="space-y-1">
                  {section.items.map((item) => {
                    const Icon = item.icon;
                    const isActive = location === item.path;
                    return (
                      <li key={item.path}>
                        <Link
                          href={item.path}
                          className={`flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors md:py-2 ${
                            isActive
                              ? 'bg-sidebar-primary text-sidebar-primary-foreground'
                              : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                          }`}
                          data-testid={item.testId}
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

        {user && (
          <div
            className="shrink-0 space-y-3 border-t border-sidebar-border bg-sidebar p-4"
            data-testid="auth-identity"
          >
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
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
                {isWorkspaceAdmin && (
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
                <span className="break-words" title={scopeLabel}>
                  {scopeLabel}
                </span>
              </div>
              {canPreviewRbac && (
                <div className="space-y-1.5 border-t border-sidebar-border pt-2" data-testid="rbac-preview-control">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      RBAC preview
                    </span>
                    {isPreviewing && (
                      <Badge variant="outline" className="text-[9px] border-amber-500 text-amber-700 dark:text-amber-300">
                        Simulated
                      </Badge>
                    )}
                  </div>
                  <Popover open={previewPickerOpen} onOpenChange={setPreviewPickerOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={previewPickerOpen}
                        className="h-auto min-h-9 w-full justify-between gap-2 px-2.5 py-2 text-left text-xs font-normal"
                        data-testid="select-rbac-preview"
                      >
                        <span className="min-w-0 truncate">{selectedPreviewLabel}</span>
                        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent
                      align="start"
                      side="top"
                      className="w-[min(22rem,calc(100vw-2rem))] p-0"
                    >
                      <Command shouldFilter={false}>
                        <CommandInput
                          value={previewSearch}
                          onValueChange={setPreviewSearch}
                          placeholder="Search workspace, team, or member…"
                          data-testid="input-rbac-preview-search"
                        />
                        <CommandList className="max-h-64">
                          <CommandEmpty>No matching access view.</CommandEmpty>
                          <CommandGroup heading="Your access">
                            <CommandItem value="real" onSelect={() => choosePreview('real')}>
                              <Check className={!preview ? 'opacity-100' : 'opacity-0'} />
                              My real access
                            </CommandItem>
                          </CommandGroup>
                          <CommandGroup heading="Workspaces">
                            {previewOptions.workspaces
                              .filter((workspace) => matchesSearch(workspace.workspaceName, workspace.workspaceId))
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
                          <CommandGroup heading="Teams">
                            {previewOptions.teams
                              .filter((team) => matchesSearch(team.teamName))
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
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                  {isPreviewing && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-full justify-start px-2 text-xs"
                      onClick={resetPreview}
                      data-testid="button-reset-rbac-preview"
                    >
                      Reset to my real view
                    </Button>
                  )}
                </div>
              )}
            </div>
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
        )}
      </aside>
      <main className="min-w-0 flex-1 overflow-x-hidden md:overflow-y-auto">
        {children}
      </main>
    </div>
  );
}
