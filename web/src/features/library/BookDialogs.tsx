import { useState, type FormEvent } from 'react';
import { Button, Dialog, Field, Input } from '../../components/ui';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import type { LibraryEntry } from '../../lib/core/client';

export type BookDialogState =
  | { kind: 'rename'; book: LibraryEntry }
  | { kind: 'move'; book: LibraryEntry }
  | { kind: 'remove'; book: LibraryEntry }
  | null;

interface Common {
  sheet: boolean;
  pending: boolean;
  error: string | undefined;
  onClose: () => void;
}

export function RenameDialog({
  book,
  onSubmit,
  ...c
}: Common & { book: LibraryEntry; onSubmit: (title: string) => void }) {
  const [title, setTitle] = useState(book.title);
  function submit(e: FormEvent) {
    e.preventDefault();
    if (title.trim()) onSubmit(title.trim());
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && c.onClose()}
      title={t('library.renameTitle')}
      variant={c.sheet ? 'sheet' : 'center'}
    >
      <form onSubmit={submit} className="flex flex-col gap-4 pb-3">
        <Field label={t('library.titleLabel')} error={c.error}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              autoFocus
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
            />
          )}
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={c.onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={c.pending} disabled={!title.trim()}>
            {t('library.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function MoveDialog({
  book,
  collections,
  onSubmit,
  ...c
}: Common & { book: LibraryEntry; collections: string[]; onSubmit: (folder: string | null) => void }) {
  const [folder, setFolder] = useState(book.collectionFolder ?? '');
  const suggestions = collections.filter((x) => x !== book.collectionFolder);
  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit(folder.trim() || null);
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && c.onClose()}
      title={t('library.moveTitle')}
      description={t('library.moveDescription')}
      variant={c.sheet ? 'sheet' : 'center'}
    >
      <form onSubmit={submit} className="flex flex-col gap-4 pb-3">
        <Field label={t('library.collectionLabel')} hint={t('library.collectionHint')} error={c.error}>
          {({ id, describedBy, invalid }) => (
            <Input
              id={id}
              autoFocus
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              value={folder}
              placeholder={t('library.collectionPlaceholder')}
              onChange={(e) => setFolder(e.target.value)}
            />
          )}
        </Field>
        {(suggestions.length > 0 || book.collectionFolder) && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted">{t('library.suggestions')}</span>
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map((name) => (
                <SuggestionChip
                  key={name}
                  label={name}
                  selected={folder.trim() === name}
                  onClick={() => setFolder(name)}
                />
              ))}
              {book.collectionFolder && (
                <SuggestionChip
                  label={t('library.noCollection')}
                  selected={folder.trim() === ''}
                  onClick={() => setFolder('')}
                />
              )}
            </div>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={c.onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={c.pending}>
            {t('library.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function SuggestionChip({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center rounded-full border px-3 text-xs transition-colors coarse:h-10',
        selected ? 'border-lime bg-lime-soft font-semibold text-lime-dark' : 'border-line text-fg hover:bg-hover',
      )}
    >
      {label}
    </button>
  );
}

export function RemoveDialog({ book, onConfirm, ...c }: Common & { book: LibraryEntry; onConfirm: () => void }) {
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && c.onClose()}
      title={t('library.removeTitle', { titulo: book.title })}
      description={t('library.removeBody')}
      variant={c.sheet ? 'sheet' : 'center'}
      footer={
        <>
          <Button variant="ghost" onClick={c.onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" loading={c.pending} onClick={onConfirm}>
            {t('library.removeConfirm')}
          </Button>
        </>
      }
    >
      {c.error && <p className="pb-2 text-xs text-error">{c.error}</p>}
    </Dialog>
  );
}

/** Spec 6.6: an imported copy of a library book differs from its current version (it may be older). */
export function ReplaceVersionDialog({
  book,
  sheet,
  onAnswer,
}: {
  book: LibraryEntry;
  sheet: boolean;
  onAnswer: (replace: boolean) => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onAnswer(false)}
      title={t('library.replaceTitle', { titulo: book.title })}
      description={t('library.replaceBody')}
      variant={sheet ? 'sheet' : 'center'}
      footer={
        <>
          <Button variant="ghost" onClick={() => onAnswer(false)}>
            {t('library.replaceKeep')}
          </Button>
          <Button variant="primary" onClick={() => onAnswer(true)}>
            {t('library.replaceConfirm')}
          </Button>
        </>
      }
    />
  );
}
