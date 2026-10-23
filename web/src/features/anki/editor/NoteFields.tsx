import { Bold, Braces, Code, Italic, Pin } from 'lucide-react';
import { forwardRef, useId, useImperativeHandle, useRef, useState } from 'react';
import { IconButton, Toolbar, ToolbarSeparator, Tooltip } from '../../../components/ui';
import { t } from '../../../i18n';
import { cn } from '../../../lib/cn';
import { core } from '../../../lib/core/client';
import type { NotetypeInfo } from '../../../lib/core/types';
import { nextClozeNumber } from './cloze';
import { codeFieldKind, htmlToCode, LANGUAGES, MODES } from './codeField';
import { CodeFieldEditor, CodeMirrorField, CodeSelectField } from './CodeFieldEditor';
import { RichField, type RichFieldHandle } from './RichField';

export interface NoteFieldsHandle {
  focusFirst(): void;
}

/** Adds an image file to the collection's media and resolves with the stored name (errors are reported). */
export async function addImageFile(file: File, name: string): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return core.ankiMediaAdd(name, bytes);
}

export interface NoteFieldsProps {
  notetype: NotetypeInfo;
  /** Field HTML as loaded (read again only when `resetKey` changes). */
  fields: readonly string[];
  resetKey: string | number;
  onEdit: (index: number, html: string) => void;
  /** Current values of every field (cloze numbers are counted across all of them). */
  getFields: () => readonly string[];
  errors?: Partial<Record<number, string>>;
  /** "Sticky" fields of the Add screen (kept after adding). */
  pinned?: readonly boolean[];
  onTogglePin?: (index: number) => void;
  onImageError?: (message: string) => void;
}

/**
 * The fields of a note with the formatting toolbar (spec 8.2): rich fields for HTML, the code editor for the code
 * fields of the app's code notetypes (spec 11.1).
 */
export const NoteFields = forwardRef<NoteFieldsHandle, NoteFieldsProps>(function NoteFields(
  { notetype, fields, resetKey, onEdit, getFields, errors, pinned, onTogglePin, onImageError },
  ref,
) {
  const baseId = useId();
  const rich = useRef(new Map<number, RichFieldHandle>());
  const code = useRef(new Map<number, HTMLTextAreaElement>());
  const [active, setActive] = useState(0);
  const isCloze = notetype.kind === 'cloze';
  const kindAt = (i: number) => codeFieldKind(notetype, notetype.fields[i]?.name ?? '');
  const codeAt = (i: number) => kindAt(i) !== null;
  // The language of a Programa note's code editors follows its Linguagem select.
  const languageIndex =
    notetype.appType === 'Código · Programa' ? notetype.fields.findIndex((f) => f.name === 'Linguagem') : -1;
  const [language, setLanguage] = useState(() => (languageIndex >= 0 ? htmlToCode(fields[languageIndex] ?? '') : ''));
  const [languageFor, setLanguageFor] = useState(resetKey);
  if (languageFor !== resetKey) {
    setLanguageFor(resetKey);
    setLanguage(languageIndex >= 0 ? htmlToCode(fields[languageIndex] ?? '') : '');
  }
  const editorLanguage =
    notetype.appType === 'Código · Comando' ? 'shell' : language.trim() === 'cpp' ? 'cpp' : 'python';
  const activeIsRich = !codeAt(active);
  const firstRich = notetype.fields.findIndex((_, i) => !codeAt(i));

  const target = (): RichFieldHandle | undefined => {
    if (activeIsRich) return rich.current.get(active);
    return firstRich >= 0 ? rich.current.get(firstRich) : undefined;
  };

  const cloze = (reuse: boolean) => {
    if (!isCloze) return;
    target()?.cloze(nextClozeNumber(getFields(), reuse));
  };

  useImperativeHandle(ref, () => ({
    focusFirst: () => {
      if (codeAt(0)) code.current.get(0)?.focus();
      else rich.current.get(0)?.focus();
    },
  }));

  const onImage = (file: File, name: string) =>
    addImageFile(file, name).catch((err: unknown) => {
      onImageError?.(err instanceof Error ? err.message : t('anki.editor.imageFailed'));
      throw err;
    });

  return (
    <div className="flex flex-col gap-3">
      <Toolbar label={t('anki.editor.toolbar')} className="-ml-1 flex-wrap">
        {/* mousedown is prevented so the field keeps its selection. */}
        <span onMouseDown={(e) => e.preventDefault()} className="contents">
          <IconButton
            icon={Bold}
            size="sm"
            label={t('anki.editor.bold')}
            shortcut="Ctrl+B"
            disabled={!activeIsRich}
            onClick={() => target()?.bold()}
          />
          <IconButton
            icon={Italic}
            size="sm"
            label={t('anki.editor.italic')}
            shortcut="Ctrl+I"
            disabled={!activeIsRich}
            onClick={() => target()?.italic()}
          />
          <IconButton
            icon={Code}
            size="sm"
            label={t('anki.editor.code')}
            shortcut="Ctrl+Shift+K"
            disabled={!activeIsRich}
            onClick={() => target()?.code()}
          />
          <ToolbarSeparator />
          {isCloze ? (
            <IconButton
              icon={Braces}
              size="sm"
              label={t('anki.editor.cloze')}
              shortcut="Ctrl+Shift+C"
              onClick={() => cloze(false)}
            />
          ) : (
            <Tooltip content={t('anki.editor.clozeDisabled')}>
              {/* A disabled button gets no pointer events: the wrapper carries the tooltip. */}
              <span tabIndex={0} aria-label={t('anki.editor.clozeDisabled')} className="inline-flex rounded-ctl">
                <IconButton icon={Braces} size="sm" label={t('anki.editor.cloze')} tooltip={false} disabled />
              </span>
            </Tooltip>
          )}
        </span>
      </Toolbar>
      {notetype.fields.map((f, i) => {
        const id = `${baseId}-f${i}`;
        const errId = `${id}-err`;
        const error = errors?.[i];
        const kind = kindAt(i);
        const isCode = kind !== null;
        return (
          <div key={`${notetype.id}-${i}`} className="flex flex-col gap-1">
            <div className="flex min-h-6 items-center gap-2">
              <span id={`${id}-label`} className={cn('text-xs', active === i ? 'text-fg' : 'text-muted')}>
                {f.name}
                {isCode && <span className="ml-1.5 text-2xs text-muted">{t('anki.editor.codeFieldHint')}</span>}
              </span>
              <span className="flex-1" />
              {pinned && onTogglePin && (
                <IconButton
                  icon={Pin}
                  size="sm"
                  active={!!pinned[i]}
                  label={
                    pinned[i]
                      ? t('anki.editor.unpinField', { campo: f.name })
                      : t('anki.editor.pinField', { campo: f.name })
                  }
                  onClick={() => onTogglePin(i)}
                  className={cn('size-6', !pinned[i] && 'opacity-45 hover:opacity-100 focus-visible:opacity-100')}
                />
              )}
            </div>
            {kind === 'language' || kind === 'mode' ? (
              <CodeSelectField
                id={id}
                label={f.name}
                html={fields[i] ?? ''}
                resetKey={resetKey}
                options={kind === 'language' ? LANGUAGES : MODES}
                onEdit={(html) => {
                  if (kind === 'language') setLanguage(htmlToCode(html));
                  onEdit(i, html);
                }}
                onFocus={() => setActive(i)}
                invalid={!!error}
                describedBy={error ? errId : undefined}
              />
            ) : kind === 'editor' ? (
              <CodeMirrorField
                label={f.name}
                html={fields[i] ?? ''}
                resetKey={resetKey}
                language={editorLanguage}
                onEdit={(html) => onEdit(i, html)}
                onFocus={() => setActive(i)}
              />
            ) : isCode ? (
              <CodeFieldEditor
                ref={(el) => {
                  if (el) code.current.set(i, el);
                  else code.current.delete(i);
                }}
                id={id}
                label={f.name}
                html={fields[i] ?? ''}
                resetKey={resetKey}
                onEdit={(html) => onEdit(i, html)}
                onFocus={() => setActive(i)}
                invalid={!!error}
                describedBy={error ? errId : undefined}
              />
            ) : (
              <RichField
                ref={(h) => {
                  if (h) rich.current.set(i, h);
                  else rich.current.delete(i);
                }}
                id={id}
                label={f.name}
                html={fields[i] ?? ''}
                resetKey={resetKey}
                onEdit={(html) => onEdit(i, html)}
                onCloze={cloze}
                onAddImage={onImage}
                mediaUrl={(name) => core.cardMediaUrl(name)}
                onFocus={() => setActive(i)}
                rtl={f.rtl}
                invalid={!!error}
                describedBy={error ? errId : undefined}
              />
            )}
            {error && (
              <p id={errId} className="text-xs text-error">
                {error}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
});
