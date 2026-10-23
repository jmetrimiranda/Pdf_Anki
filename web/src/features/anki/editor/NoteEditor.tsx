import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';
import { Button, Kbd, Notice, Skeleton, Spinner, useToast } from '../../../components/ui';
import { t } from '../../../i18n';
import { cn } from '../../../lib/cn';
import { core, CoreError } from '../../../lib/core/client';
import { q } from '../../../lib/core/queries';
import { draftFields, editField, isDirty, markSaved, newDraft, setTags, type Draft } from './draft';
import {
  CodeExtraFields,
  codeNoteExtraQuery,
  extraDirty,
  extraDraft,
  extraLines,
  useCommandRole,
  type ExtraDraft,
} from './CodeExtraFields';
import { NoteFields } from './NoteFields';
import { ReferenceTest } from './ReferenceTest';
import { codeRoleOf, fieldsByName, gateKey, useReferenceGate } from './referenceTest';
import { TagsInput } from './TagsInput';
import { checkError, useNoteCheck } from './useNoteCheck';

export interface NoteEditorHandle {
  /** Saves if something changed; resolves false when saving failed. */
  save(): Promise<boolean>;
  dirty(): boolean;
}

export function noteQuery(noteId: number) {
  return { queryKey: ['anki', 'note', noteId], queryFn: () => core.ankiNoteGet(noteId), staleTime: 0 } as const;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Edits an existing note (spec 8.2 Editar). Only fields the user changed are written back (see draft.ts).
 * `autosave` (the browser's side panel): saves when the focus leaves the editor and when it unmounts.
 */
export const NoteEditor = forwardRef<
  NoteEditorHandle,
  {
    noteId: number;
    autosave?: boolean;
    /** After a save, with the note that was saved (it may be one the editor already left). */
    onSaved?: (noteId: number) => void;
    onDirtyChange?: (dirty: boolean) => void;
    /** A code field changed and the reference test has not passed yet (spec 11.7): saving is blocked. */
    onSaveBlockedChange?: (blocked: boolean) => void;
    /** Ctrl+Enter; saves when not given. */
    onSubmit?: () => void;
    className?: string;
  }
>(function NoteEditor({ noteId, autosave, onSaved, onDirtyChange, onSaveBlockedChange, onSubmit, className }, ref) {
  const qc = useQueryClient();
  const toast = useToast();
  const note = useQuery(noteQuery(noteId));
  const notetypes = useQuery(q.notetypes());
  const tags = useQuery(q.tagsAll());
  // The draft and the note it belongs to (a save after switching notes must go to the right note).
  const [edit, setEdit] = useState<{ noteId: number; draft: Draft } | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const editRef = useRef(edit);
  editRef.current = edit;
  const draft = edit?.draft ?? null;
  const loadedFor = edit?.noteId ?? null;
  const draftRef = useRef<Draft | null>(null);
  draftRef.current = draft;
  const setDraft = useCallback((f: (d: Draft) => Draft) => setEdit((e) => (e ? { ...e, draft: f(e.draft) } : e)), []);
  const saving = useRef<Promise<boolean> | null>(null);
  const callbacks = useRef({ onSaved, onDirtyChange, onSaveBlockedChange });
  callbacks.current = { onSaved, onDirtyChange, onSaveBlockedChange };

  // The draft is built once per note; later refetches never overwrite what the user is typing.
  useEffect(() => {
    if (note.data && note.data.id === noteId && loadedFor !== noteId) {
      setEdit({ noteId, draft: newDraft(note.data.fields, note.data.tags) });
      setSaveState('idle');
    }
  }, [note.data, noteId, loadedFor]);

  const notetype = notetypes.data?.find((nt) => nt.id === note.data?.notetypeId) ?? null;

  // A user type with the Comando role: its Aceitas/Exige live in `code_note_extra` (spec 11.1).
  const commandRole = useCommandRole(notetype && note.data?.notetypeId === notetype.id ? notetype : null);
  const extraQ = useQuery({ ...codeNoteExtraQuery(noteId), enabled: commandRole, staleTime: 0 });
  const [extra, setExtra] = useState<ExtraDraft | null>(null);
  const extraRef = useRef(extra);
  extraRef.current = extra;
  useEffect(() => {
    if (extraQ.data && extraQ.data.noteId === noteId && extraRef.current?.noteId !== noteId) {
      setExtra(extraDraft(extraQ.data));
    }
  }, [extraQ.data, noteId]);
  const extraForNote = commandRole && extra?.noteId === noteId ? extra : null;

  const fieldsDirty = draft ? isDirty(draft) : false;
  const dirty = fieldsDirty || extraDirty(extraForNote);
  useEffect(() => callbacks.current.onDirtyChange?.(dirty), [dirty]);

  const fields = useMemo(() => (draft ? draftFields(draft) : null), [draft]);
  const check = useNoteCheck(notetype?.id ?? null, fieldsDirty ? fields : null);
  const err = checkError(check);

  // App code types: when a code field changed, the reference must pass again before saving (spec 11.7).
  const byName = useMemo(() => (notetype && fields ? fieldsByName(notetype, fields) : null), [notetype, fields]);
  const codeChanged = useMemo(
    () => !!notetype && !!draft && !!byName && gateKey(byName) !== gateKey(fieldsByName(notetype, draft.original)),
    [notetype, draft, byName],
  );
  const gate = useReferenceGate(codeRoleOf(notetype), byName, codeChanged);
  const gateRef = useRef(gate);
  gateRef.current = gate;
  const blocked = !gate.canSave;
  useEffect(() => callbacks.current.onSaveBlockedChange?.(blocked), [blocked]);

  const save = useCallback(
    async (untested = false): Promise<boolean> => {
      const e = editRef.current;
      if (saving.current) await saving.current;
      if (!e) return true;
      const x = extraRef.current?.noteId === e.noteId && extraDirty(extraRef.current) ? extraRef.current : null;
      const notesDirty = isDirty(e.draft);
      if (!notesDirty && !x) return true;
      if (notesDirty && !untested && !gateRef.current.canSave) {
        toast.show(t('codeAuthoring.testNeeded'), { tone: 'error' });
        return false;
      }
      const d = e.draft;
      const job = (async () => {
        setSaveState('saving');
        try {
          if (notesDirty) {
            await core.ankiNoteUpdate(e.noteId, draftFields(d), [...d.tags]);
            // Keep later keystrokes: only what was saved becomes the new original.
            setEdit((cur) =>
              cur && cur.noteId === e.noteId
                ? { ...cur, draft: { ...markSaved(d), edits: diffEdits(cur.draft, d), tags: cur.draft.tags } }
                : cur,
            );
            void qc.invalidateQueries({ queryKey: ['anki', 'note', e.noteId] });
          }
          if (x) {
            const saved = await core.codeNoteExtraSet(e.noteId, extraLines(x.accepted), extraLines(x.requires));
            qc.setQueryData(codeNoteExtraQuery(e.noteId).queryKey, saved);
            const savedText = extraDraft(saved).saved;
            // Later keystrokes stay; what was saved becomes the new baseline.
            setExtra((cur) => (cur && cur.noteId === e.noteId ? { ...cur, saved: savedText } : cur));
          }
          setSaveState('saved');
          void qc.invalidateQueries({ queryKey: ['anki', 'tags'] });
          callbacks.current.onSaved?.(e.noteId);
          return true;
        } catch (e) {
          setSaveState('error');
          toast.show(e instanceof CoreError || e instanceof Error ? e.message : t('errors.unexpected'), {
            tone: 'error',
          });
          return false;
        } finally {
          saving.current = null;
        }
      })();
      saving.current = job;
      return job;
    },
    [qc, toast],
  );

  useImperativeHandle(
    ref,
    () => ({
      save: () => save(),
      dirty: () =>
        (!!draftRef.current && isDirty(draftRef.current)) ||
        (extraRef.current?.noteId === editRef.current?.noteId && extraDirty(extraRef.current)),
    }),
    [save],
  );

  // Leaving the note (another row, closing the panel) saves it.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(
    () => () => {
      if (autosave) void saveRef.current();
    },
    [autosave, noteId],
  );

  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!autosave) return;
    const next = e.relatedTarget as Node | null;
    // Popovers (tag suggestions) render inside; portals (menus) do not steal the save.
    if (next && e.currentTarget.contains(next)) return;
    // A code change waiting for its reference test is saved only after it passes.
    if (!gateRef.current.canSave) return;
    void save();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      // After the tags input has committed a half-typed tag.
      setTimeout(() => (onSubmit ? onSubmit() : void save()), 0);
    }
  };

  if (note.isError || notetypes.isError) {
    const error = note.error ?? notetypes.error;
    return (
      <Notice tone="error" onRetry={() => void note.refetch()} className={className}>
        {error instanceof Error ? error.message : t('errors.unexpected')}
      </Notice>
    );
  }

  if (!draft || !notetype || loadedFor !== noteId) {
    return (
      <div role="status" aria-label={t('common.loading')} className={cn('flex flex-col gap-3', className)}>
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  return (
    <div
      className={cn('flex flex-col gap-3', className)}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      data-testid="note-editor"
    >
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted">
        <span className="min-w-0 truncate">{t('anki.editor.notetypeOf', { tipo: notetype.name })}</span>
        <span className="flex-1" />
        <SaveStatus state={saveState} dirty={dirty} />
      </div>
      <NoteFields
        notetype={notetype}
        fields={draft.original}
        resetKey={`${noteId}`}
        onEdit={(i, html) => setDraft((d) => editField(d, i, html))}
        getFields={() => (draftRef.current ? draftFields(draftRef.current) : [])}
        errors={err ? { [err.field]: err.message } : undefined}
        onImageError={(m) => toast.show(m, { tone: 'error' })}
      />
      {check === 'duplicate' && <Notice tone="info">{t('anki.editor.duplicate')}</Notice>}
      {commandRole && (
        <CodeExtraFields
          draft={extraForNote}
          error={extraQ.isError}
          onRetry={() => void extraQ.refetch()}
          onChange={(patch) => setExtra((cur) => (cur && cur.noteId === noteId ? { ...cur, ...patch } : cur))}
        />
      )}
      <ReferenceTest
        gate={gate}
        onSaveUntested={() => {
          gate.allowUntested();
          void save(true);
        }}
      />
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted">{t('anki.editor.tags')}</span>
        <TagsInput
          value={draft.tags}
          onChange={(next) => setDraft((d) => setTags(d, next))}
          suggestions={tags.data ?? []}
          label={t('anki.editor.tags')}
        />
      </div>
      {autosave && (
        <div className="flex items-center justify-end gap-3">
          <span className="hidden text-xs text-muted lg:inline-flex lg:items-center lg:gap-1.5">
            <Kbd>Ctrl+Enter</Kbd> {t('anki.editor.saveHint')}
          </span>
          <Button size="sm" disabled={!dirty || blocked} loading={saveState === 'saving'} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </div>
      )}
    </div>
  );
});

/** Edits typed while a save was in flight, relative to what was saved. */
function diffEdits(cur: Draft, saved: Draft): Map<number, string> {
  const savedFields = draftFields(saved);
  const out = new Map<number, string>();
  for (const [i, html] of cur.edits) if (html !== savedFields[i]) out.set(i, html);
  return out;
}

function SaveStatus({ state, dirty }: { state: SaveState; dirty: boolean }) {
  if (state === 'saving')
    return (
      <span className="inline-flex items-center gap-1.5" role="status">
        <Spinner /> {t('anki.editor.saving')}
      </span>
    );
  if (dirty) return <span role="status">{t('anki.editor.unsaved')}</span>;
  if (state === 'saved')
    return (
      <span className="inline-flex items-center gap-1 text-lime-dark" role="status">
        <Check size={13} aria-hidden /> {t('anki.editor.saved')}
      </span>
    );
  return null;
}
