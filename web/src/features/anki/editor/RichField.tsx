import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { t } from '../../../i18n';
import { cn } from '../../../lib/cn';
import { insertNodeAt, isImageFile, mediaImage, pastedImageName, rangeIn, wrapCloze, wrapCode } from './commands';
import { editorToFieldHtml, fieldToEditorFragment, rewriteMediaForDisplay, sanitizeToFragment } from './sanitize';

export interface RichFieldHandle {
  focus(): void;
  bold(): void;
  italic(): void;
  code(): void;
  cloze(n: number): void;
  /** Inserts an image already in the media folder. */
  insertImage(name: string): void;
}

export interface RichFieldProps {
  id: string;
  label: string;
  /** Field HTML as stored (untrusted); shown sanitized. Read again only when `resetKey` changes. */
  html: string;
  resetKey: string | number;
  /** User edits, as field HTML. */
  onEdit: (html: string) => void;
  /** Ctrl+Shift+C / Ctrl+Shift+Alt+C: the parent knows the other fields' cloze numbers. */
  onCloze: (reuse: boolean) => void;
  /** Adds an image file to the media folder; resolves with the stored name. */
  onAddImage: (file: File, name: string) => Promise<string>;
  mediaUrl: (name: string) => string;
  onFocus?: () => void;
  rtl?: boolean;
  invalid?: boolean;
  describedBy?: string | undefined;
  className?: string;
}

/** One rich field of the note editor: a contenteditable fed only sanitized HTML (spec 8.2, 18). */
export const RichField = forwardRef<RichFieldHandle, RichFieldProps>(function RichField(
  { id, label, html, resetKey, onEdit, onCloze, onAddImage, mediaUrl, onFocus, rtl, invalid, describedBy, className },
  ref,
) {
  const el = useRef<HTMLDivElement>(null);
  // Latest props for the imperative handle and async paste callbacks.
  const latest = useRef({ onEdit, onAddImage, mediaUrl });
  latest.current = { onEdit, onAddImage, mediaUrl };

  useLayoutEffect(() => {
    el.current?.replaceChildren(fieldToEditorFragment(html, mediaUrl));
    // Only a new note/field (resetKey) reloads the content; typing never round-trips through props.
  }, [resetKey]);

  const emit = () => {
    if (el.current) latest.current.onEdit(editorToFieldHtml(el.current));
  };

  const exec = (command: 'bold' | 'italic') => {
    const root = el.current;
    if (!root) return;
    if (!rangeIn(root)) root.focus();
    document.execCommand(command);
    emit();
  };

  useImperativeHandle(ref, () => ({
    focus: () => el.current?.focus(),
    bold: () => exec('bold'),
    italic: () => exec('italic'),
    code: () => {
      if (!el.current) return;
      if (!rangeIn(el.current)) el.current.focus();
      wrapCode(el.current);
      emit();
    },
    cloze: (n: number) => {
      if (!el.current) return;
      if (!rangeIn(el.current)) el.current.focus();
      wrapCloze(el.current, n);
      emit();
    },
    insertImage: (name: string) => {
      if (!el.current) return;
      insertNodeAt(el.current, mediaImage(document, name, latest.current.mediaUrl(name)));
      emit();
    },
  }));

  const addImages = async (files: File[], at: Range | null) => {
    const root = el.current;
    if (!root) return;
    for (const file of files) {
      const stored = await latest.current.onAddImage(file, pastedImageName(file)).catch(() => null);
      if (stored === null) continue;
      insertNodeAt(root, mediaImage(document, stored, latest.current.mediaUrl(stored)), at);
      at = null;
    }
    emit();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const key = e.code;
    if (!e.shiftKey && !e.altKey && key === 'KeyB') {
      e.preventDefault();
      exec('bold');
    } else if (!e.shiftKey && !e.altKey && key === 'KeyI') {
      e.preventDefault();
      exec('italic');
    } else if (e.shiftKey && !e.altKey && key === 'KeyK') {
      e.preventDefault();
      if (el.current) {
        wrapCode(el.current);
        emit();
      }
    } else if (e.shiftKey && key === 'KeyC') {
      e.preventDefault();
      onCloze(e.altKey);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const root = el.current;
    if (!root) return;
    const files = Array.from(e.clipboardData.files).filter(isImageFile);
    e.preventDefault();
    if (files.length) {
      void addImages(files, rangeIn(root));
      return;
    }
    const pastedHtml = e.clipboardData.getData('text/html');
    if (pastedHtml) {
      const frag = sanitizeToFragment(pastedHtml);
      rewriteMediaForDisplay(frag, latest.current.mediaUrl);
      insertNodeAt(root, document.importNode(frag, true));
      emit();
      return;
    }
    const text = e.clipboardData.getData('text/plain');
    if (text) {
      const lines = text.replace(/\r\n?/g, '\n').split('\n');
      const frag = document.createDocumentFragment();
      lines.forEach((line, i) => {
        if (i > 0) frag.appendChild(document.createElement('br'));
        if (line) frag.appendChild(document.createTextNode(line));
      });
      insertNodeAt(root, frag);
      emit();
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const files = Array.from(e.dataTransfer.files).filter(isImageFile);
    if (!files.length) {
      // Dropped text/HTML would go in unsanitized: only plain text is accepted.
      const text = e.dataTransfer.getData('text/plain');
      e.preventDefault();
      if (text && el.current) {
        insertNodeAt(el.current, document.createTextNode(text), caretAt(e.clientX, e.clientY));
        emit();
      }
      return;
    }
    e.preventDefault();
    void addImages(files, caretAt(e.clientX, e.clientY));
  };

  return (
    <div
      ref={el}
      id={id}
      role="textbox"
      aria-multiline="true"
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      contentEditable
      suppressContentEditableWarning
      spellCheck
      dir={rtl ? 'rtl' : undefined}
      data-placeholder={t('anki.editor.fieldPlaceholder')}
      onInput={emit}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onDrop={onDrop}
      onFocus={onFocus}
      className={cn(
        'min-h-16 w-full overflow-x-auto rounded-ctl border border-line bg-card px-2.5 py-1.5 text-base leading-relaxed text-fg break-words transition-colors outline-none',
        'hover:border-[color-mix(in_srgb,var(--text)_25%,var(--border))] focus-visible:border-lime focus-visible:outline-2 focus-visible:outline-offset-0 aria-invalid:border-error',
        'empty:before:pointer-events-none empty:before:text-muted empty:before:content-[attr(data-placeholder)]',
        '[&_img]:inline-block [&_img]:max-h-60 [&_img]:max-w-full [&_img]:rounded-[4px] [&_img]:align-middle',
        '[&_code]:rounded-[4px] [&_code]:bg-neutral [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.92em]',
        '[&_pre]:overflow-x-auto [&_pre]:font-mono [&_a]:text-link [&_a]:underline [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6',
        className,
      )}
    />
  );
});

function caretAt(x: number, y: number): Range | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (doc.caretRangeFromPoint) return doc.caretRangeFromPoint(x, y);
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (!pos) return null;
  const range = document.createRange();
  range.setStart(pos.offsetNode, pos.offset);
  range.collapse(true);
  return range;
}
