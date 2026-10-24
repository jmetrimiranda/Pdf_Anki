// The "Painel Anki do livro" (spec 10.1): the book's decks with their counts and "Revisar aqui" (with the generated
// subdeck of the current chapter), "＋ Card da seleção", the vocabulary coverage and highlight (spec 12.7) and the
// cards of the current page. Rendered by features/leitor/BookPanel.tsx
// while a library book is in front.
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Counts, IconButton, Notice, SkeletonLines, useToast } from '../../components/ui';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import { core } from '../../lib/core/client';
import type { BookCard, BookDeckInfo, BookPanelInfo, BookPanelPatch } from '../../lib/core/types';
import { errorMessage } from '../anki/decks/DeckDialogs';
import { openOptions } from '../anki/study/links';
import { NoteEditorDialog } from '../anki/editor/NoteEditorDialog';
import { DeckPicker } from '../anki/shared/DeckPicker';
import type { LeitorSelection } from '../leitor/controller';
import { leitor, useLeitorSelector } from '../leitor/instance';
import { OcrPanelNotice } from '../ocr';
import { useSyncStatus } from '../sync/useSyncStatus';
import { CardForm, type CardSelection } from './CardForm';
import { MiniReview } from './review/MiniReview';
import { previewLine } from './text';
import { VocabSection } from './VocabSection';

export const bookPanelKey = (uid: string) => ['bookPanel', uid] as const;
/** The panel info for the page shown (its `chapterDeck` depends on it); invalidated through `bookPanelKey`. */
export const bookPanelPageKey = (uid: string, page: number) => ['bookPanel', uid, page] as const;
/** How long the page must rest before the panel asks for its chapter's deck. */
export const PAGE_DEBOUNCE_MS = 400;
export const bookCardsKey = (uid: string) => ['bookCards', uid] as const;

/** Decks of the book "Revisar aqui" can study (existing ones): the current chapter's subdeck, then the book's. */
export function reviewDecks(info: BookPanelInfo): { deckId: number; name: string; role: 'vocab' | 'content' }[] {
  const seen = new Set<number>();
  return [info.chapterDeck, info.vocabDeck, info.contentDeck]
    .filter((d): d is BookDeckInfo & { deckId: number } => !!d && d.exists && d.deckId !== null)
    .filter((d) => !seen.has(d.deckId) && !!seen.add(d.deckId))
    .map((d) => ({ deckId: d.deckId, name: d.name, role: d.role }));
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

function dueTotal(d: BookDeckInfo): number {
  return d.counts ? d.counts.new + d.counts.learn + d.counts.review : 0;
}

/** Refreshes the panel's data when the collection changes elsewhere (import, Anki pages, sync, the Anki tab). */
function usePanelRefresh(bookUid: string) {
  const qc = useQueryClient();
  useEffect(() => {
    const refresh = () => {
      void qc.invalidateQueries({ queryKey: bookPanelKey(bookUid) });
      void qc.invalidateQueries({ queryKey: bookCardsKey(bookUid) });
    };
    return core.onAnkiChanged(refresh);
  }, [qc, bookUid]);
  const sync = useSyncStatus();
  const lastSync = sync ? `${sync.state}:${sync.lastSyncAt ?? ''}` : '';
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void qc.invalidateQueries({ queryKey: bookPanelKey(bookUid) });
    void qc.invalidateQueries({ queryKey: bookCardsKey(bookUid) });
  }, [qc, bookUid, lastSync]);
  // Coming back to the Leitor tab (studied in the Anki tab meanwhile): fresh counts.
  const visible = useLeitorSelector((s) => s.visible);
  useEffect(() => {
    if (visible) void qc.invalidateQueries({ queryKey: bookPanelKey(bookUid) });
  }, [qc, bookUid, visible]);
}

export function BookPanelContent({
  bookUid,
  title,
  page,
  selection,
  cardRequest,
  onCardDone,
  reviewRequest,
  onReviewStarted,
  unit = 'page',
}: {
  bookUid: string;
  title: string;
  /** 0-based page in front (an EPUB's spine section). */
  page: number;
  /** `chapter` for an EPUB: "Cards deste capítulo", Fonte links with `cap`/`cfi` (spec 7.1, 10). */
  unit?: 'page' | 'chapter';
  /** The book's current selection in PdfCraft (null: nothing selected). */
  selection: LeitorSelection | null;
  /** Open the card form for this selection ("Criar card", Ctrl+Shift+N, the button). */
  cardRequest: CardSelection | null;
  onCardDone: () => void;
  /** Open "Revisar aqui" on the remembered (or first) deck (`?painel=revisar`). */
  reviewRequest?: boolean;
  onReviewStarted?: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  usePanelRefresh(bookUid);
  // The chapter's subdeck follows the page shown: asked again once the page rests (the rest stays on screen).
  const shownPage = useDebounced(page, PAGE_DEBOUNCE_MS);
  const info = useQuery({
    queryKey: bookPanelPageKey(bookUid, shownPage),
    queryFn: () => core.bookPanelInfo(bookUid, shownPage),
    placeholderData: keepPreviousData,
  });
  const cards = useQuery({ queryKey: bookCardsKey(bookUid), queryFn: () => core.ankiBookCards(bookUid) });
  const [review, setReview] = useState<number | null>(null);

  const save = async (patch: BookPanelPatch) => {
    try {
      const next = await core.bookPanelSet(bookUid, patch);
      // The answer has no page: keep the chapter deck already shown, then ask again.
      qc.setQueryData<BookPanelInfo>(bookPanelPageKey(bookUid, shownPage), (old) => ({
        ...next,
        chapterDeck: old?.chapterDeck ?? next.chapterDeck,
      }));
      void qc.invalidateQueries({ queryKey: bookPanelKey(bookUid) });
      return next;
    } catch (e) {
      toast.show(t('bookPanel.saveFailed', { erro: errorMessage(e) }), { tone: 'error' });
      return null;
    }
  };

  const startReview = (deckId: number) => {
    setReview(deckId);
    void save({ reviewDeckId: deckId });
  };

  // `?painel=revisar`: the remembered deck, else the first one that exists.
  useEffect(() => {
    if (!reviewRequest || !info.data) return;
    const decks = reviewDecks(info.data);
    const pick = decks.find((d) => d.deckId === info.data.reviewDeckId) ?? decks[0];
    onReviewStarted?.();
    if (pick) setReview(pick.deckId);
  }, [reviewRequest, info.data, onReviewStarted]);

  // A card asked for during a review (PdfCraft's menu, a shortcut) ends the review: one thing at a time in the panel.
  useEffect(() => {
    if (cardRequest) setReview(null);
  }, [cardRequest]);

  if (info.isPending) return <SkeletonLines lines={6} />;
  if (info.isError || !info.data) {
    return (
      <Notice tone="error" onRetry={() => void info.refetch()}>
        {t('bookPanel.loadError')}
      </Notice>
    );
  }
  const data = info.data;

  if (cardRequest) {
    return (
      <CardForm
        key={`${cardRequest.page}:${cardRequest.text}`}
        bookUid={bookUid}
        title={title}
        selection={cardRequest}
        info={data}
        onClose={onCardDone}
      />
    );
  }

  if (review !== null) {
    const decks = reviewDecks(data);
    if (decks.some((d) => d.deckId === review)) {
      return (
        <MiniReview
          bookUid={bookUid}
          decks={decks}
          initialDeckId={review}
          onClose={() => {
            setReview(null);
            void qc.invalidateQueries({ queryKey: bookPanelKey(bookUid) });
            void qc.invalidateQueries({ queryKey: bookCardsKey(bookUid) });
          }}
        />
      );
    }
  }

  return (
    <div className="flex flex-col">
      {unit === 'page' && <OcrPanelNotice uid={bookUid} />}
      <SelectionSection selection={selection} />
      <Section title={t('bookPanel.decks')}>
        <div className="flex flex-col gap-3">
          <DeckRow label={t('bookPanel.deckVocab')} deck={data.vocabDeck} onReview={startReview} />
          {data.chapterDeck?.exists && data.chapterDeck.deckId !== data.vocabDeck.deckId && (
            <DeckRow
              label={t('vocabReading.chapterDeck')}
              deck={data.chapterDeck}
              onReview={startReview}
              testId="book-deck-chapter"
            />
          )}
          <ContentDeckRow
            deck={data.contentDeck}
            onReview={startReview}
            onChange={(contentDeckId) => void save({ contentDeckId })}
          />
        </div>
      </Section>
      <Section title={t('bookPanel.vocab')}>
        <VocabSection bookUid={bookUid} vocab={data.vocab} />
      </Section>
      <PageCards bookUid={bookUid} page={page} unit={unit} cards={cards.data ?? null} loading={cards.isPending} />
    </div>
  );
}

function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section
      aria-label={title}
      className={cn('border-t border-(--pc-border) py-3 first:border-t-0 first:pt-0', className)}
    >
      <h3 className="mb-2 text-xs font-semibold text-(--pc-muted)">{title}</h3>
      {children}
    </section>
  );
}

function SelectionSection({ selection }: { selection: LeitorSelection | null }) {
  const has = selection !== null && selection.text.trim() !== '';
  return (
    <section className="pb-3">
      <Button
        variant="primary"
        icon={Plus}
        className="w-full justify-start!"
        disabled={!has}
        title={t('bookPanel.cardFromSelectionHint')}
        onClick={() => leitor.requestCardFromSelection('button')}
      >
        <span className="flex-1 text-left">{t('bookPanel.cardFromSelection')}</span>
        <kbd
          aria-hidden
          className="inline-flex h-5 items-center rounded-[4px] border border-current/35 px-1.5 font-mono text-2xs font-normal opacity-80"
        >
          Alt+C
        </kbd>
      </Button>
      <p data-testid="book-panel-selection" className="mt-1.5 truncate text-xs text-(--pc-muted)">
        {has ? t('bookPanel.selectionPreview', { trecho: previewLine(selection.text) }) : t('bookPanel.selectHint')}
      </p>
    </section>
  );
}

function DeckCounts({ deck }: { deck: BookDeckInfo }) {
  const c = deck.counts ?? { new: 0, learn: 0, review: 0 };
  return <Counts newCount={c.new} learnCount={c.learn} reviewCount={c.review} />;
}

function DeckRow({
  label,
  deck,
  onReview,
  action,
  testId,
}: {
  label: string;
  deck: BookDeckInfo;
  onReview: (deckId: number) => void;
  action?: ReactNode;
  testId?: string;
}) {
  const exists = deck.exists && deck.deckId !== null;
  const due = dueTotal(deck);
  return (
    <div data-testid={testId ?? `book-deck-${deck.role}`} className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate text-xs text-(--pc-muted)">{label}</span>
        {action}
      </div>
      <span className="truncate text-base" title={deck.name}>
        {deck.name}
      </span>
      {exists ? (
        <div className="flex items-center justify-between gap-2">
          <DeckCounts deck={deck} />
          <Button
            size="sm"
            disabled={due === 0}
            title={due === 0 ? t('bookPanel.reviewNothing') : undefined}
            aria-label={t('bookPanel.reviewHereDeck', { nome: deck.name })}
            onClick={() => onReview(deck.deckId!)}
          >
            {t('bookPanel.reviewHere')}
          </Button>
        </div>
      ) : (
        <span className="text-xs text-(--pc-muted)">{t('bookPanel.deckMissing')}</span>
      )}
    </div>
  );
}

function ContentDeckRow({
  deck,
  onReview,
  onChange,
}: {
  deck: BookDeckInfo | null;
  onReview: (deckId: number) => void;
  onChange: (deckId: number | null) => void;
}) {
  const [picking, setPicking] = useState(false);
  const picker = picking && (
    <div className="mt-1">
      <DeckPicker
        label={t('bookPanel.contentDeckLabel')}
        value={deck?.exists ? deck.deckId : null}
        onChange={(id) => {
          setPicking(false);
          if (id !== null && id !== deck?.deckId) onChange(id);
        }}
      />
    </div>
  );
  if (!deck || !deck.exists) {
    return (
      <div data-testid="book-deck-content" className="flex flex-col gap-0.5">
        <span className="text-xs text-(--pc-muted)">{t('bookPanel.deckContent')}</span>
        {!picking && (
          <button
            type="button"
            className="self-start text-base text-link hover:underline"
            onClick={() => setPicking(true)}
          >
            {t('bookPanel.contentDeckChoose')}
          </button>
        )}
        {picker}
      </div>
    );
  }
  return (
    <div>
      <DeckRow
        label={t('bookPanel.deckContent')}
        deck={deck}
        onReview={onReview}
        action={
          <IconButton
            icon={Pencil}
            size="sm"
            label={t('bookPanel.contentDeckChange')}
            className="-my-1 size-6! text-(--pc-muted)!"
            onClick={() => setPicking((p) => !p)}
          />
        }
      />
      {picker}
    </div>
  );
}

/** "Cards desta página" (PDF) / "Cards deste capítulo" (EPUB): the book's cards whose Fonte points here. */
function PageCards({
  bookUid,
  page,
  unit,
  cards,
  loading,
}: {
  bookUid: string;
  page: number;
  unit: 'page' | 'chapter';
  cards: BookCard[] | null;
  loading: boolean;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<number | null>(null);
  const deckNames = useQuery({ queryKey: ['anki', 'deckNames'], queryFn: () => core.ankiDeckNames() });
  const page1 = page + 1;
  const here = (cards ?? []).filter((c) => c.page === page1 && (c.unit ?? 'page') === unit);
  const deckName = (id: number) => deckNames.data?.find((d) => d.id === id)?.name ?? '';
  const chapter = unit === 'chapter';
  return (
    <Section
      title={chapter ? t('bookPanel.chapterCards', { n: page1 }) : t('bookPanel.pageCards', { n: page1 })}
      className="pb-1"
    >
      {loading ? (
        <SkeletonLines lines={2} />
      ) : here.length === 0 ? (
        <p className="text-base text-(--pc-muted)">
          {chapter ? t('bookPanel.chapterCardsEmpty') : t('bookPanel.pageCardsEmpty')}
        </p>
      ) : (
        <ul data-testid="book-page-cards" className="-mx-1.5 flex flex-col">
          {here.map((c) => (
            <li key={c.noteId} className="group flex items-start gap-1 rounded-ctl hover:bg-(--pc-hover)">
              <button
                type="button"
                className="min-w-0 flex-1 px-1.5 py-1.5 text-left"
                aria-label={t('bookPanel.pageCardOpen', { trecho: c.preview })}
                onClick={() => void leitor.openBook(bookUid, openOptions(c))}
              >
                <span className="line-clamp-2 text-base break-words">{c.preview}</span>
                <span className="mt-0.5 block truncate text-xs text-(--pc-muted)">
                  {c.notetype}
                  {deckName(c.deckId) && ` · ${deckName(c.deckId)}`}
                </span>
              </button>
              <Button
                size="sm"
                variant="ghost"
                className="mt-1 mr-1 shrink-0 text-(--pc-muted)! hover:text-(--pc-text)!"
                aria-label={t('bookPanel.pageCardEditLabel', { trecho: c.preview })}
                onClick={() => setEditing(c.noteId)}
              >
                {t('bookPanel.pageCardEdit')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <NoteEditorDialog
        noteId={editing}
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        onSaved={() => void qc.invalidateQueries({ queryKey: bookCardsKey(bookUid) })}
      />
    </Section>
  );
}
