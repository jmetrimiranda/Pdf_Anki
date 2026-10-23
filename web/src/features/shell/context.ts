import { createContext, useContext } from 'react';

export interface ShellApi {
  /** Opens the native file picker and imports the chosen PDFs. */
  addBooks: () => void;
  /** Imports paths (drop, "Abrir com"); `openLast` opens the last imported book in the Leitor. */
  importPaths: (paths: string[], opts?: { openLast?: boolean }) => Promise<void>;
  showShortcuts: () => void;
  /** Files are being dragged over the window (Tauri drag and drop). */
  dragging: boolean;
}

export const ShellContext = createContext<ShellApi>({
  addBooks: () => {},
  importPaths: async () => {},
  showShortcuts: () => {},
  dragging: false,
});

export const useShell = () => useContext(ShellContext);
