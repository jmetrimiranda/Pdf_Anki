import { useEffect, useState } from 'react';
import { t } from '../../../i18n';
import { core } from '../../../lib/core/client';
import type { NoteCheck } from '../../../lib/core/types';

/** Anki's field check of the note being edited, debounced (duplicate warning, empty/cloze errors). */
export function useNoteCheck(
  notetypeId: number | null,
  fields: readonly string[] | null,
  delayMs = 350,
): NoteCheck | null {
  const [state, setState] = useState<NoteCheck | null>(null);
  const key = fields ? JSON.stringify(fields) : null;
  useEffect(() => {
    if (notetypeId === null || key === null) {
      setState(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      core
        .ankiNoteCheck(notetypeId, JSON.parse(key) as string[])
        .then((s) => alive && setState(s))
        .catch(() => alive && setState(null));
    }, delayMs);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [notetypeId, key, delayMs]);
  return state;
}

/** Inline error for a check state, on the field it concerns (0 = first field, -1 = the cloze field). */
export function checkError(state: NoteCheck | null): { field: number; message: string } | null {
  switch (state) {
    case 'empty':
      return { field: 0, message: t('anki.editor.check.empty') };
    case 'missingCloze':
      return { field: 0, message: t('anki.editor.check.missingCloze') };
    case 'notetypeNotCloze':
      return { field: 0, message: t('anki.editor.check.notetypeNotCloze') };
    case 'fieldNotCloze':
      return { field: 0, message: t('anki.editor.check.fieldNotCloze') };
    default:
      return null;
  }
}
