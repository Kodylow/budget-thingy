import { Badge } from '@/components/ui/badge';
import { AdminDataQualityNote } from '@/components/admin-data-quality';

export function InternalUserBadge({ compact = false }: { compact?: boolean }) {
  return (
    <Badge
      variant="outline"
      className="h-5 border-blue-500/30 bg-blue-500/10 px-1.5 text-[10px] text-blue-700 dark:text-blue-300"
      title="Internal Replit user"
    >
      {compact ? 'Internal' : 'Internal · Replit'}
    </Badge>
  );
}

export function InternalSpendExplanation() {
  return (
    <AdminDataQualityNote title="Internal usage"><p>
      Internal Replit users remain visible for context. Their usage is excluded from eligible
      spend, budgets, and limits.
    </p></AdminDataQualityNote>
  );
}