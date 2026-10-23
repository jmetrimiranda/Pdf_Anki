import { Fragment } from 'react';
import { Badge, Dialog, Kbd } from '../../components/ui';
import { t } from '../../i18n';
import { SHORTCUTS } from './shortcuts';

export function ShortcutsDialog({
  open,
  onOpenChange,
  sheet,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  sheet: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('shortcuts.title')} variant={sheet ? 'sheet' : 'center'}>
      <ul className="divide-y divide-line">
        {SHORTCUTS.map((s) => (
          <li key={s.label} className="flex min-h-10 items-center justify-between gap-4 py-1">
            <span className={s.ready ? '' : 'text-muted'}>
              {t(s.label)}
              {!s.ready && (
                <Badge className="ml-2" tone="neutral">
                  {t('common.soon')}
                </Badge>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-1">
              {s.combos.map((combo, i) => (
                <Fragment key={combo.join('+')}>
                  {i > 0 && <span className="px-1 text-xs text-muted">{t('shortcuts.or')}</span>}
                  {combo.map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </Fragment>
              ))}
            </span>
          </li>
        ))}
      </ul>
      <p className="pt-3 pb-3 text-xs text-muted">{t('shortcuts.pdfcraftNote')}</p>
    </Dialog>
  );
}
