import React from 'react';
import { ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { TableHead } from '@/components/ui/table';
import { cn } from '@/lib/utils';

export type SortDir = 'asc' | 'desc';

interface SortableHeadProps {
  field: string;
  sortBy: string;
  sortDir: SortDir;
  onToggle: (field: string) => void;
  align?: 'left' | 'right';
  className?: string;
  children: React.ReactNode;
}

export function SortableHead({ field, sortBy, sortDir, onToggle, align = 'left', className, children }: SortableHeadProps) {
  const active = sortBy === field;
  return (
    <TableHead
      className={cn(
        "cursor-pointer hover:bg-muted/50 transition-colors select-none",
        align === 'right' && "text-right",
        className
      )}
      onClick={() => onToggle(field)}
    >
      <div className={cn("flex items-center gap-1.5 inline-flex", align === 'right' && "flex-row-reverse justify-end w-full")}>
        {children}
        {active ? (
          sortDir === 'desc' ? <ArrowDown className="w-3.5 h-3.5" /> : <ArrowUp className="w-3.5 h-3.5" />
        ) : (
          <ArrowUpDown className="w-3.5 h-3.5 text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity" />
        )}
      </div>
    </TableHead>
  );
}
