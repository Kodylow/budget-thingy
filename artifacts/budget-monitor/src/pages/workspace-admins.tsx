import { useState, useMemo } from 'react';
import { useListWorkspaceAdmins } from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Search, ShieldCheck, Users } from 'lucide-react';

interface GroupItem {
  groupId: string;
  groupName: string;
  workspaceId: string;
  workspaceName: string;
  teamName: string | null;
  admins: Array<{ userId: string; username: string; email: string | null; name: string | null }>;
}

type Admin = GroupItem['admins'][0];

interface TeamEntry {
  key: string;
  teamName: string;
  admins: Admin[];
  groupCount: number;
}

/**
 * Returns true if the group name matches the Admin pattern.
 * Expected format: "{prefix} - {Team Name} - Admin"
 * The last " - "-delimited segment must be "Admin" (case-insensitive).
 */
function isAdminGroup(groupName: string): boolean {
  const parts = groupName.split(' - ');
  return parts.length >= 3 && parts[parts.length - 1]!.trim().toLowerCase() === 'admin';
}

/**
 * Extracts the team name from an Admin group name.
 * "AZ-Replit - Comcast Business Marketing - Admin" → "Comcast Business Marketing"
 */
function parseTeamName(groupName: string): string {
  const parts = groupName.split(' - ');
  // Everything between the first prefix and the trailing "Admin"
  return parts.slice(1, -1).join(' - ').trim();
}

export default function GroupAdmins() {
  const { data: groups, isLoading, isError } = useListWorkspaceAdmins();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // Filter to Admin groups, parse team names, dedupe admins per team, then apply search
  const teamEntries = useMemo(() => {
    if (!groups) return [] as TeamEntry[];
    const q = search.trim().toLowerCase();

    // Keep only groups whose name ends with " - Admin"
    const adminGroups = (groups as GroupItem[]).filter((g) => isAdminGroup(g.groupName));

    // Bucket into teams by the parsed team name
    const teamMap = new Map<string, GroupItem[]>();
    for (const g of adminGroups) {
      const teamName = parseTeamName(g.groupName);
      const existing = teamMap.get(teamName) ?? [];
      existing.push(g);
      teamMap.set(teamName, existing);
    }

    // Build entries with deduped admins (first-seen wins)
    const entries: TeamEntry[] = [];
    for (const [teamName, teamGroups] of teamMap) {
      const seen = new Set<string>();
      const admins: Admin[] = [];
      for (const g of teamGroups) {
        for (const a of g.admins) {
          if (!seen.has(a.userId)) {
            seen.add(a.userId);
            admins.push(a);
          }
        }
      }
      entries.push({ key: teamName, teamName, admins, groupCount: teamGroups.length });
    }
    entries.sort((a, b) => a.teamName.localeCompare(b.teamName));

    // Apply search: match team name or any admin field
    if (!q) return entries;
    const adminMatches = (a: Admin) =>
      (a.name ?? '').toLowerCase().includes(q) ||
      a.username.toLowerCase().includes(q) ||
      (a.email ?? '').toLowerCase().includes(q);
    return entries.filter((t) => t.teamName.toLowerCase().includes(q) || t.admins.some(adminMatches));
  }, [groups, search]);

  const teamCount = teamEntries.length;

  // Resolve active selection key, falling back to the first visible team
  const activeKey = useMemo(() => {
    const keys = teamEntries.map((t) => t.key);
    if (selectedKey !== null && keys.includes(selectedKey)) return selectedKey;
    return keys[0] ?? null;
  }, [teamEntries, selectedKey]);

  const selectedTeam = activeKey ? (teamEntries.find((t) => t.key === activeKey) ?? null) : null;

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
          Workspace administrators drawn from Admin groups, organised by team
        </p>
      </div>

      <div className="flex flex-col md:flex-row gap-4" style={{ minHeight: 'calc(100vh - 220px)' }}>
        {/* Left panel — team list */}
        <aside className="md:w-72 lg:w-80 shrink-0 flex flex-col gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search teams or admins…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setSelectedKey(null);
              }}
              className="pl-8 h-9 text-sm"
            />
          </div>

          <Card className="flex-1 overflow-hidden flex flex-col">
            <CardHeader className="py-2.5 px-4 border-b border-border shrink-0">
              <CardTitle className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {teamCount} team{teamCount !== 1 ? 's' : ''}
                {search ? ' found' : ''}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 overflow-y-auto flex-1">
              {teamCount === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No teams match</p>
              ) : (
                <ul>
                  {teamEntries.map((entry) => {
                    const isActive = entry.key === activeKey;
                    return (
                      <li key={entry.key}>
                        <button
                          onClick={() => setSelectedKey(entry.key)}
                          className={`w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left transition-colors border-b border-border ${
                            isActive
                              ? 'bg-primary text-primary-foreground font-medium'
                              : 'hover:bg-muted text-foreground'
                          }`}
                        >
                          <span className="min-w-0">
                            <span className="block text-[13px] font-semibold truncate">
                              {entry.teamName}
                            </span>
                          </span>
                          <Badge
                            variant={isActive ? 'secondary' : 'outline'}
                            className="text-[10px] shrink-0"
                          >
                            {entry.admins.length}
                          </Badge>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </aside>

        {/* Right panel — admin table */}
        <div className="flex-1 min-w-0">
          {selectedTeam ? (
            <Card>
              <CardHeader className="pb-3 border-b border-border">
                <div className="flex flex-wrap items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-muted-foreground shrink-0" />
                  <CardTitle className="text-base font-semibold">{selectedTeam.teamName}</CardTitle>
                  <Badge variant="secondary" className="text-xs">
                    {selectedTeam.admins.length} admin{selectedTeam.admins.length !== 1 ? 's' : ''}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {selectedTeam.admins.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
                    <Users className="h-8 w-8 opacity-30" />
                    <p className="text-sm">No admins found for this team</p>
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
                        {selectedTeam.admins.map((admin) => (
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
              Select a team to view its admins
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
