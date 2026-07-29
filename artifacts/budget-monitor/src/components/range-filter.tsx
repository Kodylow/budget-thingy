import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { useRange } from '@/components/range-context';
import { CalendarIcon } from 'lucide-react';
import type { RangeTypeParameter } from '@workspace/api-client-react';

export function RangeFilter() {
  const { rangeType, setRangeType, startDate, setStartDate, endDate, setEndDate } = useRange();

  return (
    <div className="flex items-center gap-2">
      <Select value={rangeType} onValueChange={(val: string) => setRangeType(val as RangeTypeParameter)}>
        <SelectTrigger className="w-[160px] h-9">
          <CalendarIcon className="mr-2 h-4 w-4 text-muted-foreground" />
          <SelectValue placeholder="Select range" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="billing">Billing period</SelectItem>
          <SelectItem value="mtd">Month to date</SelectItem>
          <SelectItem value="ytd">Year to date</SelectItem>
          <SelectItem value="custom">Custom range</SelectItem>
        </SelectContent>
      </Select>
      {rangeType === 'custom' && (
        <div className="flex items-center gap-1">
          <Input 
            type="date" 
            value={startDate || ''} 
            onChange={e => setStartDate(e.target.value)}
            className="w-36 h-9 text-xs"
          />
          <span className="text-muted-foreground text-xs mx-1">to</span>
          <Input 
            type="date" 
            value={endDate || ''} 
            onChange={e => setEndDate(e.target.value)}
            className="w-36 h-9 text-xs"
          />
        </div>
      )}
    </div>
  );
}
