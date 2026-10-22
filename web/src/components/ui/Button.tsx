import type { LucideIcon } from 'lucide-react';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'neutral' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  iconRight?: LucideIcon;
  loading?: boolean;
}

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-lime border-lime-dark text-on-lime font-semibold hover:bg-lime-dark hover:border-lime-dark',
  neutral: 'bg-neutral border-line text-fg hover:bg-active',
  ghost: 'bg-transparent border-transparent text-fg hover:bg-hover',
  danger: 'bg-transparent border-line text-error hover:bg-error-soft hover:border-error',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 gap-1.5 text-xs',
  md: 'h-8 px-3 gap-2 text-base',
  lg: 'h-10 px-4 gap-2 text-base',
};

export const buttonBase =
  'inline-flex select-none items-center justify-center whitespace-nowrap rounded-ctl border transition-colors coarse:min-h-11 disabled:opacity-50 disabled:pointer-events-none';

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'neutral',
    size = 'md',
    icon: Icon,
    iconRight: IconRight,
    loading,
    className,
    children,
    disabled,
    type,
    ...rest
  },
  ref,
) {
  const iconSize = size === 'sm' ? 14 : 16;
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cn(buttonBase, variants[variant], sizes[size], className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner /> : Icon && <Icon size={iconSize} aria-hidden strokeWidth={2} />}
      {children}
      {IconRight && <IconRight size={iconSize} aria-hidden strokeWidth={2} />}
    </button>
  );
});
