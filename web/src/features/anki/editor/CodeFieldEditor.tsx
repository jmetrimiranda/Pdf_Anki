import { forwardRef, useLayoutEffect, useState } from 'react';
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
