import React, { useState, useMemo } from 'react';
import { useListWorkspaceAdmins } from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Search, ShieldCheck, Users } from 'lucide-react';

export interface WorkspaceAdmin {
  userId: string;
  username: string;
  email: string | null;
  name: string | null;
}

export interface WorkspaceAdminFamily {
  workspaceId: string;
  workspaceName: string;
  familyKey: string;
  familyName: string;
  teamName: string | null;
  isLegacy: boolean;
  admins: WorkspaceAdmin[];
}

function readableString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function normalizeWorkspaceAdminFamilies(value: unknown): WorkspaceAdminFamily[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item, familyIndex) => {
      const workspaceId = readableString(item.workspaceId, `unknown-workspace-${familyIndex + 1}`);
      const familyKey = readableString(item.familyKey, `unknown-family-${familyIndex + 1}`);
      const rawAdmins = Array.isArray(item.admins) ? item.admins : [];
      const admins = rawAdmins
        .filter((admin): admin is Record<string, unknown> => !!admin && typeof admin === 'object')
        .map((admin, adminIndex) => ({
          userId: readableString(admin.userId, `${workspaceId}-${familyKey}-admin-${adminIndex + 1}`),
          username: readableString(admin.username, 'Unknown'),
          email: optionalString(admin.email),
          name: optionalString(admin.name),
        }));

      return {
        workspaceId,
        workspaceName: readableString(item.workspaceName, 'Unknown workspace'),
        familyKey,
        familyName: readableString(item.familyName, 'Unnamed family'),
        teamName: optionalString(item.teamName),
        isLegacy: item.isLegacy === true,
        admins,
      };
    });
}

function WorkspaceAdminsLoading() {
  return (
    <div className="p-4 md:p-8" data-testid="workspace-admins-loading">
      <div className="animate-pulse space-y-4">
        <div className="h-8 w-48 bg-muted rounded" />
        <div className="h-64 bg-muted rounded" />
      </div>
    </div>
  );
}

function WorkspaceAdminsError() {
  return (
    <div className="p-4 md:p-8" data-testid="workspace-admins-error" role="alert">
      <h1 className="text-2xl font-bold tracking-tight">Team Admins</h1>
      <p className="mt-2 text-sm text-destructive">
        Failed to load team admin data. Try refreshing the page.
      </p>
    </div>
  );
}

interface FamilyListProps {
  entries: WorkspaceAdminFamily[];
  activeKey: string | null;
  search: string;
  onSelect: (key: string) => void;
}

function FamilyList({ entries, activeKey, search, onSelect }: FamilyListProps) {
  return (
    <Card className="flex-1 overflow-hidden flex flex-col">
      <CardHeader className="py-2.5 px-4 border-b border-border shrink-0">
        <CardTitle className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {entries.length} famil{entries.length === 1 ? 'y' : 'ies'}
          {search ? ' found' : ''}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0 overflow-y-auto flex-1">
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8" data-testid="workspace-admins-empty">
            {search ? 'No families match' : 'No team admin families found'}
          </p>
        ) : (
          <ul>
            {entries.map((entry) => {
              const entryKey = `${entry.workspaceId}::${entry.familyKey}`;
              const isActive = entryKey === activeKey;
              return (
                <li key={entryKey}>
                  <button
                    onClick={() => onSelect(entryKey)}
                    className={`w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left transition-colors border-b border-border ${
                      isActive
                        ? 'bg-primary text-primary-foreground font-medium'
                        : 'hover:bg-muted text-foreground'
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block text-[13px] font-semibold truncate">{entry.familyName}</span>
                      <span className="block text-[11px] truncate opacity-80">
                        {entry.workspaceName} · {entry.teamName ?? 'Unassigned'}
                      </span>
                      {entry.isLegacy && <Badge variant="outline" className="mt-1 text-[9px]">Legacy</Badge>}
                    </span>
                    <Badge variant={isActive ? 'secondary' : 'outline'} className="text-[10px] shrink-0">
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
  );
}

function AdminTable({ admins }: { admins: WorkspaceAdmin[] }) {
  if (admins.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
        <Users className="h-8 w-8 opacity-30" />
        <p className="text-sm">No admins found for this family</p>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="border-b border-border bg-muted/40">
          <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs uppercase tracking-wide">Name</th>
          <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs uppercase tracking-wide">Username</th>
          <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs uppercase tracking-wide">Email</th>
        </tr></thead>
        <tbody>
          {admins.map((admin) => (
            <tr key={admin.userId} className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
              <td className="px-4 py-3 font-medium">{admin.name ?? <span className="text-muted-foreground italic">—</span>}</td>
              <td className="px-4 py-3 text-muted-foreground font-mono text-xs">{admin.username}</td>
              <td className="px-4 py-3 text-muted-foreground">{admin.email ?? <span className="italic">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SelectedFamilyPanel({ family }: { family: WorkspaceAdminFamily | null }) {
  if (!family) {
    return <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">Select a family to view its admins</div>;
  }
  return (
    <Card>
      <CardHeader className="pb-3 border-b border-border">
        <div className="flex flex-wrap items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground shrink-0" />
          <CardTitle className="text-base font-semibold">{family.familyName}</CardTitle>
          {family.isLegacy && <Badge variant="outline" className="text-xs">Legacy</Badge>}
          <Badge variant="secondary" className="text-xs">
            {family.admins.length} admin{family.admins.length !== 1 ? 's' : ''}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          {family.workspaceName} · {family.teamName ?? 'Unassigned'}
        </p>
      </CardHeader>
      <CardContent className="p-0"><AdminTable admins={family.admins} /></CardContent>
    </Card>
  );
}

export default function GroupAdmins() {
  const { data, isLoading, isError } = useListWorkspaceAdmins();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const familyEntries = useMemo(() => {
    const groups = normalizeWorkspaceAdminFamilies(data);
    const q = search.trim().toLowerCase();
    const entries = [...groups].sort((a, b) =>
      a.workspaceName.localeCompare(b.workspaceName, undefined, { sensitivity: 'base' }) ||
      (a.teamName ?? '').localeCompare(b.teamName ?? '', undefined, { sensitivity: 'base' }) ||
      a.familyName.localeCompare(b.familyName, undefined, { sensitivity: 'base' })
    );
    if (!q) return entries;
    const adminMatches = (a: WorkspaceAdmin) =>
      (a.name ?? '').toLowerCase().includes(q) ||
      a.username.toLowerCase().includes(q) ||
      (a.email ?? '').toLowerCase().includes(q);
    return entries.filter((item) =>
      item.workspaceName.toLowerCase().includes(q) ||
      (item.teamName ?? 'unassigned').toLowerCase().includes(q) ||
      item.familyName.toLowerCase().includes(q) ||
      item.admins.some(adminMatches)
    );
  }, [data, search]);

  // Resolve active selection key, falling back to the first visible team
  const activeKey = useMemo(() => {
    const keys = familyEntries.map((item) => `${item.workspaceId}::${item.familyKey}`);
    if (selectedKey !== null && keys.includes(selectedKey)) return selectedKey;
    return keys[0] ?? null;
  }, [familyEntries, selectedKey]);

  const selectedFamily = activeKey
    ? (familyEntries.find((item) => `${item.workspaceId}::${item.familyKey}` === activeKey) ?? null)
    : null;

  if (isLoading) {
    return <WorkspaceAdminsLoading />;
  }

  if (isError || !data) {
    return <WorkspaceAdminsError />;
  }

  return (
    <div className="p-4 md:p-8 space-y-6" data-testid="page-workspace-admins">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Team Admins</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Review each canonical group family and its administrators by workspace and team
        </p>
      </div>

      <div className="flex flex-col md:flex-row gap-4" style={{ minHeight: 'calc(100vh - 220px)' }}>
        {/* Left panel — team list */}
        <aside className="md:w-72 lg:w-80 shrink-0 flex flex-col gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search workspace, team, family, or admin…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setSelectedKey(null);
              }}
              className="pl-8 h-9 text-sm"
            />
          </div>

          <FamilyList entries={familyEntries} activeKey={activeKey} search={search} onSelect={setSelectedKey} />
        </aside>

        {/* Right panel — admin table */}
        <div className="flex-1 min-w-0">
          <SelectedFamilyPanel family={selectedFamily} />
        </div>
      </div>
    </div>
  );
}
