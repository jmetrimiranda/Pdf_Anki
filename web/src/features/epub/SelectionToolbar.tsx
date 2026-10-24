// The floating toolbar over a selection in the book (spec 7.1, 10.2): PdfCraft's 10 highlight colours, Sublinhar,
// Nota, then the app's items (Criar card, Criar cards com IA, Definir palavra), like the items the app adds to
// PdfCraft's own selection menu.
import { BookA, MessageSquareText, Sparkles, SquarePlus, Underline } from 'lucide-react';
import { IconButton } from '../../components/ui';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import { Floating } from './Floating';
import { SWATCHES, type Swatch } from './palette';
import type { EpubSelection } from './types';

export function SwatchButton({
  swatch,
  selected,
  onClick,
  label,
}: {
  swatch: Swatch;
  selected?: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      title={label}
      data-color={swatch.hex}
      onClick={onClick}
      className={cn(
        'inline-flex size-6 shrink-0 items-center justify-center rounded-full transition-transform hover:scale-110 coarse:size-9',
        selected && 'ring-2 ring-fg ring-offset-1 ring-offset-card',
      )}
    >
      <span aria-hidden className="size-4 rounded-full border border-black/15" style={{ background: swatch.hex }} />
    </button>
  );
}

export function SelectionToolbar({
  selection,
  container,
  lastColor,
  onHighlight,
  onUnderline,
  onNote,
  onMenu,
  onDismiss,
}: {
  selection: EpubSelection;
  container: HTMLElement | null;
  lastColor: string;
  onHighlight: (color: string) => void;
  onUnderline: () => void;
  onNote: () => void;
  onMenu: (key: 'card' | 'ai' | 'define') => void;
  onDismiss: () => void;
}) {
  return (
    <Floating
      rect={selection.rect}
      open
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
      label={t('epubReader.selection')}
      container={container}
      keepFocus
      testId="epub-selection-toolbar"
    >
      <div role="toolbar" aria-label={t('epubReader.selection')} className="flex items-center gap-0.5">
        <div className="flex items-center gap-0.5 px-0.5">
          {SWATCHES.map((s) => (
            <SwatchButton
              key={s.hex}
              swatch={s}
              selected={s.hex === lastColor}
              label={t('epubReader.highlightIn', { cor: t(s.label) })}
              onClick={() => onHighlight(s.hex)}
            />
          ))}
        </div>
        <span aria-hidden className="mx-1 h-5 w-px bg-line" />
        <IconButton icon={Underline} size="sm" label={t('epubReader.underline')} onClick={onUnderline} />
        <IconButton icon={MessageSquareText} size="sm" label={t('epubReader.note')} onClick={onNote} />
        <span aria-hidden className="mx-1 h-5 w-px bg-line" />
        <IconButton icon={SquarePlus} size="sm" label={t('leitor.menu.card')} onClick={() => onMenu('card')} />
        <IconButton icon={Sparkles} size="sm" label={t('leitor.menu.ai')} onClick={() => onMenu('ai')} />
        <IconButton icon={BookA} size="sm" label={t('leitor.menu.define')} onClick={() => onMenu('define')} />
      </div>
    </Floating>
  );
}
