import { useState, useMemo } from 'react';
import { useListWorkspaceAdmins } from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Building2, ChevronDown, ChevronRight, Search, ShieldCheck, Users } from 'lucide-react';

interface GroupItem {
  groupId: string;
  groupName: string;
  workspaceId: string;
  workspaceName: string;
  teamName: string | null;
  admins: Array<{ userId: string; username: string; email: string | null; name: string | null }>;
}

interface TeamSection {
  teamName: string;
  groups: GroupItem[];
}

export default function GroupAdmins() {
  const { data: groups, isLoading, isError } = useListWorkspaceAdmins();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [collapsedTeams, setCollapsedTeams] = useState<Set<string>>(new Set());

  const toggleTeam = (teamName: string) => {
    setCollapsedTeams((prev) => {
      const next = new Set(prev);
      if (next.has(teamName)) next.delete(teamName);
      else next.add(teamName);
      return next;
    });
  };

  // Build team sections, filtered by search
  const { teamSections, unassigned } = useMemo(() => {
    if (!groups) return { teamSections: [], unassigned: [] };
    const q = search.trim().toLowerCase();

    const filtered = q
      ? groups.filter(
          (g) =>
            g.groupName.toLowerCase().includes(q) ||
            (g.teamName ?? '').toLowerCase().includes(q) ||
            g.workspaceName.toLowerCase().includes(q),
        )
      : (groups as GroupItem[]);

    const teamMap = new Map<string, GroupItem[]>();
    const unassigned: GroupItem[] = [];

    for (const g of filtered as GroupItem[]) {
      if (g.teamName) {
        const existing = teamMap.get(g.teamName) ?? [];
        existing.push(g);
        teamMap.set(g.teamName, existing);
      } else {
        unassigned.push(g);
      }
    }

    const teamSections: TeamSection[] = Array.from(teamMap.entries())
      .map(([teamName, groups]) => ({ teamName, groups }))
      .sort((a, b) => a.teamName.localeCompare(b.teamName));

    return { teamSections, unassigned };
  }, [groups, search]);

  const allVisible = useMemo(
    () => [...teamSections.flatMap((t) => t.groups), ...unassigned],
    [teamSections, unassigned],
  );

  // Default selection: first visible group
  const selected =
    (groups?.find((g) => g.groupId === selectedId) as GroupItem | undefined) ??
    (allVisible[0] as GroupItem | undefined) ??
    null;
  const activeId = selected?.groupId ?? null;

  const totalCount = allVisible.length;

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

  if (isError || !groups) {
    return (
      <div className="p-4 md:p-8">
        <p className="text-sm text-destructive">Failed to load group admin data.</p>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Group Admins</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Workspace administrators for each group, organized by team
        </p>
      </div>

      <div className="flex flex-col md:flex-row gap-4" style={{ minHeight: 'calc(100vh - 220px)' }}>
        {/* Left panel — team + group list */}
        <aside className="md:w-72 lg:w-80 shrink-0 flex flex-col gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search teams or groups…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setSelectedId(null);
              }}
              className="pl-8 h-9 text-sm"
            />
          </div>

          <Card className="flex-1 overflow-hidden flex flex-col">
            <CardHeader className="py-2.5 px-4 border-b border-border shrink-0">
              <CardTitle className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {totalCount} group{totalCount !== 1 ? 's' : ''}
                {search ? ' found' : ''}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 overflow-y-auto flex-1">
              {totalCount === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No groups match</p>
              ) : (
                <ul>
                  {/* Team sections */}
                  {teamSections.map((section) => {
                    const isCollapsed = collapsedTeams.has(section.teamName);
                    return (
                      <li key={section.teamName}>
                        {/* Team header row */}
                        <button
                          onClick={() => toggleTeam(section.teamName)}
                          className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left bg-muted/60 border-b border-border hover:bg-muted transition-colors"
                        >
                          <span className="flex items-center gap-1.5 min-w-0">
                            {isCollapsed ? (
                              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            ) : (
                              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            )}
                            <span className="text-xs font-semibold text-foreground truncate">
                              {section.teamName}
                            </span>
                          </span>
                          <Badge variant="outline" className="text-[10px] shrink-0">
                            {section.groups.length}
                          </Badge>
                        </button>

                        {/* Groups under this team */}
                        {!isCollapsed && (
                          <ul>
                            {section.groups.map((g) => {
                              const isActive = g.groupId === activeId;
                              return (
                                <li key={g.groupId}>
                                  <button
                                    onClick={() => setSelectedId(g.groupId)}
                                    className={`w-full flex items-start justify-between gap-2 pl-7 pr-4 py-2.5 text-sm text-left transition-colors border-b border-border last:border-0 ${
                                      isActive
                                        ? 'bg-primary text-primary-foreground font-medium'
                                        : 'hover:bg-muted text-foreground'
                                    }`}
                                  >
                                    <span className="min-w-0">
                                      <span className="block truncate text-[13px] font-medium">
                                        {g.groupName}
                                      </span>
                                      <span
                                        className={`block text-[11px] truncate mt-0.5 ${
                                          isActive
                                            ? 'text-primary-foreground/70'
                                            : 'text-muted-foreground'
                                        }`}
                                      >
                                        {g.workspaceName}
                                      </span>
                                    </span>
                                    <Badge
                                      variant={isActive ? 'secondary' : 'outline'}
                                      className="text-[10px] shrink-0 mt-0.5"
                                    >
                                      {g.admins.length}
                                    </Badge>
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </li>
                    );
                  })}

                  {/* Unassigned groups */}
                  {unassigned.length > 0 && (
                    <li>
                      <button
                        onClick={() => toggleTeam('__unassigned__')}
                        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left bg-muted/60 border-b border-border hover:bg-muted transition-colors"
                      >
                        <span className="flex items-center gap-1.5 min-w-0">
                          {collapsedTeams.has('__unassigned__') ? (
                            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          ) : (
                            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          )}
                          <span className="text-xs font-semibold text-muted-foreground truncate italic">
                            Unassigned
                          </span>
                        </span>
                        <Badge variant="outline" className="text-[10px] shrink-0">
                          {unassigned.length}
                        </Badge>
                      </button>
                      {!collapsedTeams.has('__unassigned__') && (
                        <ul>
                          {unassigned.map((g) => {
                            const isActive = g.groupId === activeId;
                            return (
                              <li key={g.groupId}>
                                <button
                                  onClick={() => setSelectedId(g.groupId)}
                                  className={`w-full flex items-start justify-between gap-2 pl-7 pr-4 py-2.5 text-sm text-left transition-colors border-b border-border last:border-0 ${
                                    isActive
                                      ? 'bg-primary text-primary-foreground font-medium'
                                      : 'hover:bg-muted text-foreground'
                                  }`}
                                >
                                  <span className="min-w-0">
                                    <span className="block truncate text-[13px] font-medium">
                                      {g.groupName}
                                    </span>
                                    <span
                                      className={`block text-[11px] truncate mt-0.5 ${
                                        isActive
                                          ? 'text-primary-foreground/70'
                                          : 'text-muted-foreground'
                                      }`}
                                    >
                                      {g.workspaceName}
                                    </span>
                                  </span>
                                  <Badge
                                    variant={isActive ? 'secondary' : 'outline'}
                                    className="text-[10px] shrink-0 mt-0.5"
                                  >
                                    {g.admins.length}
                                  </Badge>
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </li>
                  )}
                </ul>
              )}
            </CardContent>
          </Card>
        </aside>

        {/* Right panel — admin table */}
        <div className="flex-1 min-w-0">
          {selected ? (
            <Card>
              <CardHeader className="pb-3 border-b border-border">
                <div className="flex flex-wrap items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-muted-foreground shrink-0" />
                  <CardTitle className="text-base font-semibold">{selected.groupName}</CardTitle>
                  <Badge variant="secondary" className="text-xs">
                    {selected.admins.length} admin{selected.admins.length !== 1 ? 's' : ''}
                  </Badge>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1">
                  {selected.teamName && (
                    <span className="text-xs text-muted-foreground font-medium">
                      {selected.teamName}
                    </span>
                  )}
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Building2 className="h-3.5 w-3.5" />
                    {selected.workspaceName}
                  </span>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {selected.admins.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
                    <Users className="h-8 w-8 opacity-30" />
                    <p className="text-sm">No admins found for this group's workspace</p>
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
                              {admin.name ?? <span className="text-muted-foreground italic">—</span>}
                            </td>
                            <td className="px-4 py-3 text-muted-foreground font-mono text-xs">
                              {admin.username}
                            </td>
                            <td className="px-4 py-3 text-muted-foreground">
                              {admin.email ?? <span className="italic">—</span>}
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
              Select a group to view its admins
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
