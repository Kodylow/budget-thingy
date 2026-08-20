import { useState } from 'react';
import { useListWorkspaceAdmins } from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Building2, ShieldCheck, Users } from 'lucide-react';

export default function WorkspaceAdmins() {
  const { data: workspaces, isLoading, isError } = useListWorkspaceAdmins();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = workspaces?.find((ws) => ws.workspaceId === selectedId) ?? workspaces?.[0] ?? null;
  const activeId = selected?.workspaceId ?? null;

  if (isLoading) {
    return (
      <div className="p-4 md:p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 bg-muted rounded" />
          <div className="h-64 bg-muted rounded" />
        </div>
      </div>
    );
  }

  if (isError || !workspaces) {
    return (
      <div className="p-4 md:p-8">
        <p className="text-sm text-destructive">Failed to load workspace admin data.</p>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Workspace Admins</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Administrators for each Enterprise workspace
        </p>
      </div>

      <div className="flex flex-col md:flex-row gap-4 min-h-0">
        {/* Left panel — workspace list */}
        <aside className="md:w-56 lg:w-64 shrink-0">
          <Card className="overflow-hidden">
            <CardHeader className="py-3 px-4 border-b border-border">
              <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Workspaces
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ul>
                {workspaces.map((ws) => {
                  const isActive = ws.workspaceId === activeId;
                  return (
                    <li key={ws.workspaceId}>
                      <button
                        onClick={() => setSelectedId(ws.workspaceId)}
                        className={`w-full flex items-center justify-between gap-2 px-4 py-2.5 text-sm text-left transition-colors border-b border-border last:border-0 ${
                          isActive
                            ? 'bg-primary text-primary-foreground font-medium'
                            : 'hover:bg-muted text-foreground'
                        }`}
                      >
                        <span className="flex items-center gap-2 min-w-0">
                          <Building2 className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{ws.workspaceName}</span>
                        </span>
                        <Badge
                          variant={isActive ? 'secondary' : 'outline'}
                          className="text-[10px] shrink-0"
                        >
                          {ws.admins.length}
                        </Badge>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        </aside>

        {/* Right panel — admin table */}
        <div className="flex-1 min-w-0">
          {selected ? (
            <Card>
              <CardHeader className="pb-3 border-b border-border">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                  <CardTitle className="text-base font-semibold">
                    {selected.workspaceName}
                  </CardTitle>
                  <Badge variant="secondary" className="text-xs">
                    {selected.admins.length} admin{selected.admins.length !== 1 ? 's' : ''}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {selected.admins.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
                    <Users className="h-8 w-8 opacity-30" />
                    <p className="text-sm">No admins listed for this workspace</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border bg-muted/40">
                          <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs uppercase tracking-wide">
                            Name
                          </th>
                          <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs uppercase tracking-wide">
                            Username
                          </th>
                          <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs uppercase tracking-wide">
                            Email
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {selected.admins.map((admin) => (
                          <tr
                            key={admin.userId}
                            className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors"
                          >
                            <td className="px-4 py-3 font-medium">
                              {admin.name ?? (
                                <span className="text-muted-foreground italic">—</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-muted-foreground font-mono text-xs">
                              {admin.username}
                            </td>
                            <td className="px-4 py-3 text-muted-foreground">
                              {admin.email ?? (
                                <span className="italic">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          ) : (
            <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">
              Select a workspace to view its admins
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
