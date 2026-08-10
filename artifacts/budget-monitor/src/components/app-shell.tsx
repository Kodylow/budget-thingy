import { Link, useLocation } from 'wouter';
import { LayoutDashboard, Bell, Settings, TrendingUp } from 'lucide-react';
import { ReactNode } from 'react';

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const [location] = useLocation();

  const navItems = [
    { path: '/', label: 'Dashboard', icon: LayoutDashboard },
    { path: '/trends', label: 'Trends', icon: TrendingUp },
    { path: '/alerts', label: 'Alerts', icon: Bell },
    { path: '/settings', label: 'Settings', icon: Settings },
  ];

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
        <div className="p-4 border-t border-sidebar-border">
          <p className="text-xs text-muted-foreground">
            Monitor group spending across your Replit Enterprise account
          </p>
        </div>
      </aside>
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  );
}
