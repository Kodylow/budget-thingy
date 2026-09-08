import React from "react";
import { createContext, useContext, ReactNode, useCallback, useEffect } from 'react';
import type { RangeTypeParameter } from '@workspace/api-client-react';
import { useSearch, useLocation } from 'wouter';
import {
  normalizeRangeSelection,
  type RangeSelection,
} from '@/lib/range-selection';

interface RangeContextType {
  rangeSelection: RangeSelection;
  setRangeSelection: (selection: RangeSelection) => void;
  rangeType: RangeTypeParameter;
  startDate?: string;
  endDate?: string;
}

const RangeContext = createContext<RangeContextType | undefined>(undefined);

export function RangeProvider({ children }: { children: ReactNode }) {
  const search = useSearch();
  const [, setLocation] = useLocation();
  const searchParams = new URLSearchParams(search);

  const urlRangeType = searchParams.get('rangeType');
  const hasCustomDates = searchParams.has('startDate') || searchParams.has('endDate');
  const rangeSelection = normalizeRangeSelection(urlRangeType);
  const rangeType: RangeTypeParameter = rangeSelection;

  const updateParams = useCallback((updates: Record<string, string | null | undefined>, replace = false) => {
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
      // A new reporting window starts at the first page of the ledger.
      params.delete('page');
      const newSearch = params.toString();
      setLocation(newSearch ? `${window.location.pathname}?${newSearch}` : window.location.pathname, { replace });
    }
  }, [setLocation]);

  const setRangeSelection = useCallback((selection: RangeSelection) => {
    updateParams({
      rangeType: normalizeRangeSelection(selection),
      startDate: null,
      endDate: null,
    });
  }, [updateParams]);

  useEffect(() => {
    if ((urlRangeType !== null && urlRangeType !== rangeSelection) || hasCustomDates) {
      updateParams({ rangeType: rangeSelection, startDate: null, endDate: null }, true);
    }
  }, [urlRangeType, rangeSelection, hasCustomDates, updateParams]);

  return (
    <RangeContext.Provider value={{
      rangeSelection,
      setRangeSelection,
      rangeType,
      startDate: undefined,
      endDate: undefined,
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
