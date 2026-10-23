import { describe, expect, it } from 'vitest';
import { formatClock, formatNumber, formatSyncedAgo } from './format';

const NOW = new Date(2026, 9, 23, 15, 30, 0).getTime();
const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;

describe('formatSyncedAgo', () => {
  it('says "agora" under a minute (and for a clock in the future)', () => {
    expect(formatSyncedAgo(NOW, NOW)).toBe('Sincronizado agora');
    expect(formatSyncedAgo(NOW - 59 * S, NOW)).toBe('Sincronizado agora');
    expect(formatSyncedAgo(NOW - 59_999, NOW)).toBe('Sincronizado agora');
    expect(formatSyncedAgo(NOW + 5 * MIN, NOW)).toBe('Sincronizado agora');
  });

  it('counts whole minutes from 1 to 59', () => {
    expect(formatSyncedAgo(NOW - MIN, NOW)).toBe('Sincronizado há 1 min');
    expect(formatSyncedAgo(NOW - 2 * MIN, NOW)).toBe('Sincronizado há 2 min');
    expect(formatSyncedAgo(NOW - (2 * MIN + 59 * S), NOW)).toBe('Sincronizado há 2 min');
    expect(formatSyncedAgo(NOW - 59 * MIN, NOW)).toBe('Sincronizado há 59 min');
    expect(formatSyncedAgo(NOW - (H - 1), NOW)).toBe('Sincronizado há 59 min');
  });

  it('counts whole hours under a day', () => {
    expect(formatSyncedAgo(NOW - H, NOW)).toBe('Sincronizado há 1 h');
    expect(formatSyncedAgo(NOW - (23 * H + 59 * MIN), NOW)).toBe('Sincronizado há 23 h');
  });

  it('shows the date from 24 h on', () => {
    expect(formatSyncedAgo(NOW - 24 * H, NOW)).toBe('Sincronizado em 22/10/2026');
    expect(formatSyncedAgo(new Date(2026, 0, 5, 9).getTime(), NOW)).toBe('Sincronizado em 05/01/2026');
  });
});

describe('formatClock', () => {
  it('formats the local time as HH:MM', () => {
    expect(formatClock(new Date(2026, 9, 23, 9, 5).getTime())).toBe('09:05');
    expect(formatClock(NOW)).toBe('15:30');
  });
});

describe('formatNumber', () => {
  it('uses pt-BR separators', () => {
    expect(formatNumber(1234.5)).toBe('1.234,5');
    expect(formatNumber(1234.5, 0)).toBe('1.235');
  });
});
