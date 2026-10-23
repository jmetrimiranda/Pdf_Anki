import { useRef, useState } from 'react';
import { Button, Dialog } from '../../../components/ui';
import { t } from '../../../i18n';
import { NoteEditor, type NoteEditorHandle } from './NoteEditor';

/** "Editar nota" in a dialog (narrow screens, the study screen's E). Cancel/Escape discard; Salvar/Ctrl+Enter save. */
export function NoteEditorDialog({
  noteId,
  open,
  onOpenChange,
  onSaved,
}: {
  noteId: number | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Called with the saved note id (callers may ignore it). */
  onSaved?: (noteId: number) => void;
}) {
  const editor = useRef<NoteEditorHandle>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [blocked, setBlocked] = useState(false);

  const save = async () => {
    if (!editor.current) return;
    setSaving(true);
    const ok = await editor.current.save();
    setSaving(false);
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog
      open={open && noteId !== null}
      onOpenChange={onOpenChange}
      title={t('anki.editor.editTitle')}
      className="w-[min(720px,calc(100vw-32px))]!"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={saving} disabled={!dirty || blocked} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      {noteId !== null && (
        <div className="pb-2">
          <NoteEditor
            ref={editor}
            noteId={noteId}
            onSaved={onSaved}
            onDirtyChange={setDirty}
            onSaveBlockedChange={setBlocked}
            onSubmit={() => void save()}
          />
        </div>
      )}
    </Dialog>
  );
}
