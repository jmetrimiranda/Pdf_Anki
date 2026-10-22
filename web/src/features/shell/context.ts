import { createContext, useContext } from 'react';

export interface ShellApi {
  openFile: () => void;
  showShortcuts: () => void;
}

export const ShellContext = createContext<ShellApi>({ openFile: () => {}, showShortcuts: () => {} });

export const useShell = () => useContext(ShellContext);
