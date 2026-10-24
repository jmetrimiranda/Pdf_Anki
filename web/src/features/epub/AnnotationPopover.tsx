// The popover of an annotation clicked on the page: change its colour, write or edit its note, delete it.
import { Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, Textarea } from '../../components/ui';
import { t } from '../../i18n';
import type { EpubAnnotation } from '../../lib/core/types';
import { Floating } from './Floating';
import { normalizeColor, SWATCHES } from './palette';
import type { Rect } from './session';
import { SwatchButton } from './SelectionToolbar';

export function AnnotationPopover({
  annotation,
  rect,
  focusComment,
  container,
  onColor,
  onComment,
  onDelete,
  onClose,
}: {
  annotation: EpubAnnotation;
  rect: Rect;
  focusComment: boolean;
  container: HTMLElement | null;
  onColor: (color: string) => void;
  onComment: (comment: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [comment, setComment] = useState(annotation.comment ?? '');
  const ref = useRef<HTMLTextAreaElement>(null);
  const color = normalizeColor(annotation.color);
  const dirty = comment.trim() !== (annotation.comment ?? '').trim();

  // Mounted once per opening (keyed by the parent): a new annotation getting its real uid keeps what was typed.
  useEffect(() => {
    if (focusComment) ref.current?.focus();
  }, [focusComment]);

  // The comment is saved once: on "Salvar"/close, or when the popover goes away (page turned, annotation deleted).
  const latest = useRef({ comment, dirty, onComment, committed: false });
  latest.current = { ...latest.current, comment, dirty, onComment };
  const commit = () => {
    const l = latest.current;
    if (l.committed || !l.dirty) return;
    l.committed = true;
    l.onComment(l.comment);
  };
  useEffect(() => () => commit(), []);

  const close = () => {
    commit();
    onClose();
  };

  return (
    <Floating
      rect={rect}
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      side="bottom"
      label={t('epubReader.annotation')}
      container={container}
      keepFocus={!focusComment}
      className="w-72 p-3"
      testId="epub-annotation-popover"
    >
      <div className="flex flex-col gap-3">
        <div>
          <p className="mb-1.5 text-xs text-muted">{t('epubReader.color')}</p>
          <div className="flex flex-wrap items-center gap-0.5">
            {SWATCHES.map((s) => (
              <SwatchButton
                key={s.hex}
                swatch={s}
                selected={s.hex === color}
                label={t(s.label)}
                onClick={() => onColor(s.hex)}
              />
            ))}
          </div>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs text-muted">{t('epubReader.comment')}</span>
          <Textarea
            ref={ref}
            value={comment}
            rows={3}
            placeholder={t('epubReader.commentPlaceholder')}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                close();
              }
            }}
          />
        </label>
        <div className="flex items-center justify-between gap-2">
          <Button variant="danger" size="sm" icon={Trash2} onClick={onDelete}>
            {t('epubReader.delete')}
          </Button>
          <Button variant={dirty ? 'primary' : 'neutral'} size="sm" onClick={close}>
            {dirty ? t('common.save') : t('common.close')}
          </Button>
        </div>
      </div>
    </Floating>
  );
}
