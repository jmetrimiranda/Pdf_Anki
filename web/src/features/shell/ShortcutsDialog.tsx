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
      <ul className="divide-y divide-line pb-2">
        {SHORTCUTS.map((s) => (
          <li key={s.label} className="flex h-10 items-center justify-between gap-4">
            <span className={s.ready ? '' : 'text-muted'}>
              {t(s.label)}
              {!s.ready && (
                <Badge className="ml-2" tone="neutral">
                  {t('common.soon')}
                </Badge>
              )}
            </span>
            <span className="flex items-center gap-1">
              {s.keys.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
