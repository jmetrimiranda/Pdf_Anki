import { Tooltip as T } from 'radix-ui';
import type { ReactNode } from 'react';
import { Kbd } from './Kbd';
import { usePortalContainer } from './portal';

export const TooltipProvider = T.Provider;

export const tooltipSurface =
  'z-50 rounded-ctl border border-line bg-card px-2 py-1 text-xs text-fg shadow-popover anim-fade';

export function Tooltip({
  content,
  shortcut,
  side = 'bottom',
  children,
}: {
  content: ReactNode;
  shortcut?: string | undefined;
  side?: 'top' | 'bottom' | 'left' | 'right';
  children: ReactNode;
}) {
  const container = usePortalContainer();
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal container={container}>
        <T.Content side={side} sideOffset={6} className={tooltipSurface}>
          <span className="inline-flex items-center gap-2">
            {content}
            {shortcut && <Kbd>{shortcut}</Kbd>}
          </span>
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
