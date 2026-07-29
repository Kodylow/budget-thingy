import { createContext, useContext, useState, ReactNode } from 'react';
import type { RangeTypeParameter } from '@workspace/api-client-react';

interface RangeContextType {
  rangeType: RangeTypeParameter;
  setRangeType: (type: RangeTypeParameter) => void;
  startDate?: string;
  setStartDate: (date?: string) => void;
  endDate?: string;
  setEndDate: (date?: string) => void;
}

const RangeContext = createContext<RangeContextType | undefined>(undefined);

export function RangeProvider({ children }: { children: ReactNode }) {
  const [rangeType, setRangeType] = useState<RangeTypeParameter>('billing');
  const [startDate, setStartDate] = useState<string>();
  const [endDate, setEndDate] = useState<string>();

  return (
    <RangeContext.Provider value={{ rangeType, setRangeType, startDate, setStartDate, endDate, setEndDate }}>
      {children}
    </RangeContext.Provider>
  );
}

export function useRange() {
  const context = useContext(RangeContext);
  if (!context) throw new Error('useRange must be used within RangeProvider');
  return context;
}
