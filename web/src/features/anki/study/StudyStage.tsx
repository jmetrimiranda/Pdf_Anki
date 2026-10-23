// The card area shared by the Anki tab and the mini-review: the sandboxed CardFrame, the loading skeleton over it and
// the video overlay. The frame stays mounted while the session lives (it loads reviewer.html once).
import { X } from 'lucide-react';
import { IconButton, Skeleton } from '../../../components/ui';
import { t } from '../../../i18n';
import { core } from '../../../lib/core/client';
import { CardFrame } from './CardFrame';
import type { StudySession } from './useStudySession';

export function StudyStage({ session, className }: { session: StudySession; className: string }) {
  const { view, video, player } = session;
  return (
    <div className={className}>
      <CardFrame
        ref={session.frame}
        src={core.cardFrameUrl()}
        title={t('anki.study.cardFrame')}
        onMessage={session.onCardMessage}
        className="absolute inset-0 size-full border-0"
      />
      {view.kind === 'loading' && (
        <div
          role="status"
          aria-busy="true"
          aria-label={t('anki.study.loading')}
          className="absolute inset-0 flex flex-col items-center gap-4 bg-card px-6 pt-10"
        >
          <Skeleton className="h-6 w-2/5" />
          <Skeleton className="h-4 w-3/5" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      )}
      {video && (
        <div className="absolute inset-0 flex items-center justify-center bg-overlay p-4">
          <video
            src={video}
            autoPlay
            controls
            className="max-h-full max-w-full rounded-box"
            onEnded={() => player.stop()}
            onError={() => player.stop()}
          />
          <IconButton
            icon={X}
            label={t('anki.study.closeVideo')}
            variant="neutral"
            className="absolute top-3 right-3"
            onClick={() => player.stop()}
          />
        </div>
      )}
    </div>
  );
}
