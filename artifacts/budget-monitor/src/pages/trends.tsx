import TrendsTab from '@/pages/trends-tab';

export default function Trends() {
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Trends</h1>
        <p className="text-muted-foreground mt-1">May 2026–present</p>
      </div>
      {/* teamNames=[] is fine — TrendsTab derives team list from its own API response */}
      <TrendsTab teamNames={[]} />
    </div>
  );
}
