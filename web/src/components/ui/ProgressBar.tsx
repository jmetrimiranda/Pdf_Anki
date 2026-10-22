import { cn } from '../../lib/cn';

export function ProgressBar({
  value,
  max = 100,
  label,
  showValue,
  className,
}: {
  /** Omit for an indeterminate bar. */
  value?: number;
  max?: number;
  label: string;
  showValue?: boolean;
  className?: string;
}) {
  const pct = value === undefined ? undefined : Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-empty"
      >
        <div
          className={cn('h-full rounded-full bg-lime transition-[width]', pct === undefined && 'w-1/3 anim-shimmer')}
          style={pct === undefined ? undefined : { width: `${pct}%` }}
        />
      </div>
      {showValue && pct !== undefined && (
        <span className="w-9 text-right text-xs text-muted tabular">{Math.round(pct)}%</span>
      )}
    </div>
  );
}
