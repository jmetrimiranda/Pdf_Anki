import type { LucideIcon } from 'lucide-react';
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface TabItem<V extends string> {
  value: V;
  label: ReactNode;
  icon?: LucideIcon;
  disabled?: boolean;
}

export const tabIdFor = (base: string, value: string) => `${base}-tab-${value}`;
export const panelIdFor = (base: string, value: string) => `${base}-panel-${value}`;

/**
 * Underlined tabs (spec painel 4.2): 2px lime underline and lime-dark 600 text on the active tab.
 * Arrow keys move between tabs (automatic activation), Home/End jump to the ends.
 */
export function Tabs<V extends string>({
  items,
  value,
  onValueChange,
  label,
  idBase,
  size = 'md',
  stretch,
  className,
}: {
  items: TabItem<V>[];
  value: V;
  onValueChange: (v: V) => void;
  label: string;
  idBase: string;
  size?: 'sm' | 'md';
  stretch?: boolean;
  className?: string;
}) {
  const refs = useRef(new Map<V, HTMLButtonElement>());
  const enabled = items.filter((i) => !i.disabled);

  function onKeyDown(e: KeyboardEvent) {
    const current = enabled.findIndex((i) => i.value === value);
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (current + 1) % enabled.length;
    else if (e.key === 'ArrowLeft') next = (current - 1 + enabled.length) % enabled.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = enabled.length - 1;
    if (next === null) return;
    e.preventDefault();
    const item = enabled[next];
    if (!item) return;
    onValueChange(item.value);
    refs.current.get(item.value)?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn('flex overflow-x-auto border-b border-line [scrollbar-width:none]', className)}
    >
      {items.map((item) => {
        const selected = item.value === value;
        const Icon = item.icon;
        return (
          <button
            key={item.value}
            ref={(el) => {
              if (el) refs.current.set(item.value, el);
              else refs.current.delete(item.value);
            }}
            id={tabIdFor(idBase, item.value)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panelIdFor(idBase, item.value)}
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            onClick={() => onValueChange(item.value)}
            className={cn(
              'relative -mb-px inline-flex items-center justify-center gap-1.5 border-b-2 px-3 whitespace-nowrap transition-colors coarse:min-h-11 disabled:opacity-40',
              size === 'sm' ? 'h-8 text-xs' : 'h-9 text-base',
              stretch && 'flex-1',
              selected ? 'border-lime font-semibold text-lime-dark' : 'border-transparent text-muted hover:text-fg',
            )}
          >
            {Icon && <Icon size={size === 'sm' ? 14 : 15} aria-hidden />}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({
  idBase,
  value,
  active,
  children,
  className,
}: {
  idBase: string;
  value: string;
  active: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="tabpanel"
      id={panelIdFor(idBase, value)}
      aria-labelledby={tabIdFor(idBase, value)}
      hidden={!active}
      tabIndex={0}
      className={cn('focus-visible:outline-offset-[-2px]', className)}
    >
      {active && children}
    </div>
  );
}
