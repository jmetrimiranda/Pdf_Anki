// Code editor of the code cards (spec 11.2, 11.7): CodeMirror 6, loaded on first use (dynamic import of
// ./codemirror), with `CodeEditorFallback` (a monospace textarea with the same value and keys) while it loads or
// if it fails to load.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '../../lib/cn';
import type { CodeLanguage, EditorHandle } from './codemirror';

export type { CodeLanguage } from './codemirror';

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language: CodeLanguage;
  ariaLabel: string;
  minLines?: number;
  maxLines?: number;
  autoFocus?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  /** Ctrl/Cmd+Enter. */
  onSubmit?: () => void;
  className?: string;
}

let loader: Promise<typeof import('./codemirror')> | null = null;

/** Loads CodeMirror once (also used to warm it up before a code card is shown). */
export function loadCodeMirror(): Promise<typeof import('./codemirror')> {
  loader ??= import('./codemirror').catch((e: unknown) => {
    loader = null;
    throw e;
  });
  return loader;
}

export function CodeEditor({
  value,
  onChange,
  language,
  ariaLabel,
  minLines = 6,
  maxLines = 24,
  autoFocus,
  readOnly = false,
  placeholder,
  onSubmit,
  className,
}: CodeEditorProps) {
  const root = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorHandle | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  // The latest callbacks and value (the editor is created once per language/size).
  const latest = useRef({ value, onChange, onSubmit, readOnly });
  latest.current = { value, onChange, onSubmit, readOnly };

  useEffect(() => {
    let alive = true;
    void loadCodeMirror().then(
      (cm) => {
        if (!alive || !host.current) return;
        // The fallback had the focus: the editor takes it over.
        const focusAfter = !!root.current?.contains(document.activeElement);
        editor.current = cm.createEditor(host.current, {
          value: latest.current.value,
          language,
          ariaLabel,
          minLines,
          maxLines,
          readOnly: latest.current.readOnly,
          placeholder,
          onChange: (v) => latest.current.onChange(v),
          onSubmit: () => latest.current.onSubmit?.(),
        });
        setState('ready');
        if (autoFocus || focusAfter) editor.current.focus();
      },
      () => {
        if (alive) setState('failed');
      },
    );
    return () => {
      alive = false;
      editor.current?.destroy();
      editor.current = null;
    };
    // The editor is rebuilt only when its shape changes; value/readOnly follow below.
  }, [language, ariaLabel, minLines, maxLines, placeholder]);

  useEffect(() => {
    editor.current?.setValue(value);
  }, [value]);

  useEffect(() => {
    editor.current?.setReadOnly(readOnly);
  }, [readOnly]);

  return (
    <div
      ref={root}
      className={cn('min-w-0', className)}
      data-testid="code-editor"
      data-language={language}
      data-state={state}
    >
      {state !== 'ready' && (
        <CodeEditorFallback
          value={value}
          onChange={onChange}
          ariaLabel={ariaLabel}
          minLines={minLines}
          maxLines={maxLines}
          autoFocus={autoFocus}
          readOnly={readOnly}
          placeholder={placeholder}
          onSubmit={onSubmit}
          tabSize={language === 'cpp' ? 2 : 4}
        />
      )}
      <div ref={host} className={state === 'ready' ? undefined : 'hidden'} />
    </div>
  );
}

/** Monospace textarea stand-in (while CodeMirror loads, or when it cannot load). */
export function CodeEditorFallback({
  value,
  onChange,
  ariaLabel,
  minLines = 6,
  maxLines = 24,
  autoFocus,
  readOnly,
  placeholder,
  onSubmit,
  tabSize = 4,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  minLines?: number;
  maxLines?: number;
  autoFocus?: boolean | undefined;
  readOnly?: boolean | undefined;
  placeholder?: string | undefined;
  onSubmit?: (() => void) | undefined;
  tabSize?: number;
}) {
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onSubmit?.();
      return;
    }
    if (e.key === 'Tab' && !e.shiftKey && !readOnly) {
      // Indent with spaces, like the editor.
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: s, selectionEnd: end } = el;
      const spaces = ' '.repeat(tabSize);
      onChange(value.slice(0, s) + spaces + value.slice(end));
      requestAnimationFrame(() => el.setSelectionRange(s + spaces.length, s + spaces.length));
    }
  }
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      aria-label={ariaLabel}
      readOnly={readOnly}
      autoFocus={autoFocus}
      placeholder={placeholder}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      data-testid="code-editor-fallback"
      rows={minLines}
      style={{ maxHeight: `calc(${maxLines * 1.5}em + 12px)`, tabSize }}
      className="block w-full resize-y rounded-ctl border border-line bg-surface px-2.5 py-1.5 font-mono text-sm leading-normal text-fg outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
    />
  );
}
