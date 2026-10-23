// CodeMirror 6 setup of CodeEditor (spec 11.2). Loaded with a dynamic import, so screens without code don't pay for
// it. Theme from the design tokens (tokens.css variables: follows light/dark without a reconfigure), monospace, no
// heavy borders or shadows.
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { cpp } from '@codemirror/lang-cpp';
import { python } from '@codemirror/lang-python';
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  StreamLanguage,
  syntaxHighlighting,
} from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, keymap, lineNumbers, placeholder } from '@codemirror/view';
import { tags } from '@lezer/highlight';

export type CodeLanguage = 'python' | 'cpp' | 'shell' | 'text';

export interface EditorOptions {
  value: string;
  language: CodeLanguage;
  ariaLabel: string;
  minLines: number;
  maxLines: number;
  readOnly: boolean;
  placeholder?: string | undefined;
  onChange: (value: string) => void;
  onSubmit: () => void;
}

export interface EditorHandle {
  setValue(value: string): void;
  setReadOnly(readOnly: boolean): void;
  focus(): void;
  destroy(): void;
  readonly view: EditorView;
}

function languageOf(language: CodeLanguage): Extension {
  switch (language) {
    case 'python':
      return python();
    case 'cpp':
      return cpp();
    case 'shell':
      return StreamLanguage.define(shell);
    default:
      return [];
  }
}

const LINE_HEIGHT_EM = 1.5;

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.definitionKeyword], color: 'var(--link)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--anki-review)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--vocab-learning)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--muted)', fontStyle: 'italic' },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.definition(tags.variableName))],
    color: 'var(--text)',
    fontWeight: '600',
  },
  { tag: [tags.typeName, tags.className], color: 'var(--lime-dark)' },
  { tag: [tags.processingInstruction, tags.meta], color: 'var(--anki-learn)' },
]);

function theme(minLines: number, maxLines: number): Extension {
  return EditorView.theme({
    '&': {
      color: 'var(--text)',
      backgroundColor: 'var(--surface-2)',
      borderRadius: 'var(--radius-control)',
      border: '1px solid var(--border)',
      fontSize: '13px',
    },
    '&.cm-focused': { outline: '2px solid var(--focus)', outlineOffset: '1px' },
    '.cm-scroller': {
      fontFamily: 'var(--font-mono)',
      lineHeight: String(LINE_HEIGHT_EM),
      minHeight: `calc(${minLines * LINE_HEIGHT_EM}em + 12px)`,
      maxHeight: `calc(${maxLines * LINE_HEIGHT_EM}em + 12px)`,
      overflow: 'auto',
    },
    '.cm-content': { padding: '6px 0', caretColor: 'var(--text)' },
    '.cm-line': { padding: '0 10px' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--muted)',
      border: 'none',
      borderRight: '1px solid var(--border)',
    },
    '.cm-activeLine': { backgroundColor: 'var(--hover)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
    '.cm-cursor': { borderLeftColor: 'var(--text)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'color-mix(in srgb, var(--link) 25%, transparent) !important',
    },
    '.cm-matchingBracket': { backgroundColor: 'var(--active)', outline: 'none' },
    '.cm-placeholder': { color: 'var(--muted)' },
  });
}

export function createEditor(parent: HTMLElement, opts: EditorOptions): EditorHandle {
  const readOnly = new Compartment();
  const editable = (ro: boolean) => [EditorState.readOnly.of(ro), EditorView.editable.of(!ro)];
  const tabSize = opts.language === 'cpp' ? 2 : 4;
  let silent = false;
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.value,
      extensions: [
        // Ctrl/Cmd+Enter verifies, before any other binding.
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-Enter',
              run: () => {
                opts.onSubmit();
                return true;
              },
            },
          ]),
        ),
        lineNumbers(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        indentOnInput(),
        bracketMatching(),
        EditorState.tabSize.of(tabSize),
        indentUnit.of(' '.repeat(tabSize)),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        languageOf(opts.language),
        syntaxHighlighting(highlight),
        theme(opts.minLines, opts.maxLines),
        EditorView.contentAttributes.of({
          'aria-label': opts.ariaLabel,
          'aria-multiline': 'true',
          spellcheck: 'false',
          autocorrect: 'off',
          autocapitalize: 'off',
          'data-testid': 'code-editor-content',
        }),
        opts.placeholder ? placeholder(opts.placeholder) : [],
        readOnly.of(editable(opts.readOnly)),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !silent) opts.onChange(u.state.doc.toString());
        }),
      ],
    }),
  });
  return {
    view,
    setValue(value) {
      if (value === view.state.doc.toString()) return;
      silent = true;
      try {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
      } finally {
        silent = false;
      }
    },
    setReadOnly(ro) {
      view.dispatch({ effects: readOnly.reconfigure(editable(ro)) });
    },
    focus() {
      view.focus();
    },
    destroy() {
      view.destroy();
    },
  };
}
