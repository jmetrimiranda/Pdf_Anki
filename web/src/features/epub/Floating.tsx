// A floating surface anchored to a rectangle of the reader host (the selection, an annotation, a word): Radix
// Popper places it beside the rectangle — above by default, below when there is no room — so it never covers it.
import { Popover as P } from 'radix-ui';
import type { ReactNode } from 'react';
import { popoverSurface } from '../../components/ui';
import { cn } from '../../lib/cn';
import type { Rect } from './session';

export function Floating({
  rect,
  open,
  onOpenChange,
  side = 'top',
  className,
  label,
  container,
  keepFocus,
  children,
  testId,
}: {
  rect: Rect;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: 'top' | 'bottom';
  className?: string;
  label: string;
  container: HTMLElement | null;
  /** Don't move the focus into the surface (the selection toolbar: the book keeps the focus). */
  keepFocus?: boolean;
  children: ReactNode;
  testId?: string;
}) {
  const [left, top, width, height] = rect;
  return (
    <P.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <P.Anchor asChild>
        <div
          aria-hidden
          className="pointer-events-none absolute"
          style={{ left, top, width: Math.max(1, width), height: Math.max(1, height) }}
        />
      </P.Anchor>
      <P.Portal container={container ?? undefined}>
        <P.Content
          side={side}
          align="center"
          sideOffset={8}
          collisionPadding={8}
          avoidCollisions
          aria-label={label}
          data-testid={testId}
          onOpenAutoFocus={keepFocus ? (e) => e.preventDefault() : undefined}
          onCloseAutoFocus={(e) => e.preventDefault()}
          className={cn(popoverSurface, 'p-1.5', className)}
        >
          {children}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}
