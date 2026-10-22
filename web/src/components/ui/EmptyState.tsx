import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** Every list has one: a short phrase and an action (spec painel 4.2). */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-10 text-center', className)}>
      {Icon && (
        <div className="mb-1 flex size-11 items-center justify-center rounded-full bg-surface text-muted">
          <Icon size={20} strokeWidth={1.7} aria-hidden />
        </div>
      )}
      <p className="text-md font-semibold">{title}</p>
      {description && <p className="max-w-sm text-base text-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
