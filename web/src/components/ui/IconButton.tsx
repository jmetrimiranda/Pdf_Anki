import type { LucideIcon } from 'lucide-react';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';
import { Tooltip } from './Tooltip';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  /** Accessible name; also shown as the tooltip. */
  label: string;
  size?: 'sm' | 'md';
  variant?: 'ghost' | 'neutral';
  active?: boolean;
  tooltip?: boolean;
  shortcut?: string;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, size = 'md', variant = 'ghost', active, tooltip = true, shortcut, className, type, ...rest },
  ref,
) {
  const button = (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-ctl border transition-colors coarse:size-11 disabled:opacity-40 disabled:pointer-events-none',
        size === 'sm' ? 'size-7' : 'size-8',
        variant === 'neutral' ? 'border-line bg-neutral hover:bg-active' : 'border-transparent hover:bg-hover',
        active ? 'bg-lime-soft text-lime-dark hover:bg-lime-soft' : 'text-fg',
        className,
      )}
      {...rest}
    >
      <Icon size={size === 'sm' ? 15 : 17} strokeWidth={1.9} aria-hidden />
    </button>
  );
  return tooltip ? (
    <Tooltip content={label} shortcut={shortcut}>
      {button}
    </Tooltip>
  ) : (
    button
  );
});
