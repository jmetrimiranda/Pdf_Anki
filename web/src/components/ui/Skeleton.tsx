import { cn } from '../../lib/cn';

export function Skeleton({ className, rounded = 'ctl' }: { className?: string; rounded?: 'ctl' | 'box' | 'full' }) {
  return (
    <div
      aria-hidden
      className={cn(
        'bg-empty anim-shimmer',
        rounded === 'box' ? 'rounded-box' : rounded === 'full' ? 'rounded-full' : 'rounded-ctl',
        className,
      )}
    />
  );
}

/** A few text-like bars; used while lists load. */
export function SkeletonLines({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2.5', className)} role="status" aria-busy="true">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn('h-3.5', i === lines - 1 ? 'w-3/5' : i % 2 ? 'w-11/12' : 'w-full')} />
      ))}
    </div>
  );
}
