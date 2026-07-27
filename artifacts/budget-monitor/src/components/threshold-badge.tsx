import { Badge } from '@/components/ui/badge';

interface ThresholdBadgeProps {
  percentUsed: number | null;
  thresholdsFired: number[];
}

export function ThresholdBadge({ percentUsed, thresholdsFired }: ThresholdBadgeProps) {
  if (percentUsed === null) {
    return (
      <Badge variant="outline" className="tabular-nums font-mono text-xs">
        —
      </Badge>
    );
  }

  const hasAlert = thresholdsFired.length > 0;
  const highestFired = thresholdsFired.length > 0 ? Math.max(...thresholdsFired) : 0;

  let variant: 'default' | 'secondary' | 'destructive' | 'outline' = 'outline';
  let bgColor = '';
  let textColor = '';

  if (percentUsed >= 100) {
    variant = 'destructive';
    bgColor = 'bg-chart-4/10';
    textColor = 'text-chart-4';
  } else if (percentUsed >= 90) {
    bgColor = 'bg-chart-3/10';
    textColor = 'text-chart-3';
  } else if (percentUsed >= 75) {
    bgColor = 'bg-chart-2/10';
    textColor = 'text-chart-2';
  } else if (percentUsed >= 50) {
    bgColor = 'bg-chart-2/5';
    textColor = 'text-chart-2';
  } else {
    bgColor = 'bg-chart-1/10';
    textColor = 'text-chart-1';
  }

  return (
    <div className="flex items-center gap-1.5">
      <Badge
        variant={variant === 'destructive' ? 'destructive' : 'outline'}
        className={`tabular-nums font-mono text-xs ${variant !== 'destructive' ? `${bgColor} ${textColor} border-${textColor}/20` : ''}`}
      >
        {percentUsed.toFixed(1)}%
      </Badge>
      {hasAlert && (
        <span className="text-xs text-muted-foreground" title={`Alerted at ${highestFired}%`}>
          ⚠
        </span>
      )}
    </div>
  );
}
