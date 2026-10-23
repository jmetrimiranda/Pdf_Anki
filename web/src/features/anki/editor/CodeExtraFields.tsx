// Aceitas/Exige of a note whose (user) notetype has the Comando role (spec 11.1): the notetype has no such
// fields, so they live in this app's `code_note_extra` table. Edited here, saved with the note (NoteEditor).
import { useQuery } from '@tanstack/react-query';
import { Field, Notice, Textarea } from '../../../components/ui';
import { t } from '../../../i18n';
import { core } from '../../../lib/core/client';
import type { CodeNoteExtra, NotetypeInfo } from '../../../lib/core/types';

/** Shared with Configurações → Código (same key). */
export const codeMappingsQuery = {
  queryKey: ['code', 'mappings'] as const,
  queryFn: () => core.codeMappingList(),
};

/** Shared with the study screen's code panel (same key). */
export function codeNoteExtraQuery(noteId: number) {
  return { queryKey: ['code', 'noteExtra', noteId] as const, queryFn: () => core.codeNoteExtraGet(noteId) };
}

/** The extra lists being edited, as text (one entry per line), and what is saved. */
export interface ExtraDraft {
  noteId: number;
  accepted: string;
  requires: string;
  saved: { accepted: string; requires: string };
}

export function extraDraft(extra: CodeNoteExtra): ExtraDraft {
  const saved = { accepted: extra.accepted.join('\n'), requires: extra.requires.join('\n') };
  return { noteId: extra.noteId, ...saved, saved };
}

/** The non-empty, trimmed lines of a list. */
export function extraLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

export function extraDirty(d: ExtraDraft | null): boolean {
  if (!d) return false;
  const same = (a: string, b: string) => extraLines(a).join('\n') === extraLines(b).join('\n');
  return !same(d.accepted, d.saved.accepted) || !same(d.requires, d.saved.requires);
}

/** Whether a note of `notetype` gets the extra lists: a user type with the Comando role. */
export function useCommandRole(notetype: NotetypeInfo | null): boolean {
  const mappings = useQuery({ ...codeMappingsQuery, enabled: !!notetype && !notetype.appType });
  if (!notetype || notetype.appType) return false;
  return !!mappings.data?.some((m) => m.notetypeId === notetype.id && m.missingFields.length === 0);
}

export function CodeExtraFields({
  draft,
  error,
  onRetry,
  onChange,
}: {
  draft: ExtraDraft | null;
  error: boolean;
  onRetry: () => void;
  onChange: (patch: Pick<ExtraDraft, 'accepted'> | Pick<ExtraDraft, 'requires'>) => void;
}) {
  if (error) {
    return (
      <Notice tone="error" onRetry={onRetry}>
        {t('codeAuthoring.extra.loadError')}
      </Notice>
    );
  }
  if (!draft) return null;
  return (
    <section className="flex flex-col gap-2" data-testid="code-extra" aria-label={t('codeAuthoring.extra.title')}>
      <div className="flex flex-col gap-0.5">
        <h3 className="text-xs font-medium text-fg">{t('codeAuthoring.extra.title')}</h3>
        <p className="text-xs text-muted">{t('codeAuthoring.extra.hint')}</p>
      </div>
      <Field label={t('codeAuthoring.extra.accepted')} hint={t('codeAuthoring.extra.acceptedHint')}>
        {({ id, describedBy }) => (
          <Textarea
            id={id}
            aria-describedby={describedBy}
            rows={2}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="font-mono text-sm"
            value={draft.accepted}
            onChange={(e) => onChange({ accepted: e.target.value })}
          />
        )}
      </Field>
      <Field label={t('codeAuthoring.extra.requires')} hint={t('codeAuthoring.extra.requiresHint')}>
        {({ id, describedBy }) => (
          <Textarea
            id={id}
            aria-describedby={describedBy}
            rows={1}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="font-mono text-sm"
            value={draft.requires}
            onChange={(e) => onChange({ requires: e.target.value })}
          />
        )}
      </Field>
    </section>
  );
}
