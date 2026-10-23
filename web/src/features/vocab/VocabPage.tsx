import { ArrowLeft } from 'lucide-react';
import { forwardRef, type ReactNode } from 'react';
import { Button } from '../../components/ui';
import { cn } from '../../lib/cn';

/** The scrolling frame of the vocabulary screens (same width and padding as the Biblioteca). */
export const VocabPage = forwardRef<HTMLDivElement, { children: ReactNode; wide?: boolean }>(function VocabPage(
  { children, wide },
  ref,
) {
  return (
    <div ref={ref} className="h-full overflow-auto" data-testid="vocab-page">
      <div
        className={cn('mx-auto flex flex-col gap-4 px-4 pt-5 pb-10 sm:px-6', wide ? 'max-w-[1200px]' : 'max-w-[880px]')}
      >
        {children}
      </div>
    </div>
  );
});

/** Back link, title and the book line of a vocabulary screen; `actions` sit on the right (or below, narrow). */
export function BookHeader({
  title,
  subtitle,
  back,
  actions,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  back?: { label: string; onClick: () => void };
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-2">
      {back && (
        <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={back.onClick} className="-ml-2.5 self-start">
          {back.label}
        </Button>
      )}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold break-words">{title}</h1>
          {subtitle && <p className="text-base text-muted">{subtitle}</p>}
        </div>
        {actions}
      </div>
      {children}
    </header>
  );
}
