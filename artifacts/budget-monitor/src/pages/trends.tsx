import TrendsTab from '@/pages/trends-tab';
import { useListGroups } from '@workspace/api-client-react';

export default function Trends() {
  const { data } = useListGroups({ rangeType: 'billing' });
  const groups = data?.groups ?? [];
  return (
    <div className="p-4 md:p-8 space-y-4 md:space-y-6 max-w-[100vw]">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Trends</h1>
        <p className="text-muted-foreground mt-1 text-sm md:text-base">May 2026–present</p>
      </div>
      <TrendsTab
        teamNames={[...new Set(groups.flatMap((group) => group.teamName ? [group.teamName] : []))]}
        groups={groups.map((group) => ({
          groupId: group.groupId,
          name: group.name,
          teamName: group.teamName ?? null,
        }))}
      />
    </div>
  );
}
