import { createContext, useContext } from 'react';

/**
 * Where floating surfaces (tooltips, popovers, menus, dialogs) are portaled. Defaults to <body>;
 * /dev/ui points it at each themed column so both themes can be shown side by side.
 */
export const PortalContainerContext = createContext<HTMLElement | null>(null);

export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainerContext) ?? undefined;
}
