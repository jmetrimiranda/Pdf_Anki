import { ChevronDown } from 'lucide-react';
import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '../../lib/cn';

const control =
  'w-full rounded-ctl border border-line bg-card text-base text-fg placeholder:text-muted transition-colors hover:border-[color-mix(in_srgb,var(--text)_25%,var(--border))] focus-visible:border-lime focus-visible:outline-2 focus-visible:outline-offset-0 disabled:opacity-50 aria-invalid:border-error';

/** Label + control + hint/error, wired with ids for screen readers. */
export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
  className?: string;
}) {
  const id = useId();
  const describedBy = error || hint ? `${id}-desc` : undefined;
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {label && (
        <label htmlFor={id} className="text-xs text-muted">
          {label}
        </label>
      )}
      {children({ id, describedBy, invalid: !!error })}
      {(error || hint) && (
        <p id={describedBy} className={cn('text-xs', error ? 'text-error' : 'text-muted')}>
          {error || hint}
        </p>
      )}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { leading?: ReactNode }>(
  function Input({ className, leading, ...rest }, ref) {
    if (!leading) return <input ref={ref} className={cn(control, 'h-8 px-2.5 coarse:h-11', className)} {...rest} />;
    return (
      <div className={cn('relative', className)}>
        <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-muted">{leading}</span>
        <input ref={ref} className={cn(control, 'h-8 pl-8 pr-2.5 coarse:h-11')} {...rest} />
      </div>
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, rows = 3, ...rest },
  ref,
) {
  return (
    <textarea ref={ref} rows={rows} className={cn(control, 'min-h-16 resize-y px-2.5 py-1.5', className)} {...rest} />
  );
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <div className={cn('relative', className)}>
      <select ref={ref} className={cn(control, 'h-8 appearance-none pl-2.5 pr-8 coarse:h-11')} {...rest}>
        {children}
      </select>
      <ChevronDown
        size={15}
        aria-hidden
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted"
      />
    </div>
  );
});

export function Checkbox({
  label,
  className,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: ReactNode }) {
  return (
    <label
      className={cn(
        'inline-flex cursor-pointer items-center gap-2 text-base coarse:min-h-11',
        rest.disabled && 'opacity-50',
        className,
      )}
    >
      <input type="checkbox" className="size-4 cursor-pointer rounded-[4px] accent-[var(--lime)]" {...rest} />
      {label}
    </label>
  );
}

export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled,
  className,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn('inline-flex items-center gap-2.5 coarse:min-h-11', disabled && 'opacity-50', className)}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full border transition-colors',
          checked ? 'border-lime-dark bg-lime' : 'border-line bg-empty',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'absolute top-1/2 size-3.5 -translate-y-1/2 rounded-full bg-white transition-[left]',
            checked ? 'left-[18px]' : 'left-0.5',
          )}
        />
      </button>
      <label htmlFor={id} className="cursor-pointer text-base">
        {label}
      </label>
    </div>
  );
}
