import { X } from 'lucide-react';
import { Dialog as D } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { t } from '../../i18n';
import { usePortalContainer } from './portal';

export type DialogVariant = 'center' | 'sheet';

/**
 * Modal dialog. `variant="sheet"` docks it to the bottom edge (narrow screens, spec 5.1).
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  variant = 'center',
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  variant?: DialogVariant;
  className?: string;
}) {
  const container = usePortalContainer();
  const sheet = variant === 'sheet';
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal container={container}>
        <D.Overlay className="fixed inset-0 z-40 bg-overlay anim-fade" />
        <D.Content
          className={cn(
            'fixed z-50 flex max-h-[85vh] flex-col border border-line bg-card text-fg shadow-popover focus:outline-none',
            sheet
              ? 'inset-x-0 bottom-0 max-h-[80vh] rounded-t-box border-b-0 pb-[env(safe-area-inset-bottom)] anim-sheet'
              : 'top-1/2 left-1/2 w-[min(480px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-box anim-pop',
            className,
          )}
        >
          {sheet && <div aria-hidden className="mx-auto mt-2 h-1 w-9 rounded-full bg-line" />}
          <header className="flex items-start justify-between gap-3 px-5 pt-4 pb-2">
            <div className="min-w-0">
              <D.Title className="text-lg font-semibold">{title}</D.Title>
              {description ? (
                <D.Description className="mt-0.5 text-base text-muted">{description}</D.Description>
              ) : (
                <D.Description className="sr-only">{typeof title === 'string' ? title : ''}</D.Description>
              )}
            </div>
            <D.Close
              aria-label={t('common.close')}
              className="-mr-1.5 inline-flex size-8 shrink-0 items-center justify-center rounded-ctl text-muted hover:bg-hover hover:text-fg coarse:size-11"
            >
              <X size={17} aria-hidden />
            </D.Close>
          </header>
          {children && <div className="min-h-0 flex-1 overflow-auto px-5 py-2">{children}</div>}
          {footer && <footer className="flex justify-end gap-2 px-5 pt-3 pb-4">{footer}</footer>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export const DialogClose = D.Close;
