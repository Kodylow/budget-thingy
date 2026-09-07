import React from 'react';

export function ChartKey({ kind, children }: {
  kind: 'actual' | 'projection' | 'budget' | 'cutoff' | 'scenario';
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <svg width="18" height="12" viewBox="0 0 18 12" aria-hidden="true" className="shrink-0">
        {kind === 'scenario' ? <rect x="1" y="2" width="16" height="8" fill="currentColor" fillOpacity=".18" stroke="currentColor" strokeWidth=".5" />
          : kind === 'cutoff' ? <path d="M9 0v12" stroke="currentColor" strokeWidth="2" />
          : <path d="M0 6h18" stroke={kind === 'actual' ? '#0D62FF' : 'currentColor'} strokeWidth="2"
            strokeDasharray={kind === 'projection' ? '5 3' : kind === 'budget' ? '1 3' : undefined} />}
      </svg>
      {children}
    </span>
  );
}

export function ChartTooltip({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="max-w-[min(22rem,calc(100vw-3rem))] rounded-md border bg-popover px-3 py-2.5 text-xs text-popover-foreground">
      <p className="mb-2 font-medium">{title}</p>
      <div className="space-y-1.5 tabular-nums">{children}</div>
    </div>
  );
}