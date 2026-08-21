import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Download, FileSpreadsheet, Info } from 'lucide-react';
import { useRange } from '@/components/range-context';

export default function ProjectExport() {
  const { rangeType, startDate, endDate } = useRange();
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDownload = async () => {
    setDownloading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (rangeType) params.set('rangeType', rangeType);
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);

      const qs = params.toString();
      const url = `/api/projects/export${qs ? `?${qs}` : ''}`;

      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${response.status}`);
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);

      const today = new Date().toISOString().slice(0, 10);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = `project-spend-${today}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  };

  const columns = [
    { name: 'Project Title', description: 'Display name of the Replit project' },
    { name: 'Project ID', description: 'Unique Replit project identifier' },
    { name: 'Workspace', description: 'Workspace the project belongs to' },
    { name: 'Owner Name', description: 'Full name of the project creator' },
    { name: 'Owner Username', description: 'Replit username of the project creator' },
    { name: 'Team(s)', description: 'Teams the project was attributed to (semicolon-separated)' },
    { name: 'Group(s)', description: 'Groups the project appeared in (semicolon-separated)' },
    { name: 'AI ($)', description: 'AI model spend' },
    { name: 'Hosting ($)', description: 'Hosting / compute spend' },
    { name: 'Storage ($)', description: 'Storage spend' },
    { name: 'Other ($)', description: 'All other spend categories' },
    { name: 'Total ($)', description: 'Total spend across all categories' },
  ];

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Project Spend Export</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Download a CSV of spend per project across all groups, including project owner.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3 border-b border-border">
          <div className="flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base font-semibold">CSV Download</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="pt-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            Exports one row per project across all groups using the currently selected date range.
            When a project appears in multiple groups, only the highest-reported spend entry is
            included to avoid double-counting.
          </p>

          {error && (
            <div className="rounded-md bg-destructive/10 border border-destructive/20 px-4 py-3">
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}

          <Button
            onClick={handleDownload}
            disabled={downloading}
            className="gap-2"
          >
            <Download className="h-4 w-4" />
            {downloading ? 'Preparing…' : 'Download CSV'}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Info className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-sm font-semibold">Columns included</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y divide-border">
            {columns.map((col) => (
              <div key={col.name} className="flex items-start gap-4 px-4 py-2.5">
                <Badge variant="outline" className="shrink-0 mt-0.5 font-mono text-[11px]">
                  {col.name}
                </Badge>
                <span className="text-sm text-muted-foreground">{col.description}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Owner data is sourced from the Replit directory cache. If project titles or owners are
        blank, the cache may not have synced yet — return to the dashboard to trigger a refresh.
      </p>
    </div>
  );
}
