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
    <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:items-center">
      <Select
        value={rangeSelection}
        onValueChange={(val: string) => setRangeSelection(val as RangeSelection)}
      >
        <SelectTrigger className={selectedLabel ? 'h-9 w-full sm:w-[260px]' : 'h-9 w-full sm:w-[160px]'}>
          <CalendarIcon className="mr-2 h-4 w-4 text-muted-foreground" />
          <SelectValue placeholder="Select range">
            {selectedLabel}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="full-term">Full term</SelectItem>
          <SelectItem value="billing">Billing period</SelectItem>
          <SelectItem value="mtd">Month to date</SelectItem>
          <SelectItem value="ytd">Year to date</SelectItem>
          <SelectItem value="custom">Custom range</SelectItem>
        </SelectContent>
      </Select>
      {rangeSelection === 'full-term' && !selectedLabel && (
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          May 20, 2026–present
        </span>
      )}
      {rangeSelection === 'custom' && (
        <div className="flex flex-wrap items-center gap-1">
          <Input
            type="date"
            value={startDate || ''}
            onChange={e => setStartDate(e.target.value)}
            className="h-9 min-w-32 flex-1 text-xs sm:w-36 sm:flex-none"
          />
          <span className="text-muted-foreground text-xs mx-1">to</span>
          <Input
            type="date"
            value={endDate || ''}
            onChange={e => setEndDate(e.target.value)}
            className="h-9 min-w-32 flex-1 text-xs sm:w-36 sm:flex-none"
          />
        </div>
      )}
    </div>
  );
}
