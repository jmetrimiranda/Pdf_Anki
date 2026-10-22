import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** 1px border, radius 10, no shadow (spec painel 4.2). */
export function Card({
  title,
  actions,
  className,
  children,
  padded = true,
  ...rest
}: Omit<HTMLAttributes<HTMLElement>, 'title'> & { title?: ReactNode; actions?: ReactNode; padded?: boolean }) {
  return (
    <section className={cn('rounded-box border border-line bg-card', padded && 'p-4', className)} {...rest}>
      {(title || actions) && (
        <header className={cn('mb-3 flex items-center justify-between gap-3', !padded && 'px-4 pt-4')}>
          {title && <h3 className="text-md font-semibold">{title}</h3>}
          {actions && <div className="flex items-center gap-1">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
