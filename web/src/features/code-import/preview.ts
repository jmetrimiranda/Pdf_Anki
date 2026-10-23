// Display helpers of the Markdown import preview (spec 11.7).
import { t } from '../../i18n';
import type { ImportItem } from '../../lib/core/types';

const LANGUAGE_LABEL: Record<string, string> = { python: 'Python', cpp: 'C++' };

/** "Comando", "Programa · Python · testes"… */
export function itemBadge(item: Pick<ImportItem, 'kind' | 'language' | 'mode'>): string {
  if (item.kind === 'command') return t('codeImport.kind.command');
  if (item.kind === 'program') {
    const parts = [t('codeImport.kind.program')];
    if (item.language) parts.push(LANGUAGE_LABEL[item.language] ?? item.language);
    if (item.mode) parts.push(item.mode === 'saida' ? t('codeAuthoring.mode.saida') : item.mode);
    return parts.join(' · ');
  }
  return t('codeImport.kind.unknown');
}

/** The first `lines` lines of the Resposta (an ellipsis line when there is more). */
export function itemExcerpt(item: Pick<ImportItem, 'fields'>, lines = 3): string {
  const answer = (item.fields.Resposta ?? '').replace(/\s+$/, '');
  if (!answer) return '';
  const all = answer.split('\n');
  return all.length > lines ? [...all.slice(0, lines), '…'].join('\n') : answer;
}

/** Anki search for a deck by full name (`deck:"Name"`, quotes and backslashes escaped). */
export function deckSearch(name: string): string {
  return `deck:"${name.replace(/(["\\])/g, '\\$1')}"`;
}
