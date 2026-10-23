import { Check, ChevronDown, Search } from 'lucide-react';
import { Popover as P } from 'radix-ui';
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { popoverSurface } from '../../../components/ui';
import { usePortalContainer } from '../../../components/ui/portal';
import { t } from '../../../i18n';
import { cn } from '../../../lib/cn';
import type { NotetypeInfo } from '../../../lib/core/types';

interface Group {
  label: string;
  items: NotetypeInfo[];
}

/** App types first ("Do Leitor"), then the collection's own types, filtered by `query`. */
export function notetypeGroups(all: readonly NotetypeInfo[], query: string): Group[] {
  const q = query.trim().toLowerCase();
  const match = all.filter((nt) => !q || nt.name.toLowerCase().includes(q));
  const app = match.filter((nt) => nt.appType);
  const own = match.filter((nt) => !nt.appType);
  return [
    { label: t('anki.editor.notetypeGroupApp'), items: app },
    { label: t('anki.editor.notetypeGroupOther'), items: own },
  ].filter((g) => g.items.length > 0);
}

/** Notetype chooser with search (spec 8.2 Adicionar). */
export function NotetypePicker({
  notetypes,
  value,
  onChange,
  label,
  disabled,
}: {
  notetypes: readonly NotetypeInfo[];
  value: number | null;
  onChange: (id: number) => void;
  label: string;
  disabled?: boolean;
}) {
  const container = usePortalContainer();
  const labelId = useId();
  const listId = useId();
  const valueId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const groups = useMemo(() => notetypeGroups(notetypes, query), [notetypes, query]);
  const flat = groups.flatMap((g) => g.items);
  const current = notetypes.find((nt) => nt.id === value);
  const search = useRef<HTMLInputElement>(null);

  const choose = (nt: NotetypeInfo | undefined) => {
    if (!nt) return;
    onChange(nt.id);
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!flat.length) return;
      setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(flat[active]);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span id={labelId} className="text-xs text-muted">
        {label}
      </span>
      <P.Root
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (o) {
            setQuery('');
            setActive(
              Math.max(
                0,
                notetypeGroups(notetypes, '')
                  .flatMap((g) => g.items)
                  .findIndex((nt) => nt.id === value),
              ),
            );
          }
        }}
      >
        <P.Trigger asChild disabled={disabled}>
          <button
            type="button"
            aria-labelledby={`${labelId} ${valueId}`}
            aria-haspopup="listbox"
            className={cn(
              'flex h-8 w-full min-w-0 items-center gap-2 rounded-ctl border border-line bg-card pr-2 pl-2.5 text-left text-base text-fg transition-colors coarse:h-11',
              'hover:border-[color-mix(in_srgb,var(--text)_25%,var(--border))] disabled:opacity-50',
            )}
          >
            <span id={valueId} className="min-w-0 flex-1 truncate">
              {current?.name ?? t('anki.editor.chooseNotetype')}
            </span>
            <ChevronDown size={15} aria-hidden className="shrink-0 text-muted" />
          </button>
        </P.Trigger>
        <P.Portal container={container}>
          <P.Content
            align="start"
            sideOffset={6}
            collisionPadding={8}
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              search.current?.focus();
            }}
            className={cn(popoverSurface, 'w-[min(320px,calc(100vw-24px))] p-1.5')}
          >
            <div className="relative mb-1">
              <Search
                size={14}
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted"
              />
              <input
                ref={search}
                role="combobox"
                aria-label={t('anki.editor.searchNotetype')}
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={flat[active] ? `${listId}-${flat[active].id}` : undefined}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onKeyDown}
                placeholder={t('anki.editor.searchNotetype')}
                className="h-8 w-full rounded-ctl border border-line bg-card pr-2.5 pl-8 text-base text-fg outline-none placeholder:text-muted focus-visible:border-lime"
              />
            </div>
            <div id={listId} role="listbox" aria-label={label} className="max-h-72 overflow-auto">
              {groups.length === 0 && <p className="px-2 py-2 text-base text-muted">{t('anki.editor.noNotetype')}</p>}
              {groups.map((g) => (
                <div key={g.label} role="group" aria-label={g.label}>
                  <div className="px-2 pt-1.5 pb-1 text-2xs font-semibold tracking-wide text-muted uppercase">
                    {g.label}
                  </div>
                  {g.items.map((nt) => {
                    const i = flat.indexOf(nt);
                    return (
                      <div
                        key={nt.id}
                        id={`${listId}-${nt.id}`}
                        role="option"
                        aria-label={nt.name}
                        aria-selected={nt.id === value}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => choose(nt)}
                        onMouseEnter={() => setActive(i)}
                        className={cn(
                          'flex h-8 cursor-default items-center gap-2 rounded-[5px] px-2 text-base coarse:h-11',
                          i === active && 'bg-hover',
                        )}
                      >
                        <span className="flex size-4 shrink-0 items-center justify-center">
                          {nt.id === value && <Check size={14} aria-hidden className="text-lime-dark" />}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{nt.name}</span>
                        <span className="shrink-0 text-xs text-muted tabular-nums">
                          {t('anki.editor.fieldCount', { n: nt.fields.length })}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </P.Content>
        </P.Portal>
      </P.Root>
    </div>
  );
}
