import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useRange } from '@/components/range-context';
import { CalendarIcon } from 'lucide-react';
import { type RangeSelection } from '@/lib/range-selection';

const rangeOptions: Array<{ value: RangeSelection; label: string }> = [
  { value: 'full-term', label: 'Full term' },
  { value: 'billing', label: 'Billing period' },
];

export function RangeFilter({
  selectedLabel,
}: {
  selectedLabel?: string;
}) {
  const {
    rangeSelection,
    setRangeSelection,
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
          {rangeOptions.map(({ value, label }) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}