import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { useRange } from '@/components/range-context';
import { useToast } from '@/hooks/use-toast';

export function GroupUserExport({ groupIds }: { groupIds: string[] }) {
  const { rangeType, startDate, endDate } = useRange();
  const { toast } = useToast();
  const [isExporting, setIsExporting] = useState(false);

  const exportUsers = async () => {
    setIsExporting(true);
    try {
      const params = new URLSearchParams({ rangeType, groupIds: groupIds.join(',') });
      if (rangeType === 'custom') {
        if (startDate) params.set('startDate', startDate);
        if (endDate) params.set('endDate', endDate);
      }
      const response = await fetch(`/api/export/users.csv?${params}`, {
        credentials: 'include',
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error || 'The user export could not be created.');
      }
      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition') ?? '';
      const filenameMatch = disposition.match(/filename[^;=\n]*=["']?([^"';\n]+)/i);
      const filename = filenameMatch?.[1]?.trim()
        ?? `group-users-${new Date().toISOString().slice(0, 10)}.csv`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast({
        title: 'User export failed',
        description: error instanceof Error ? error.message : 'Please try again.',
        variant: 'destructive',
      });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <button
      type="button"
      disabled={isExporting || groupIds.length === 0}
      onClick={() => void exportUsers()}
      className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-input bg-background text-sm font-medium hover:bg-accent hover:text-accent-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      data-testid="button-export-group-users"
    >
      {isExporting
        ? <Loader2 className="h-4 w-4 animate-spin" />
        : <Download className="h-4 w-4" />}
      {isExporting ? 'Exporting…' : 'Export Users'}
    </button>
  );
}