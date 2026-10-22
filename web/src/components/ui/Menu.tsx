import type { LucideIcon } from 'lucide-react';
import { Check } from 'lucide-react';
import { DropdownMenu as M } from 'radix-ui';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Kbd } from './Kbd';
import { popoverSurface } from './Popover';
import { usePortalContainer } from './portal';

export type MenuEntry =
  | {
      kind?: 'item';
      label: string;
      icon?: LucideIcon;
      shortcut?: string;
      onSelect: () => void;
      danger?: boolean;
      disabled?: boolean;
      checked?: boolean;
    }
  | { kind: 'separator' }
  | { kind: 'label'; label: string };

export const menuItemClass =
  'flex h-8 cursor-default select-none items-center gap-2.5 rounded-[5px] px-2 text-base outline-none data-[highlighted]:bg-hover data-[disabled]:opacity-40 coarse:h-11';

export function Menu({
  trigger,
  items,
  align = 'end',
  label,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: {
  trigger: ReactNode;
  items: MenuEntry[];
  align?: 'start' | 'center' | 'end';
  label?: string;
  /** Controlled mode, for menus opened from elsewhere (e.g. Shift+F10 on a tree row). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCloseAutoFocus?: (e: Event) => void;
}) {
  const container = usePortalContainer();
  return (
    <M.Root modal={false} open={open} onOpenChange={onOpenChange}>
      <M.Trigger asChild>{trigger}</M.Trigger>
      <M.Portal container={container}>
        <M.Content
          align={align}
          sideOffset={6}
          collisionPadding={8}
          aria-label={label}
          onCloseAutoFocus={onCloseAutoFocus}
          className={cn(popoverSurface, 'min-w-52 p-1')}
        >
          {items.map((item, i) => {
            if (item.kind === 'separator') return <M.Separator key={i} className="mx-1 my-1 h-px bg-line" />;
            if (item.kind === 'label')
              return (
                <M.Label key={i} className="px-2 pt-1.5 pb-1 text-2xs font-semibold tracking-wide text-muted uppercase">
                  {item.label}
                </M.Label>
              );
            const Icon = item.icon;
            return (
              <M.Item
                key={i}
                disabled={item.disabled}
                onSelect={item.onSelect}
                className={cn(menuItemClass, item.danger && 'text-error')}
              >
                <span className="flex size-4 items-center justify-center text-muted">
                  {item.checked ? (
                    <Check size={15} className="text-lime-dark" aria-hidden />
                  ) : (
                    Icon && <Icon size={15} aria-hidden />
                  )}
                </span>
                <span className="flex-1 truncate">{item.label}</span>
                {item.shortcut && <Kbd>{item.shortcut}</Kbd>}
              </M.Item>
            );
          })}
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}
