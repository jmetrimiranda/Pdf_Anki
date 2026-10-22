import { Link } from '@tanstack/react-router';
import { Compass } from 'lucide-react';
import { buttonBase, EmptyState } from '../../components/ui';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';

export function NotFound() {
  return (
    <EmptyState
      className="h-full"
      icon={Compass}
      title={t('notFound.title')}
      description={t('notFound.hint')}
      action={
        <Link to="/biblioteca" className={cn(buttonBase, 'h-8 border-line bg-neutral px-3 hover:bg-active')}>
          {t('reader.backToLibrary')}
        </Link>
      }
    />
  );
}
