import { Fragment } from 'react';
import { Badge, Dialog, Kbd } from '../../components/ui';
import { t } from '../../i18n';
import { SHORTCUTS, STUDY_SHORTCUTS } from './shortcuts';

function Combos({ combos }: { combos: string[][] }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {combos.map((combo, i) => (
        <Fragment key={combo.join('+')}>
          {i > 0 && <span className="px-1 text-xs text-muted">{t('shortcuts.or')}</span>}
          {combo.map((k) => (
            <Kbd key={k}>{k}</Kbd>
          ))}
        </Fragment>
      ))}
    </span>
  );
}

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
            <Combos combos={s.combos} />
          </li>
        ))}
      </ul>
      <h3 className="pt-4 pb-1 text-2xs font-semibold tracking-wide text-muted uppercase">
        {t('anki.shortcuts.heading')}
      </h3>
      <ul className="divide-y divide-line" aria-label={t('anki.shortcuts.heading')}>
        {STUDY_SHORTCUTS.map((s) => (
          <li key={s.label} className="flex min-h-10 items-center justify-between gap-4 py-1">
            <span>{t(s.label)}</span>
            <Combos combos={s.combos} />
          </li>
        ))}
      </ul>
      <div className="space-y-1.5 pt-3 pb-3 text-xs text-muted">
        <p>{t('shortcuts.pdfcraftNote')}</p>
        {SHORTCUTS.flatMap((s) => (s.note ? [<p key={s.note}>{t(s.note)}</p>] : []))}
      </div>
    </Dialog>
  );
}
