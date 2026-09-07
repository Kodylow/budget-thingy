import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { useRange } from '@/components/range-context';
import { CalendarIcon } from 'lucide-react';
import type { RangeSelection } from '@/lib/range-selection';

export function RangeFilter({ selectedLabel }: { selectedLabel?: string }) {
  const {
    rangeSelection,
    setRangeSelection,
    startDate,
    setStartDate,
    endDate,
    setEndDate,
  } = useRange();

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full sm:w-auto min-w-0">
      <Select
        value={rangeSelection}
        onValueChange={(val: string) => setRangeSelection(val as RangeSelection)}
      >
        <SelectTrigger
          aria-label="Reporting period"
          className="h-11 w-full min-w-0 shrink bg-background sm:h-8 sm:w-auto sm:max-w-[200px] lg:max-w-[260px]"
          title={selectedLabel}
        >
          <div className="flex items-center gap-2 overflow-hidden w-full text-left">
            <CalendarIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="truncate flex-1 min-w-0">
              <SelectValue placeholder="Select range">{selectedLabel}</SelectValue>
            </span>
          </div>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="full-term">Full period</SelectItem>
          <SelectItem value="billing">Billing period</SelectItem>
          <SelectItem value="mtd">Month to date</SelectItem>
          <SelectItem value="ytd">Year to date</SelectItem>
          <SelectItem value="custom">Custom range</SelectItem>
        </SelectContent>
      </Select>

      {rangeSelection === 'custom' && (
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1.5 sm:flex sm:h-8 sm:flex-nowrap sm:py-0 min-w-0 w-full sm:w-auto shrink">
          <Input
            type="date"
            aria-label="Reporting start date"
            value={startDate || ''}
            onChange={e => setStartDate(e.target.value)}
            className="h-9 w-full min-w-0 border-0 p-0 text-base shadow-none focus-visible:ring-0 bg-transparent sm:h-6 sm:w-32 sm:min-w-[110px] sm:text-xs"
          />
          <span className="text-muted-foreground text-[10px] uppercase font-semibold shrink-0">to</span>
          <Input
            type="date"
            aria-label="Reporting end date"
            value={endDate || ''}
            onChange={e => setEndDate(e.target.value)}
            className="h-9 w-full min-w-0 border-0 p-0 text-base shadow-none focus-visible:ring-0 bg-transparent sm:h-6 sm:w-32 sm:min-w-[110px] sm:text-xs"
          />
        </div>
      )}
    </div>
  );
}