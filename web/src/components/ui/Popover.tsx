import { Popover as P } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { usePortalContainer } from './portal';

export const popoverSurface =
  'z-50 rounded-box border border-line bg-card text-fg shadow-popover anim-pop focus:outline-none';

export function Popover({
  trigger,
  children,
  side = 'bottom',
  align = 'center',
  className,
  open,
  onOpenChange,
}: {
  trigger: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const container = usePortalContainer();
  return (
    <P.Root {...(open !== undefined && { open })} {...(onOpenChange && { onOpenChange })}>
      <P.Trigger asChild>{trigger}</P.Trigger>
      <P.Portal container={container}>
        <P.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className={cn(popoverSurface, 'w-72 p-3', className)}
        >
          {children}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}
