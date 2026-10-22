import { cn } from '../../lib/cn';
import { t } from '../../i18n';

/** Small inline spinner. Never use it as a full-page loader (use Skeleton). */
export function Spinner({ className, label = t('common.loading') }: { className?: string; label?: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn(
        'inline-block size-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent opacity-70 motion-reduce:animate-none',
        className,
      )}
    />
  );
}
