import type { LucideIcon } from 'lucide-react';
import { useRef, type KeyboardEvent } from 'react';
import { cn } from '../../lib/cn';

export interface Segment<V extends string> {
  value: V;
  label: string;
  icon?: LucideIcon;
}

export function SegmentedControl<V extends string>({
  value,
  onChange,
  options,
  label,
  size = 'md',
  className,
}: {
  value: V;
  onChange: (v: V) => void;
  options: Segment<V>[];
  label: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  function onKeyDown(e: KeyboardEvent) {
    const delta =
      e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (index + delta + options.length) % options.length;
    const opt = options[next];
    if (opt) {
      onChange(opt.value);
      refs.current[next]?.focus();
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn('inline-flex rounded-ctl border border-line bg-neutral p-0.5', className)}
    >
      {options.map((o, i) => {
        const selected = i === index;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-[5px] px-2.5 transition-colors coarse:min-h-10',
              size === 'sm' ? 'h-6 text-xs' : 'h-7 text-base',
              selected ? 'bg-card font-semibold text-fg shadow-[0_0_0_1px_var(--border)]' : 'text-muted hover:text-fg',
            )}
          >
            {Icon && <Icon size={14} aria-hidden />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
