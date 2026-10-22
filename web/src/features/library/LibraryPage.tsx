import { Link } from '@tanstack/react-router';
import { BookOpen, FileText, FolderOpen } from 'lucide-react';
import { Button, EmptyState, Kbd } from '../../components/ui';
import { t } from '../../i18n';
import { useDocTabs } from '../../lib/tabs';
import { useShell } from '../shell/context';

export function LibraryPage() {
  const shell = useShell();
  const tabs = useDocTabs();
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-5 px-4 pt-6 pb-10 sm:px-6">
        <header className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">{t('library.title')}</h1>
            <p className="text-xs text-muted">{t('library.subtitle')}</p>
          </div>
          {tabs.length > 0 && (
            <Button variant="primary" icon={FolderOpen} onClick={shell.openFile}>
              {t('library.openFile')}
            </Button>
          )}
        </header>

        {tabs.length > 0 && (
          <section aria-labelledby="open-now" className="flex flex-col gap-2">
            <h2 id="open-now" className="text-xs text-muted">
              {t('library.openNow')}
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {tabs.map((tab) => (
                <li key={tab.docId}>
                  <Link
                    to="/doc/$docId"
                    params={{ docId: tab.docId }}
                    className="flex items-center gap-3 rounded-box border border-line bg-card p-3 transition-colors hover:border-lime"
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-ctl bg-surface text-muted">
                      <FileText size={18} aria-hidden />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-semibold">{tab.title}</span>
                      <span className="block text-xs text-muted">{t('library.pdf')}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {tabs.length === 0 && (
          <div className="rounded-box border border-line bg-card">
            <EmptyState
              className="py-16"
              icon={BookOpen}
              title={t('library.empty')}
              description={t('library.emptyHint')}
              action={
                <div className="flex flex-col items-center gap-3">
                  <Button variant="primary" icon={FolderOpen} onClick={shell.openFile}>
                    {t('library.openFile')}
                  </Button>
                  <span className="flex items-center gap-1 text-xs text-muted">
                    {t('library.or')} <Kbd>Ctrl</Kbd>
                    <Kbd>O</Kbd>
                  </span>
                </div>
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}
