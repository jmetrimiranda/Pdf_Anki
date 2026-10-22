import { AlertCircle, CheckCircle2, Info, RotateCw, X } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { t } from '../../i18n';

export type NoticeTone = 'info' | 'success' | 'error';

const toneIcon = { info: Info, success: CheckCircle2, error: AlertCircle } as const;
const toneClass = {
  info: 'text-link',
  success: 'text-lime-dark',
  error: 'text-error',
} as const;

/**
 * Discrete notice (aviso) shown at the top of the content: errors offer "tentar de novo"
 * (spec painel 4.2). Used inline and by the toast stack.
 */
export function Notice({
  tone = 'info',
  children,
  onRetry,
  onDismiss,
  className,
}: {
  tone?: NoticeTone;
  children: ReactNode;
  onRetry?: (() => void) | undefined;
  onDismiss?: (() => void) | undefined;
  className?: string;
}) {
  const Icon = toneIcon[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex min-h-9 items-center gap-2.5 rounded-box border border-line bg-card py-1.5 pr-1.5 pl-3 text-base',
        className,
      )}
    >
      <Icon size={16} className={cn('shrink-0', toneClass[tone])} aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex h-7 items-center gap-1.5 rounded-ctl px-2 text-base font-semibold text-link hover:bg-hover coarse:min-h-11"
        >
          <RotateCw size={14} aria-hidden />
          {t('common.retry')}
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          aria-label={t('common.dismiss')}
          onClick={onDismiss}
          className="inline-flex size-7 items-center justify-center rounded-ctl text-muted hover:bg-hover hover:text-fg coarse:size-11"
        >
          <X size={15} aria-hidden />
        </button>
      )}
    </div>
  );
}

interface ToastItem {
  id: number;
  tone: NoticeTone;
  message: string;
  onRetry?: (() => void) | undefined;
}

interface ToastApi {
  show: (message: string, opts?: { tone?: NoticeTone; onRetry?: () => void; durationMs?: number }) => void;
}

const ToastContext = createContext<ToastApi>({ show: () => {} });

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);

  const show = useCallback<ToastApi['show']>(
    (message, opts = {}) => {
      const id = nextId.current++;
      const tone = opts.tone ?? 'info';
      setItems((xs) => [...xs.slice(-2), { id, tone, message, onRetry: opts.onRetry }]);
      const duration = opts.durationMs ?? (tone === 'error' ? 8000 : 4000);
      if (duration > 0) setTimeout(() => dismiss(id), duration);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 top-12 z-[60] flex flex-col items-center gap-2 px-4"
      >
        {items.map((item) => (
          <Notice
            key={item.id}
            tone={item.tone}
            className="pointer-events-auto w-full max-w-md shadow-popover anim-pop"
            onDismiss={() => dismiss(item.id)}
            onRetry={
              item.onRetry &&
              (() => {
                dismiss(item.id);
                item.onRetry?.();
              })
            }
          >
            {item.message}
          </Notice>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
