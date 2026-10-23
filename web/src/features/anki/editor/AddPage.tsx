import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ImagePlus, Plus, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Card, Kbd, Notice, Skeleton, useToast } from '../../../components/ui';
import { t } from '../../../i18n';
import { core, CoreError } from '../../../lib/core/client';
import { q } from '../../../lib/core/queries';
import type { NotetypeInfo } from '../../../lib/core/types';
import { DeckPicker } from '../shared/DeckPicker';
import { draftFields, editField, newDraft, setTags, type Draft } from './draft';
import { NoteFields, type NoteFieldsHandle } from './NoteFields';
import { NotetypePicker } from './NotetypePicker';
import { TagsInput } from './TagsInput';
import { useGo } from './useGo';
import { checkError, useNoteCheck } from './useNoteCheck';

const APP_TYPE_COUNT = 5;

function errorMessage(err: unknown): string {
  return err instanceof CoreError || err instanceof Error ? err.message : t('errors.unexpected');
}

function pinnedKey(ntid: number): string {
  return `leitor.anki.pinned.${ntid}`;
}

function loadPinned(nt: NotetypeInfo): boolean[] {
  try {
    const raw = localStorage.getItem(pinnedKey(nt.id));
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (Array.isArray(parsed)) return nt.fields.map((_, i) => parsed[i] === true);
  } catch {
    // Missing or corrupt: nothing pinned.
  }
  return nt.fields.map(() => false);
}

/** Fields carried over to another notetype, by position (as Anki's Add window does). */
function carryOver(fields: readonly string[], to: NotetypeInfo): string[] {
  return to.fields.map((_, i) => fields[i] ?? '');
}

/** "Adicionar" (spec 8.2): own editor, notetype and deck pickers, tags; Ctrl+Enter adds. */
export function AddPage({ deckId: deckProp, notetypeId: notetypeProp }: { deckId?: number; notetypeId?: number }) {
  const toast = useToast();
  const qc = useQueryClient();
  const go = useGo();
  const notetypes = useQuery(q.notetypes());
  const defaults = useQuery({
    queryKey: ['anki', 'addDefaults', deckProp ?? null],
    queryFn: () => core.ankiAddDefaults(deckProp ?? null),
    staleTime: 0,
  });
  const tags = useQuery(q.tagsAll());

  const [ntid, setNtid] = useState<number | null>(notetypeProp ?? null);
  const [deckId, setDeckId] = useState<number | null>(deckProp ?? null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [pinned, setPinned] = useState<boolean[]>([]);
  const [attempted, setAttempted] = useState(false);
  const [adding, setAdding] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const fieldsRef = useRef<NoteFieldsHandle>(null);
  const draftRef = useRef<Draft | null>(null);
  draftRef.current = draft;

  const notetype = notetypes.data?.find((nt) => nt.id === ntid) ?? null;
  // Refetching the notetypes must not reset the fields: only another notetype (or other fields) does.
  const notetypeKey = notetype ? `${notetype.id}:${notetype.fields.map((f) => f.name).join('\u0001')}` : null;
  const notetypeRef = useRef(notetype);
  notetypeRef.current = notetype;

  // Defaults arrive: pick the notetype/deck the props did not fix.
  useEffect(() => {
    if (!defaults.data || !notetypes.data) return;
    setNtid((cur) => {
      if (cur !== null && notetypes.data.some((nt) => nt.id === cur)) return cur;
      return notetypes.data.some((nt) => nt.id === defaults.data.notetypeId)
        ? defaults.data.notetypeId
        : (notetypes.data[0]?.id ?? null);
    });
    setDeckId((cur) => cur ?? defaults.data.deckId);
  }, [defaults.data, notetypes.data]);

  // A (new) notetype: fresh draft with the previous contents carried over by position.
  useEffect(() => {
    const notetype = notetypeRef.current;
    if (!notetype) return;
    const prev = draftRef.current;
    setDraft(newDraft(carryOver(prev ? draftFields(prev) : [], notetype), prev?.tags ?? []));
    setPinned(loadPinned(notetype));
    setResetKey((k) => k + 1);
    setAttempted(false);
  }, [notetypeKey]);

  const fields = useMemo(() => (draft ? draftFields(draft) : null), [draft]);
  const check = useNoteCheck(notetype?.id ?? null, fields);
  const firstHasText = !!fields?.[0]?.replace(/<[^>]*>|&nbsp;|\s/g, '');
  const err = checkError(check);
  const showErr = err && (attempted || (check !== 'empty' && firstHasText)) ? err : null;

  const missingAppTypes = notetypes.data ? APP_TYPE_COUNT - notetypes.data.filter((nt) => nt.appType).length : 0;

  const togglePin = (i: number) => {
    if (!notetype) return;
    setPinned((p) => {
      const next = notetype.fields.map((_, k) => (k === i ? !p[k] : !!p[k]));
      try {
        localStorage.setItem(pinnedKey(notetype.id), JSON.stringify(next));
      } catch {
        // Storage unavailable: pins last for this session only.
      }
      return next;
    });
  };

  const add = async () => {
    const d = draftRef.current;
    if (!d || !notetype || deckId === null || adding) return;
    const values = draftFields(d);
    setAdding(true);
    try {
      const state = await core.ankiNoteCheck(notetype.id, values);
      if (checkError(state)) {
        setAttempted(true);
        fieldsRef.current?.focusFirst();
        return;
      }
      const added = await core.ankiNoteAdd({ notetypeId: notetype.id, deckId, fields: values, tags: [...d.tags] });
      toast.show(added.cardCount === 1 ? t('anki.editor.added') : t('anki.editor.addedMany', { n: added.cardCount }), {
        tone: 'success',
      });
      // Sticky fields stay; notetype, deck and tags too.
      setDraft(
        newDraft(
          values.map((v, i) => (pinned[i] ? v : '')),
          d.tags,
        ),
      );
      setResetKey((k) => k + 1);
      setAttempted(false);
      void qc.invalidateQueries({ queryKey: ['anki'], refetchType: 'active' });
      requestAnimationFrame(() => fieldsRef.current?.focusFirst());
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    } finally {
      setAdding(false);
    }
  };

  const prepare = async () => {
    setPreparing(true);
    try {
      const report = await core.ankiPrepareCollection();
      toast.show(t('anki.editor.prepared', { n: report.created.length }), { tone: 'success' });
      await qc.invalidateQueries({ queryKey: ['anki', 'notetypes'] });
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    } finally {
      setPreparing(false);
    }
  };

  const occlusion = async () => {
    try {
      const path = await core.pickImageFile();
      if (path) go(`/anki/pagina/image-occlusion/${encodeURIComponent(path)}`);
    } catch (e) {
      toast.show(errorMessage(e), { tone: 'error' });
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      // Let the tags input commit a half-typed tag first.
      setTimeout(() => void add(), 0);
    }
  };

  const loadError = notetypes.error ?? defaults.error;

  return (
    <div className="h-full overflow-auto" onKeyDown={onKeyDown}>
      <div className="mx-auto flex max-w-[760px] flex-col gap-4 px-4 pt-4 pb-10 sm:px-6" data-testid="anki-add">
        <h1 className="sr-only">{t('anki.editor.addTitle')}</h1>
        {loadError && (
          <Notice
            tone="error"
            onRetry={() => {
              void notetypes.refetch();
              void defaults.refetch();
            }}
          >
            {errorMessage(loadError)}
          </Notice>
        )}
        {missingAppTypes > 0 && (
          <Notice tone="info">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="min-w-0 flex-1">{t('anki.editor.prepareHint', { n: missingAppTypes })}</span>
              <Button size="sm" icon={Wand2} loading={preparing} onClick={() => void prepare()}>
                {t('anki.editor.prepare')}
              </Button>
            </div>
          </Notice>
        )}
        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          {notetypes.data ? (
            <NotetypePicker
              notetypes={notetypes.data}
              value={ntid}
              onChange={setNtid}
              label={t('anki.editor.notetype')}
            />
          ) : (
            <Skeleton className="h-8 w-full" />
          )}
          <DeckPicker value={deckId} onChange={setDeckId} label={t('anki.editor.deck')} />
          <Button icon={ImagePlus} onClick={() => void occlusion()}>
            {t('anki.editor.imageOcclusion')}
          </Button>
        </div>
        <Card className="flex flex-col gap-3">
          {notetype && draft ? (
            <NoteFields
              ref={fieldsRef}
              notetype={notetype}
              fields={draft.original}
              resetKey={`${notetype.id}-${resetKey}`}
              onEdit={(i, html) => setDraft((d) => (d ? editField(d, i, html) : d))}
              getFields={() => (draftRef.current ? draftFields(draftRef.current) : [])}
              errors={showErr ? { [showErr.field]: showErr.message } : undefined}
              pinned={pinned}
              onTogglePin={togglePin}
              onImageError={(m) => toast.show(m, { tone: 'error' })}
            />
          ) : (
            <div className="flex flex-col gap-3" role="status" aria-label={t('common.loading')}>
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          )}
          {check === 'duplicate' && (
            <Notice tone="info" className="border-[color-mix(in_srgb,var(--vocab-learning)_45%,var(--border))]">
              {t('anki.editor.duplicate')}
            </Notice>
          )}
        </Card>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted">{t('anki.editor.tags')}</span>
          <TagsInput
            value={draft?.tags ?? []}
            onChange={(next) => setDraft((d) => (d ? setTags(d, next) : d))}
            suggestions={tags.data ?? []}
            label={t('anki.editor.tags')}
          />
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <span className="hidden text-xs text-muted sm:inline-flex sm:items-center sm:gap-1.5">
            <Kbd>Ctrl+Enter</Kbd> {t('anki.editor.addHint')}
          </span>
          <Button
            variant="primary"
            icon={Plus}
            loading={adding}
            disabled={!notetype || deckId === null}
            onClick={() => void add()}
          >
            {t('anki.editor.add')}
          </Button>
        </div>
      </div>
    </div>
  );
}
