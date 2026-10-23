import { t } from '../i18n';

const num2 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
const num0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });

export function formatNumber(n: number, digits: 0 | 2 = 2): string {
  return (digits === 0 ? num0 : num2).format(n);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const shortDate = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' });
const clock = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

/**
 * "Sincronizado agora" (under a minute, or a clock in the future), "Sincronizado há {n} min", "Sincronizado há {n} h"
 * (under 24 h), then "Sincronizado em {data}". Whole units, rounded down.
 */
export function formatSyncedAgo(at: number, now: number): string {
  const ago = now - at;
  if (ago < MINUTE) return t('sync.syncedNow');
  if (ago < HOUR) return t('sync.syncedMinutes', { n: Math.floor(ago / MINUTE) });
  if (ago < DAY) return t('sync.syncedHours', { n: Math.floor(ago / HOUR) });
  return t('sync.syncedOn', { data: shortDate.format(new Date(at)) });
}

/** "14:05" (local time). */
export function formatClock(ms: number): string {
  return clock.format(new Date(ms));
}
