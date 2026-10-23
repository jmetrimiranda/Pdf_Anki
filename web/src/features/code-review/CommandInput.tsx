// The one-line command input of "Código · Comando" cards (spec 11.2): monospace, Enter or Ctrl+Enter verifies, ↑/↓
// browse the history (what was typed before is kept while browsing and comes back past the newest entry).
import { forwardRef, useRef, type KeyboardEvent } from 'react';
import { t } from '../../i18n';
import { historyOf } from './history';

export interface CommandInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  readOnly?: boolean;
  autoFocus?: boolean;
}

export const CommandInput = forwardRef<HTMLInputElement, CommandInputProps>(function CommandInput(
  { value, onChange, onSubmit, disabled, readOnly, autoFocus },
  ref,
) {
  // Position while browsing (null = editing the draft) and the draft itself.
  const browse = useRef<{ index: number; draft: string } | null>(null);

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      onSubmit();
      return;
    }
    if (readOnly || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    const list = historyOf('command');
    if (list.length === 0) return;
    e.preventDefault();
    const cur = browse.current;
    if (e.key === 'ArrowUp') {
      const index = cur ? Math.max(0, cur.index - 1) : list.length - 1;
      browse.current = { index, draft: cur?.draft ?? value };
      onChange(list[index]!);
    } else if (cur) {
      if (cur.index + 1 >= list.length) {
        browse.current = null;
        onChange(cur.draft);
      } else {
        browse.current = { ...cur, index: cur.index + 1 };
        onChange(list[cur.index + 1]!);
      }
    }
  }

  return (
    <input
      ref={ref}
      type="text"
      value={value}
      onChange={(e) => {
        browse.current = null;
        onChange(e.target.value);
      }}
      onKeyDown={onKeyDown}
      disabled={disabled}
      readOnly={readOnly}
      autoFocus={autoFocus}
      aria-label={t('codeReview.commandLabel')}
      placeholder={t('codeReview.commandPlaceholder')}
      aria-keyshortcuts="Enter Control+Enter ArrowUp ArrowDown"
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      autoComplete="off"
      data-testid="code-command-input"
      className="block h-9 w-full min-w-0 rounded-ctl border border-line bg-surface px-2.5 font-mono text-sm text-fg outline-none placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus read-only:text-muted disabled:opacity-60 coarse:h-11"
    />
  );
});
