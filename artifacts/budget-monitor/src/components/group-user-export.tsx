import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { useRange } from '@/components/range-context';
import { useToast } from '@/hooks/use-toast';
import { downloadAuthenticatedBlob } from '@/lib/download';

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
      await downloadAuthenticatedBlob(`/api/export/users.csv?${params}`, {
        filename: `group-users-${new Date().toISOString().slice(0, 10)}.csv`,
      });
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