import React from "react";
import { createContext, useContext, ReactNode, useCallback } from 'react';
import type { RangeTypeParameter } from '@workspace/api-client-react';
import { useSearch, useLocation } from 'wouter';
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
  const search = useSearch();
  const [location, setLocation] = useLocation();
  const searchParams = new URLSearchParams(search);

  const urlRangeType = searchParams.get('rangeType') as RangeTypeParameter | null;
  const urlStartDate = searchParams.get('startDate') || undefined;
  const urlEndDate = searchParams.get('endDate') || undefined;

  const rangeType: RangeTypeParameter = urlRangeType || 'billing';
  let rangeSelection: RangeSelection = (rangeType as any) === 'custom' ? 'custom' :
                                      (rangeType as any) === 'ytd' ? 'ytd' :
                                      (rangeType as any) === 'mtd' ? 'mtd' :
                                      (rangeType as any) === 'full-term' ? 'full-term' : 'billing';

  const initialFullTerm = fullTermDates();
  const startDate = urlStartDate || (rangeSelection === 'full-term' ? initialFullTerm.startDate : undefined);
  const endDate = urlEndDate || (rangeSelection === 'full-term' ? initialFullTerm.endDate : undefined);

  const updateParams = useCallback((updates: Record<string, string | null | undefined>) => {
    const params = new URLSearchParams(window.location.search);
    let changed = false;
    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === undefined) {
        if (params.has(key)) {
          params.delete(key);
          changed = true;
        }
      } else {
        if (params.get(key) !== value) {
          params.set(key, value);
          changed = true;
        }
      }
    }
    if (changed) {
      const newSearch = params.toString();
      setLocation(newSearch ? `${window.location.pathname}?${newSearch}` : window.location.pathname);
    }
  }, [setLocation]);

  const setRangeSelection = useCallback((selection: RangeSelection) => {
    if (selection === 'full-term') {
      const fullTerm = fullTermDates();
      updateParams({
        rangeType: 'full-term',
        startDate: fullTerm.startDate,
        endDate: fullTerm.endDate
      });
    } else {
      updateParams({
        rangeType: apiRangeType(selection),
      });
    }
  }, [updateParams]);

  const setStartDate = useCallback((date?: string) => {
    updateParams({ startDate: date || null });
  }, [updateParams]);

  const setEndDate = useCallback((date?: string) => {
    updateParams({ endDate: date || null });
  }, [updateParams]);

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
