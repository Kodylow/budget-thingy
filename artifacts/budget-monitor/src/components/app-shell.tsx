import { Link, useLocation } from 'wouter';
import { ReactNode, useState, useEffect } from 'react';
import {
  LayoutDashboard,
  Bell,
  Settings,
  TrendingUp,
  LogOut,
  ShieldCheck,
  Building2,
  Menu,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAuthContext } from '@/components/auth-context';

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const [location] = useLocation();
  const { user, isAccountAdmin, isAccountEditor, isWorkspaceAdmin, workspaceIds, logout } =
    useAuthContext();
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

  // Workspace admins get scoped notification history but no account settings.
  const navSections = [
    {
      label: 'Overview',
      items: [
        { path: '/', label: 'Dashboard', icon: LayoutDashboard, show: true, testId: 'nav-dashboard' },
        { path: '/trends', label: 'Trends', icon: TrendingUp, show: true, testId: 'nav-trends' },
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
        { path: '/settings', label: 'Settings', icon: Settings, show: isAccountAdmin, testId: 'nav-settings' },
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
    : isAccountEditor
      ? 'Account editor'
    : isWorkspaceAdmin
      ? 'Workspace admin'
      : 'Member';

  const scopeLabel = isAccountAdmin || isAccountEditor
    ? 'All workspaces'
    : workspaceIds.length > 0
      ? `${workspaceIds.length} workspace${workspaceIds.length === 1 ? '' : 's'}`
      : 'No workspaces';

  return (
    <div className="flex min-h-[100dvh] bg-background flex-col md:flex-row">
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
          fixed inset-y-0 left-0 z-50 w-72 md:w-64 border-r border-sidebar-border bg-sidebar flex flex-col transform transition-transform duration-200 ease-in-out
          md:relative md:translate-x-0
          ${isMobileMenuOpen ? 'translate-x-0 visible' : '-translate-x-full invisible md:visible'}
        `}
      >
        <div className="p-4 md:p-6 border-b border-sidebar-border flex items-center justify-between">
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
        <nav className="flex-1 p-4 overflow-y-auto">
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
            className="p-4 border-t border-sidebar-border space-y-3 bg-sidebar"
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
                  variant={isAccountAdmin || isAccountEditor ? 'default' : 'secondary'}
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
      <main className="flex-1 overflow-x-hidden md:overflow-auto min-w-0">
        {children}
      </main>
    </div>
  );
}
