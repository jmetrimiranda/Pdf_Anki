import { forwardRef, useLayoutEffect, useState } from 'react';
import { CodeEditor, type CodeLanguage } from '../../../components/code/CodeEditor';
import { Select } from '../../../components/ui';
import { t, type MessageKey } from '../../../i18n';
import { cn } from '../../../lib/cn';
import { codeToHtml, htmlToCode } from './codeField';

/** Monospace editor for the code fields of the app's code notetypes (spec 11.1): HTML ↔ text on load/save. */
export const CodeFieldEditor = forwardRef<
  HTMLTextAreaElement,
  {
    id: string;
    label: string;
    html: string;
    resetKey: string | number;
    onEdit: (html: string) => void;
    onFocus?: () => void;
    invalid?: boolean;
    describedBy?: string | undefined;
  }
>(function CodeFieldEditor({ id, label, html, resetKey, onEdit, onFocus, invalid, describedBy }, ref) {
  const [text, setText] = useState(() => htmlToCode(html));
  useLayoutEffect(() => {
    setText(htmlToCode(html));
    // Reloaded only for another note/field.
  }, [resetKey]);
  const lines = Math.min(14, Math.max(2, text.split('\n').length + 1));
  return (
    <textarea
      ref={ref}
      id={id}
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      value={text}
      rows={lines}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      onFocus={onFocus}
      onChange={(e) => {
        setText(e.target.value);
        onEdit(codeToHtml(e.target.value));
      }}
      className={cn(
        'w-full resize-y rounded-ctl border border-line bg-neutral px-2.5 py-1.5 font-mono text-[13px] leading-relaxed text-fg [tab-size:4] transition-colors',
        'hover:border-[color-mix(in_srgb,var(--text)_25%,var(--border))] focus-visible:border-lime focus-visible:outline-2 focus-visible:outline-offset-0 aria-invalid:border-error',
      )}
    />
  );
});

/** Plain text of a field, reloaded from the HTML only for another note/field (`resetKey`). */
function useFieldText(html: string, resetKey: string | number): [string, (v: string) => void] {
  const [text, setText] = useState(() => htmlToCode(html));
  useLayoutEffect(() => {
    setText(htmlToCode(html));
    // Reloaded only for another note/field.
  }, [resetKey]);
  return [text, setText];
}

/** The CodeMirror editor for the code fields of the app's code notetypes (Resposta, Inicial, Setup, Testes). */
export function CodeMirrorField({
  label,
  html,
  resetKey,
  language,
  onEdit,
  onFocus,
}: {
  label: string;
  html: string;
  resetKey: string | number;
  language: CodeLanguage;
  onEdit: (html: string) => void;
  onFocus?: () => void;
}) {
  const [text, setText] = useFieldText(html, resetKey);
  return (
    <div onFocus={onFocus}>
      <CodeEditor
        value={text}
        language={language}
        ariaLabel={label}
        minLines={language === 'shell' ? 2 : 3}
        maxLines={20}
        onChange={(v) => {
          setText(v);
          onEdit(codeToHtml(v));
        }}
      />
    </div>
  );
}

const OPTION_LABEL: Record<string, MessageKey> = {
  python: 'codeAuthoring.lang.python',
  cpp: 'codeAuthoring.lang.cpp',
  testes: 'codeAuthoring.mode.testes',
  saida: 'codeAuthoring.mode.saida',
  estrutura: 'codeAuthoring.mode.estrutura',
};

/** Label of a Linguagem/Modo value ("C++", "saída"…); unknown values as they are. */
export function codeOptionLabel(value: string): string {
  const key = OPTION_LABEL[value];
  return key ? t(key) : value;
}

/** Linguagem (python|cpp) and Modo (testes|saida|estrutura) of "Código · Programa" as selects; any other stored
 * value stays selectable so opening a note never rewrites it. */
export function CodeSelectField({
  id,
  label,
  html,
  resetKey,
  options,
  onEdit,
  onFocus,
  invalid,
  describedBy,
}: {
  id: string;
  label: string;
  html: string;
  resetKey: string | number;
  options: readonly string[];
  onEdit: (html: string) => void;
  onFocus?: () => void;
  invalid?: boolean;
  describedBy?: string | undefined;
}) {
  const [text, setText] = useFieldText(html, resetKey);
  const value = text.trim();
  const extra = value && !options.includes(value) ? [value] : [];
  return (
    <Select
      id={id}
      aria-label={label}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      value={value}
      onFocus={onFocus}
      className="sm:max-w-60"
      onChange={(e) => {
        setText(e.target.value);
        onEdit(codeToHtml(e.target.value));
      }}
    >
      {!value && <option value="">—</option>}
      {[...options, ...extra].map((o) => (
        <option key={o} value={o}>
          {codeOptionLabel(o)}
        </option>
      ))}
    </Select>
  );
}
