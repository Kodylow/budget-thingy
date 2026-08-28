import { createContext, useContext, useState, ReactNode } from 'react';
import type { RangeTypeParameter } from '@workspace/api-client-react';
import {
  apiRangeType,
  fullTermDates,
  type RangeSelection,
} from '@/lib/range-selection';

interface RangeContextType {
  rangeSelection: RangeSelection;
  setRangeSelection: (selection: RangeSelection) => void;
  rangeType: RangeTypeParameter;
  startDate?: string;
  setStartDate: (date?: string) => void;
  endDate?: string;
  setEndDate: (date?: string) => void;
}

const RangeContext = createContext<RangeContextType | undefined>(undefined);

export function RangeProvider({ children }: { children: ReactNode }) {
  const initialFullTerm = fullTermDates();
  const [rangeSelection, setRangeSelectionState] = useState<RangeSelection>('full-term');
  const [startDate, setStartDate] = useState<string | undefined>(initialFullTerm.startDate);
  const [endDate, setEndDate] = useState<string | undefined>(initialFullTerm.endDate);
  const rangeType = apiRangeType(rangeSelection) as RangeTypeParameter;

  const setRangeSelection = (selection: RangeSelection) => {
    setRangeSelectionState(selection);
    if (selection === 'full-term') {
      const fullTerm = fullTermDates();
      setStartDate(fullTerm.startDate);
      setEndDate(fullTerm.endDate);
    }
  };

  return (
    <RangeContext.Provider value={{
      rangeSelection,
      setRangeSelection,
      rangeType,
      startDate,
      setStartDate,
      endDate,
      setEndDate,
    }}>
      {children}
    </RangeContext.Provider>
  );
}

export function useRange() {
  const context = useContext(RangeContext);
  if (!context) throw new Error('useRange must be used within RangeProvider');
  return context;
}
