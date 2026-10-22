import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** role=toolbar with arrow-key movement between its buttons. */
export function Toolbar({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const target = e.target as HTMLElement;
    if (target.matches('input, textarea, select')) return;
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? []);
    const i = items.indexOf(target);
    if (i < 0) return;
    e.preventDefault();
    items[(i + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length]?.focus();
  }
  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn('flex items-center gap-1', className)}
    >
      {children}
    </div>
  );
}

export function ToolbarSeparator() {
  return <div role="separator" aria-orientation="vertical" className="mx-1 h-5 w-px bg-line" />;
}
