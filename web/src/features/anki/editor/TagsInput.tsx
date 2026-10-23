import { X } from 'lucide-react';
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { t } from '../../../i18n';
import { cn } from '../../../lib/cn';

/** Splits typed text into tags (Anki tags have no spaces). */
export function splitTags(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** Adds tags, skipping ones already there (case-insensitive, like Anki). */
export function addTags(current: readonly string[], added: readonly string[]): string[] {
  const out = [...current];
  for (const tag of added) if (!out.some((x) => x.toLowerCase() === tag.toLowerCase())) out.push(tag);
  return out;
}

/** Up to `max` known tags starting with (then containing) `text`, excluding the ones already chosen. */
export function tagSuggestions(all: readonly string[], text: string, chosen: readonly string[], max = 8): string[] {
  const q = text.trim().toLowerCase();
  if (!q) return [];
  const taken = new Set(chosen.map((x) => x.toLowerCase()));
  const free = all.filter((x) => !taken.has(x.toLowerCase()));
  const starts = free.filter((x) => x.toLowerCase().startsWith(q));
  const contains = free.filter((x) => !x.toLowerCase().startsWith(q) && x.toLowerCase().includes(q));
  return [...starts, ...contains].slice(0, max);
}

/**
 * Tag chips with autocomplete: Space/Enter/Tab turn the text into a tag, Backspace on an empty input removes the last
 * one, arrows pick a suggestion.
 */
export function TagsInput({
  value,
  onChange,
  suggestions,
  label,
  id: idProp,
  className,
}: {
  value: readonly string[];
  onChange: (tags: string[]) => void;
  suggestions: readonly string[];
  label: string;
  id?: string;
  className?: string;
}) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const listId = `${id}-list`;
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const options = useMemo(() => tagSuggestions(suggestions, text, value), [suggestions, text, value]);
  const open = focused && options.length > 0;

  const commit = (raw: string) => {
    const tags = splitTags(raw);
    if (tags.length) onChange(addTags(value, tags));
    setText('');
    setActive(0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
      return;
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      // Ctrl+Enter saves the note: take the half-typed tag along.
      commit(text);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ' || (e.key === 'Tab' && text.trim())) {
      if (!text.trim() && e.key !== 'Enter') return;
      e.preventDefault();
      commit(open && e.key !== ' ' ? options[active]! : text);
      return;
    }
    if (e.key === 'Escape' && text) {
      e.preventDefault();
      e.stopPropagation();
      setText('');
      return;
    }
    if (e.key === 'Backspace' && !text && value.length) {
      e.preventDefault();
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div className={cn('relative', className)}>
      <div
        className={cn(
          'flex min-h-8 w-full flex-wrap items-center gap-1 rounded-ctl border border-line bg-card px-1.5 py-1 transition-colors coarse:min-h-11',
          'hover:border-[color-mix(in_srgb,var(--text)_25%,var(--border))] focus-within:border-lime',
        )}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            input.current?.focus();
          }
        }}
      >
        {value.map((tag, i) => (
          <span
            key={`${tag}-${i}`}
            className="inline-flex h-6 max-w-full items-center gap-0.5 rounded-[5px] bg-neutral pr-0.5 pl-2 text-sm text-fg"
          >
            <span className="truncate">{tag}</span>
            <button
              type="button"
              aria-label={t('anki.editor.removeTag', { tag })}
              onClick={() => onChange(value.filter((_, k) => k !== i))}
              className="inline-flex size-5 items-center justify-center rounded-[4px] text-muted hover:bg-hover hover:text-fg"
            >
              <X size={12} aria-hidden />
            </button>
          </span>
        ))}
        <input
          ref={input}
          id={id}
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open ? `${listId}-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          value={text}
          placeholder={value.length ? '' : t('anki.editor.tagsPlaceholder')}
          onChange={(e) => {
            const v = e.target.value;
            // Pasting "a b c" turns the complete words into tags.
            if (/\s/.test(v.trimStart()) && /\S\s/.test(v)) {
              const parts = v.split(/\s+/);
              const rest = /\s$/.test(v) ? '' : (parts.pop() ?? '');
              onChange(addTags(value, parts.filter(Boolean)));
              setText(rest);
            } else setText(v.trimStart());
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            if (text.trim()) commit(text);
          }}
          className="h-6 min-w-24 flex-1 bg-transparent px-1 text-base text-fg outline-none placeholder:text-muted"
        />
      </div>
      <ul
        id={listId}
        role="listbox"
        aria-label={t('anki.editor.tagSuggestions')}
        hidden={!open}
        className="absolute inset-x-0 top-full z-30 mt-1 max-h-56 overflow-auto rounded-box border border-line bg-card p-1 shadow-popover"
      >
        {options.map((tag, i) => (
          <li
            key={tag}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === active}
            onMouseDown={(e) => {
              e.preventDefault();
              commit(tag);
            }}
            onMouseEnter={() => setActive(i)}
            className={cn(
              'flex h-7 cursor-default items-center rounded-[5px] px-2 text-base',
              i === active && 'bg-hover',
            )}
          >
            {tag}
          </li>
        ))}
      </ul>
    </div>
  );
}
