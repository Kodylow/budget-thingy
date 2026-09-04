import { Badge } from '@/components/ui/badge';

export function InternalUserBadge({ compact = false }: { compact?: boolean }) {
  return (
    <Badge
      variant="outline"
      className="h-5 border-blue-500/30 bg-blue-500/10 px-1.5 text-[10px] text-blue-700 dark:text-blue-300"
      title="Internal Replit users are shown for directory context, but their usage is excluded from eligible spend."
    >
      {compact ? 'Internal' : 'Internal · Replit'}
    </Badge>
  );
}

export function InternalSpendExplanation() {
  return (
    <p className="text-xs text-muted-foreground">
      Internal Replit users remain visible for context. Their usage is excluded from eligible
      spend, budgets, and limits.
    </p>
  );
}