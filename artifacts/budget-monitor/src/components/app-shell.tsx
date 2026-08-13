import { Link, useLocation } from 'wouter';
import { ReactNode } from 'react';
import {
  LayoutDashboard,
  Bell,
  Settings,
  TrendingUp,
  LogOut,
  ShieldCheck,
  Building2,
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

  // Workspace admins get a read-only, scoped experience with no settings route.
  const navItems = [
    { path: '/', label: 'Dashboard', icon: LayoutDashboard, show: true },
    { path: '/trends', label: 'Trends', icon: TrendingUp, show: true },
    { path: '/alerts', label: 'Alerts', icon: Bell, show: true },
    { path: '/settings', label: 'Settings', icon: Settings, show: isAccountAdmin },
  ].filter((item) => item.show);

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
    <div className="flex min-h-[100dvh] bg-background">
      <aside className="w-64 border-r border-sidebar-border bg-sidebar flex flex-col">
        <div className="p-6 border-b border-sidebar-border">
          <h1 className="text-lg font-bold text-sidebar-foreground tracking-tight">
            Budget Monitor
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Comcast Enterprise
          </p>
        </div>
        <nav className="flex-1 p-4">
          <ul className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = location === item.path;
              return (
                <li key={item.path}>
                  <Link
                    href={item.path}
                    className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-sidebar-primary text-sidebar-primary-foreground'
                        : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                    }`}
                    data-testid={`nav-${item.label.toLowerCase()}`}
                  >
                    <Icon className="h-4 w-4" />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {user && (
          <div
            className="p-4 border-t border-sidebar-border space-y-3"
            data-testid="auth-identity"
          >
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
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
                <Building2 className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                <span className="break-words" title={scopeLabel}>
                  {scopeLabel}
                </span>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={logout}
              data-testid="button-logout"
            >
              <LogOut className="mr-2 h-4 w-4" />
              Log out
            </Button>
          </div>
        )}
      </aside>
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  );
}
