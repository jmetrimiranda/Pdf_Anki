// "＋ Card da seleção" (spec 10.2): a compact form in the book panel, prefilled from the selection. Fields are mapped
// by NAME on the app notetypes (`appType`), never by index; the Fonte links back to the page and the text.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Brackets, FolderPlus, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Field, IconButton, Input, Notice, SkeletonLines, Textarea, useToast } from '../../components/ui';
import { t, type MessageKey } from '../../i18n';
import { cn } from '../../lib/cn';
import { core } from '../../lib/core/client';
import { q } from '../../lib/core/queries';
import type { BookCardKind, BookPanelInfo, NotetypeInfo, Rect } from '../../lib/core/types';
import { errorMessage } from '../anki/decks/DeckDialogs';
import { CLOZE_CLOSE, clozeOpen, nextClozeNumber } from '../anki/editor/cloze';
import { codeToHtml } from '../anki/editor/codeField';
import { checkError, useNoteCheck } from '../anki/editor/useNoteCheck';
import { DeckPicker } from '../anki/shared/DeckPicker';
import { fonteHtml, fonteLabel, fonteQuery } from './fonte';
import { codeText, exampleHtml, exampleText, proseText, proseToHtml, singleWord } from './text';

/** The selection the form starts from (0-based PdfCraft page, rects in page view space). */
export interface CardSelection {
  page: number;
  text: string;
  rects: Rect[];
}

type FieldRole = 'prose' | 'code' | 'cloze' | 'line' | 'example';

interface FieldSpec {
  name: string;
  role: FieldRole;
  rows?: number;
}

interface KindSpec {
  appType: string;
  label: MessageKey;
  fields: FieldSpec[];
  /** Field focused when the form opens. */
  focus: string;
}

/** The form of each card type; names are the fields of the app notetypes (core-anki `prepare`). */
export const KINDS: Record<BookCardKind, KindSpec> = {
  basic: {
    appType: 'Básico (Leitor)',
    label: 'bookPanel.kind.basic',
    fields: [
      { name: 'Frente', role: 'prose', rows: 3 },
      { name: 'Verso', role: 'prose', rows: 2 },
    ],
    focus: 'Verso',
  },
  cloze: {
    appType: 'Cloze (Leitor)',
    label: 'bookPanel.kind.cloze',
    fields: [
      { name: 'Texto', role: 'cloze', rows: 4 },
      { name: 'Verso extra', role: 'prose', rows: 2 },
    ],
    focus: 'Texto',
  },
  codeCommand: {
    appType: 'Código · Comando',
    label: 'bookPanel.kind.codeCommand',
    fields: [
      { name: 'Pergunta', role: 'prose', rows: 2 },
      { name: 'Resposta', role: 'code', rows: 3 },
    ],
    focus: 'Pergunta',
  },
  codeProgram: {
    appType: 'Código · Programa',
    label: 'bookPanel.kind.codeProgram',
    fields: [
      { name: 'Pergunta', role: 'prose', rows: 2 },
      { name: 'Linguagem', role: 'line' },
      { name: 'Resposta', role: 'code', rows: 5 },
    ],
    focus: 'Pergunta',
  },
  vocab: {
    appType: 'Vocabulário · Livro',
    label: 'bookPanel.kind.vocab',
    fields: [
      { name: 'Palavra', role: 'line' },
      { name: 'Lema', role: 'line' },
      { name: 'Exemplo', role: 'example', rows: 3 },
    ],
    focus: 'Lema',
  },
};

export const KIND_ORDER: BookCardKind[] = ['basic', 'cloze', 'codeCommand', 'codeProgram', 'vocab'];

/** Kinds offered for a selection: Vocabulário only when it is a single word. */
export function allowedKinds(text: string): BookCardKind[] {
  return singleWord(text) ? KIND_ORDER : KIND_ORDER.filter((k) => k !== 'vocab');
}

/** Initial (plain text) values of a kind's fields for this selection. */
export function prefill(kind: BookCardKind, text: string): Record<string, string> {
  switch (kind) {
    case 'basic':
      return { Frente: proseText(text), Verso: '' };
    case 'cloze':
      return { Texto: proseText(text), 'Verso extra': '' };
    case 'codeCommand':
      return { Pergunta: '', Resposta: codeText(text) };
    case 'codeProgram':
      return { Pergunta: '', Linguagem: 'python', Resposta: codeText(text) };
    case 'vocab': {
      const word = singleWord(text) ?? proseText(text);
      return { Palavra: word, Lema: word.toLowerCase(), Exemplo: word };
    }
  }
}

/** Field HTML of the note, in the notetype's field order (by name); `Fonte` gets the link. */
export function noteFields(
  kind: BookCardKind,
  notetype: NotetypeInfo,
  values: Record<string, string>,
  fonte: string,
): string[] {
  const spec = KINDS[kind];
  return notetype.fields.map(({ name }) => {
    if (name === 'Fonte') return fonte;
    const f = spec.fields.find((x) => x.name === name);
    const v = values[name] ?? '';
    if (!f || !v.trim()) return '';
    switch (f.role) {
      case 'code':
        return codeToHtml(v);
      case 'example':
        return exampleHtml(v.replace(/\s+/g, ' ').trim(), values.Palavra ?? '');
      case 'line':
        return proseToHtml(v.trim());
      default:
        return proseToHtml(v.trim());
    }
  });
}

/**
 * Default deck: the book's last deck, then its content deck, then its existing vocabulary deck (Vocabulário: that
 * one first). Anki's current deck only when the book has no deck at all, so a first card never lands in an unrelated
 * deck while the book has its own.
 */
export function defaultDeck(kind: BookCardKind, info: BookPanelInfo, fallback: number | null): number | null {
  const vocab = info.vocabDeck.exists ? info.vocabDeck.deckId : null;
  if (kind === 'vocab' && vocab !== null) return vocab;
  return info.lastDeckId ?? info.contentDeck?.deckId ?? vocab ?? fallback;
}

/** Wraps [start, end) of `value` in a cloze `{{cN::…}}`; returns the new value and where the caret goes. */
export function wrapCloze(
  value: string,
  start: number,
  end: number,
  n: number,
): { value: string; selStart: number; selEnd: number } {
  const open = clozeOpen(n);
  const inner = value.slice(start, end);
  const next = value.slice(0, start) + open + inner + CLOZE_CLOSE + value.slice(end);
  // An empty gap leaves the caret inside it; a wrapped word keeps it selected.
  return { value: next, selStart: start + open.length, selEnd: start + open.length + inner.length };
}

export function CardForm({
  bookUid,
  title,
  selection,
  info,
  onClose,
  onAdded,
}: {
  bookUid: string;
  title: string;
  selection: CardSelection;
  info: BookPanelInfo;
  onClose: () => void;
  onAdded?: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const titleId = useId();
  const kinds = useMemo(() => allowedKinds(selection.text), [selection.text]);
  const [kind, setKind] = useState<BookCardKind>(() =>
    info.lastKind && kinds.includes(info.lastKind) ? info.lastKind : 'basic',
  );
  // Each kind keeps what the user typed when switching back and forth.
  const [values, setValues] = useState<Partial<Record<BookCardKind, Record<string, string>>>>(() => ({
    [kind]: prefill(kind, selection.text),
  }));
  const current = values[kind] ?? prefill(kind, selection.text);
  const [deckId, setDeckId] = useState<number | null>(null);
  const [deckTouched, setDeckTouched] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [adding, setAdding] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [creatingDeck, setCreatingDeck] = useState(false);
  const [vocabDeckId, setVocabDeckId] = useState<number | null>(info.vocabDeck.exists ? info.vocabDeck.deckId : null);
  const fieldRefs = useRef(new Map<string, HTMLTextAreaElement | HTMLInputElement | null>());

  const notetypes = useQuery(q.notetypes());
  const defaults = useQuery({ queryKey: ['anki', 'addDefaults', null], queryFn: () => core.ankiAddDefaults(null) });
  const notetype = notetypes.data?.find((nt) => nt.appType === KINDS[kind].appType) ?? null;
  const word = singleWord(selection.text);

  // Vocabulário: the lemma (core-vocab) and the sentence around the word (page words with rects).
  const define = useQuery({
    queryKey: ['vocabDefine', word, bookUid],
    queryFn: () => core.vocabDefine(word!, bookUid),
    enabled: word !== null && kinds.includes('vocab'),
    staleTime: Infinity,
  });
  const pageWords = useQuery({
    queryKey: ['docWords', bookUid, selection.page],
    queryFn: () => core.docWords(bookUid, selection.page),
    enabled: word !== null && kind === 'vocab',
    staleTime: Infinity,
  });
  const vocabTouched = useRef(new Set<string>());
  useEffect(() => {
    if (kind !== 'vocab' || !word) return;
    const lemma = define.data?.lemma;
    const example = pageWords.data ? exampleText(pageWords.data, word, selection.rects) : null;
    setValues((vs) => {
      const v = vs.vocab ?? prefill('vocab', selection.text);
      const next = { ...v };
      if (lemma && !vocabTouched.current.has('Lema')) next.Lema = lemma;
      if (example && !vocabTouched.current.has('Exemplo')) next.Exemplo = example;
      return { ...vs, vocab: next };
    });
  }, [kind, word, define.data, pageWords.data, selection.rects, selection.text]);

  const vocabInfo: BookPanelInfo = useMemo(
    () =>
      vocabDeckId !== null && !info.vocabDeck.exists
        ? { ...info, vocabDeck: { ...info.vocabDeck, deckId: vocabDeckId, exists: true } }
        : info,
    [info, vocabDeckId],
  );
  const effectiveDeck = deckTouched ? deckId : defaultDeck(kind, vocabInfo, defaults.data?.deckId ?? null);

  const page1 = selection.page + 1;
  const fonte = fonteHtml(bookUid, title, page1, fonteQuery(selection.text));
  const fields = notetype ? noteFields(kind, notetype, current, fonte) : null;
  const check = useNoteCheck(notetype?.id ?? null, fields);
  const err = checkError(check);
  const showErr = err && attempted ? err.message : null;

  // Focus the field the user fills (Verso, Pergunta…) when the form opens or the kind changes.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const el = fieldRefs.current.get(KINDS[kind].focus);
      if (!el) return;
      el.focus();
      if (kind === 'cloze' || kind === 'vocab') el.setSelectionRange(el.value.length, el.value.length);
    });
    return () => cancelAnimationFrame(id);
  }, [kind, notetype?.id]);

  const setField = (name: string, v: string) => {
    if (kind === 'vocab') vocabTouched.current.add(name);
    setValues((vs) => ({ ...vs, [kind]: { ...(vs[kind] ?? prefill(kind, selection.text)), [name]: v } }));
  };

  const chooseKind = (k: BookCardKind) => {
    setValues((vs) => (vs[k] ? vs : { ...vs, [k]: prefill(k, selection.text) }));
    setKind(k);
    setAttempted(false);
  };

  const gap = (reuse: boolean) => {
    const el = fieldRefs.current.get('Texto');
    if (!(el instanceof HTMLTextAreaElement)) return;
    const value = current.Texto ?? '';
    const n = nextClozeNumber([value, current['Verso extra'] ?? ''], reuse);
    const r = wrapCloze(value, el.selectionStart ?? value.length, el.selectionEnd ?? value.length, n);
    setField('Texto', r.value);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(r.selStart, r.selEnd);
    });
  };

  const add = async () => {
    if (!notetype || !fields || adding) return;
    if (effectiveDeck === null) {
      setAttempted(true);
      return;
    }
    setAdding(true);
    try {
      const state = await core.ankiNoteCheck(notetype.id, fields);
      if (checkError(state)) {
        setAttempted(true);
        fieldRefs.current.get(KINDS[kind].fields[0]!.name)?.focus();
        return;
      }
      await core.ankiNoteAdd({ notetypeId: notetype.id, deckId: effectiveDeck, fields, tags: ['leitor'] });
      toast.show(t('bookPanel.form.added'), { tone: 'success' });
      try {
        const saved = await core.bookPanelSet(bookUid, { lastDeckId: effectiveDeck, lastKind: kind });
        qc.setQueryData(['bookPanel', bookUid], saved);
      } catch {
        // Only the defaults of the next card are lost.
      }
      void qc.invalidateQueries({ queryKey: ['bookCards', bookUid] });
      void qc.invalidateQueries({ queryKey: ['bookPanel', bookUid] });
      void qc.invalidateQueries({ queryKey: ['anki'] });
      onAdded?.();
      onClose();
    } catch (e) {
      toast.show(t('bookPanel.form.addFailed', { erro: errorMessage(e) }), { tone: 'error' });
    } finally {
      setAdding(false);
    }
  };

  const prepare = async () => {
    setPreparing(true);
    try {
      await core.ankiPrepareCollection();
      await qc.invalidateQueries({ queryKey: ['anki', 'notetypes'] });
    } catch (e) {
      toast.show(t('bookPanel.form.prepareFailed', { erro: errorMessage(e) }), { tone: 'error' });
    } finally {
      setPreparing(false);
    }
  };

  const createVocabDeck = async () => {
    setCreatingDeck(true);
    try {
      const id = await core.ankiDeckCreate(info.vocabDeck.name);
      setVocabDeckId(id);
      setDeckId(id);
      setDeckTouched(true);
      toast.show(t('bookPanel.form.deckCreated', { nome: info.vocabDeck.name }), { tone: 'success' });
      void qc.invalidateQueries({ queryKey: ['anki'] });
      void qc.invalidateQueries({ queryKey: ['bookPanel', bookUid] });
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    } finally {
      setCreatingDeck(false);
    }
  };

  // Keys stay inside the form (never the PdfCraft iframe's): Ctrl+Enter adds, Esc cancels.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      void add();
    } else if (e.key === 'Escape') {
      // The panel's own Esc (closing the overlay) must not run first.
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  const missingType = notetypes.isSuccess && !notetype;
  const showCreateDeck = kind === 'vocab' && !info.vocabDeck.exists && vocabDeckId === null;

  return (
    <form
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
      className="flex flex-col gap-3"
    >
      <div className="flex items-center gap-2">
        <h3 id={titleId} className="min-w-0 flex-1 truncate text-md font-semibold">
          {t('bookPanel.form.title')}
        </h3>
        <IconButton icon={X} label={t('common.cancel')} size="sm" onClick={onClose} />
      </div>

      <KindPicker value={kind} kinds={kinds} onChange={chooseKind} />

      {notetypes.isPending && <SkeletonLines lines={4} />}
      {notetypes.isError && <Notice tone="error">{t('bookPanel.form.loadError')}</Notice>}
      {missingType ? (
        <div className="flex flex-col gap-2 rounded-box border border-line p-3">
          <p className="text-base">{t('bookPanel.form.missingTypes')}</p>
          <Button size="sm" className="self-start" loading={preparing} onClick={() => void prepare()}>
            {t('bookPanel.form.prepare')}
          </Button>
        </div>
      ) : (
        notetype && (
          <>
            {KINDS[kind].fields.map((f) => (
              <FormField
                key={`${kind}:${f.name}`}
                spec={f}
                value={current[f.name] ?? ''}
                onChange={(v) => setField(f.name, v)}
                error={showErr && f === KINDS[kind].fields[0] ? showErr : null}
                inputRef={(el) => fieldRefs.current.set(f.name, el)}
                onGap={gap}
              />
            ))}
            {check === 'duplicate' && (
              <p role="status" className="flex items-start gap-1.5 text-xs text-muted">
                <AlertTriangle size={13} aria-hidden className="mt-0.5 shrink-0 text-(--vocab-learning)" />
                {t('anki.editor.duplicate')}
              </p>
            )}
          </>
        )
      )}

      <div className="flex flex-col gap-1.5">
        <DeckPicker
          label={t('bookPanel.form.deck')}
          value={effectiveDeck}
          onChange={(id) => {
            setDeckId(id);
            setDeckTouched(true);
          }}
        />
        {attempted && effectiveDeck === null && <p className="text-xs text-error">{t('bookPanel.form.noDeck')}</p>}
        {showCreateDeck && (
          <Button
            size="sm"
            variant="ghost"
            icon={FolderPlus}
            loading={creatingDeck}
            className="max-w-full self-start text-link!"
            onClick={() => void createVocabDeck()}
          >
            <span className="max-w-[230px] truncate">
              {t('bookPanel.form.createDeck', { nome: info.vocabDeck.name })}
            </span>
          </Button>
        )}
      </div>

      <p className="flex min-w-0 items-baseline gap-1.5 text-xs text-muted">
        <span className="shrink-0">{t('bookPanel.form.fonte')}</span>
        <span data-testid="card-form-fonte" className="min-w-0 truncate text-fg" title={fonteLabel(title, page1)}>
          {fonteLabel(title, page1)}
        </span>
      </p>

      <div className="flex items-center justify-between gap-2 pt-1">
        <span className="min-w-0 truncate text-2xs text-muted">{t('bookPanel.form.keysHint')}</span>
        <div className="flex shrink-0 gap-1.5">
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" type="submit" loading={adding} disabled={!notetype}>
            {t('bookPanel.form.add')}
          </Button>
        </div>
      </div>
    </form>
  );
}

/** The card type as compact radio chips (five labels do not fit a segmented control in 320 px). */
function KindPicker({
  value,
  kinds,
  onChange,
}: {
  value: BookCardKind;
  kinds: BookCardKind[];
  onChange: (k: BookCardKind) => void;
}) {
  const refs = useRef(new Map<BookCardKind, HTMLButtonElement | null>());
  const onKeyDown = (e: KeyboardEvent) => {
    const delta =
      e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const i = kinds.indexOf(value);
    const next = kinds[(i + delta + kinds.length) % kinds.length]!;
    onChange(next);
    refs.current.get(next)?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={t('bookPanel.form.kind')}
      onKeyDown={onKeyDown}
      className="flex flex-wrap gap-1.5"
    >
      {kinds.map((k) => {
        const selected = k === value;
        return (
          <button
            key={k}
            ref={(el) => {
              refs.current.set(k, el);
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(k)}
            className={cn(
              'inline-flex h-7 items-center rounded-full border px-2.5 text-xs whitespace-nowrap transition-colors coarse:min-h-10',
              selected
                ? 'border-lime bg-lime-soft font-semibold text-lime-dark'
                : 'border-line text-muted hover:bg-hover hover:text-fg',
            )}
          >
            {t(KINDS[k].label)}
          </button>
        );
      })}
    </div>
  );
}

function FormField({
  spec,
  value,
  onChange,
  error,
  inputRef,
  onGap,
}: {
  spec: FieldSpec;
  value: string;
  onChange: (v: string) => void;
  error: string | null;
  inputRef: (el: HTMLTextAreaElement | HTMLInputElement | null) => void;
  onGap: (reuse: boolean) => void;
}) {
  return (
    <Field label={spec.name} error={error} hint={spec.role === 'cloze' ? t('bookPanel.form.gapHint') : undefined}>
      {({ id, describedBy, invalid }) =>
        spec.role === 'line' ? (
          <Input
            id={id}
            ref={inputRef}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : (
          <div className="relative">
            <Textarea
              id={id}
              ref={inputRef}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              rows={spec.rows ?? 2}
              value={value}
              spellCheck={spec.role !== 'code'}
              className={cn(
                'min-h-0!',
                spec.role === 'code' && 'font-mono text-sm!',
                spec.role === 'cloze' && 'pr-20!',
              )}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={
                spec.role === 'cloze'
                  ? (e) => {
                      if (
                        (e.ctrlKey || e.metaKey) &&
                        e.shiftKey &&
                        (e.code === 'KeyC' || e.key.toLowerCase() === 'c')
                      ) {
                        e.preventDefault();
                        onGap(e.altKey);
                      }
                    }
                  : undefined
              }
            />
            {spec.role === 'cloze' && (
              <Button
                size="sm"
                variant="neutral"
                icon={Brackets}
                className="absolute top-1.5 right-1.5 h-6! px-2!"
                // Keep the textarea's selection: the gap wraps it.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onGap(false)}
              >
                {t('bookPanel.form.gap')}
              </Button>
            )}
          </div>
        )
      }
    </Field>
  );
}
