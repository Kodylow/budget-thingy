import React, { type HTMLAttributes, type ReactNode } from 'react';
import { FileText } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export interface MetricCardProps {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: 'default' | 'warning' | 'danger';
  className?: string;
}

export function MetricCard({ label, value, detail, tone = 'default', className }: MetricCardProps) {
  const color = tone === 'warning'
    ? 'text-amber-700 dark:text-amber-400'
    : tone === 'danger'
      ? 'text-red-700 dark:text-red-400'
      : '';

  return (
    <Card className={cn("rounded-md shadow-none", className)}>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className={cn('font-mono text-2xl font-semibold tracking-tight', color)}>
          {value}
        </CardTitle>
      </CardHeader>
        {detail != null && <CardContent className="text-xs text-muted-foreground">{detail}</CardContent>}
    </Card>
  );
}

export interface JourneyTableColumn {
  label: string;
  className?: string;
}

export interface DataTableProps {
  columns: JourneyTableColumn[];
  rows: ReactNode[][];
  caption?: string;
  rowProps?: (row: ReactNode[], rowIndex: number) => HTMLAttributes<HTMLTableRowElement>;
  rowKeys?: React.Key[];
  rowDetails?: (rowIndex: number) => ReactNode;
}

export function DataTable({ columns, rows, caption, rowProps, rowKeys, rowDetails }: DataTableProps) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[600px] text-sm">
        <caption className="sr-only">{caption ?? 'Budget data'}</caption>
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            {columns.map((column) => (
              <th
                key={column.label}
                className={cn('whitespace-nowrap px-4 py-3 font-medium', column.className)}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row, rowIndex) => {
            const props = rowProps?.(row, rowIndex);
            const details = rowDetails?.(rowIndex);
            return (
            <React.Fragment key={rowKeys?.[rowIndex] ?? rowIndex}>
            <tr {...props} className={cn('bg-card', props?.className)}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className={cn('px-4 py-3', columns[cellIndex]?.className)}>
                  {cell}
                </td>
              ))}
            </tr>
            {details != null && (
              <tr className="bg-muted/20">
                <td colSpan={columns.length} className="p-0">{details}</td>
              </tr>
            )}
            </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export type JourneyStatus = 'Within budget' | 'Near limit' | 'Over budget' | 'Active' | 'Draft' | 'Sent' | 'Failed';

export interface StatusBadgeProps {
  status: JourneyStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const styles = status === 'Over budget' || status === 'Failed'
    ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400'
    : status === 'Near limit'
      ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-400'
      : 'border-border bg-muted text-muted-foreground';

  return (
    <Badge variant="outline" className={cn('whitespace-nowrap font-medium', styles)}>
      {status}
    </Badge>
  );
}

export interface EmptyStateProps {
  title: string;
  description: string;
  action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <Card className="border-dashed shadow-none">
      <CardContent className="flex flex-col items-center px-6 py-14 text-center">
        <FileText className="mb-4 h-8 w-8 text-muted-foreground" />
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-2 max-w-md text-sm text-muted-foreground">{description}</p>
        {action && <div className="mt-5">{action}</div>}
      </CardContent>
    </Card>
  );
}

export { BudgetMeter, type BudgetMeterProps } from '@/components/budget-meter';