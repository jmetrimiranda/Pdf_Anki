import { useQuery } from '@tanstack/react-query';
import { Field, Select } from '../../../components/ui';
import { t } from '../../../i18n';
import { q } from '../../../lib/core/queries';
import type { DeckName } from '../../../lib/core/types';

/** Decks a picker offers: no filtered decks, nothing in `exclude` nor under it. */
export function pickableDecks(names: DeckName[], exclude: number[] = []): DeckName[] {
  const excluded = names.filter((d) => exclude.includes(d.id)).map((d) => d.name.toLowerCase());
  return names.filter((d) => {
    if (d.filtered || exclude.includes(d.id)) return false;
    const lower = d.name.toLowerCase();
    return !excluded.some((x) => lower.startsWith(`${x}::`));
  });
}

/**
 * Deck chooser (full names, like Anki's). `value` null = "Nível superior" when `allowTopLevel`.
 * `exclude` removes those decks and their subdecks (e.g. moving a deck into itself).
 */
export function DeckPicker({
  value,
  onChange,
  exclude,
  allowTopLevel,
  label,
}: {
  value: number | null;
  onChange: (deckId: number | null) => void;
  exclude?: number[];
  allowTopLevel?: boolean;
  label: string;
}) {
  const names = useQuery(q.deckNames());
  const decks = pickableDecks(names.data ?? [], exclude);
  const current = value === null ? (allowTopLevel ? 'top' : '') : String(value);
  return (
    <Field label={label}>
      {({ id, describedBy }) => (
        <Select
          id={id}
          aria-describedby={describedBy}
          value={current}
          disabled={names.isPending}
          onChange={(e) => onChange(e.target.value === 'top' || e.target.value === '' ? null : Number(e.target.value))}
        >
          {allowTopLevel && <option value="top">{t('anki.deckPicker.topLevel')}</option>}
          {!allowTopLevel && value === null && (
            <option value="" disabled>
              {t('anki.deckPicker.choose')}
            </option>
          )}
          {decks.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}
