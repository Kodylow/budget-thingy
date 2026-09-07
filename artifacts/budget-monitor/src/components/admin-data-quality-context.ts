import { createContext } from 'react';

export interface AdminDataQualityContextValue {
  canView: boolean;
  target: HTMLDivElement | null;
  openPanel: (invoker: HTMLElement) => void;
}

export const AdminDataQualityContext = createContext<AdminDataQualityContextValue>({
  canView: false,
  target: null,
  openPanel: () => undefined,
});