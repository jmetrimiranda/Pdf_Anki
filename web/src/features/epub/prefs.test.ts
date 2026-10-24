import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clampFont,
  contrast,
  getPrefs,
  parsePrefs,
  PREFS_KEY,
  readerCss,
  resetPrefsCache,
  setPrefs,
  THEME_COLORS,
} from './prefs';

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  resetPrefsCache();
});
afterEach(() => localStorage.clear());

describe('EPUB reading prefs', () => {
  it('defaults to the app theme, 100 % and normal spacing', () => {
    expect(getPrefs()).toEqual({ theme: 'light', fontSize: 100, lineHeight: 'normal' });
    document.documentElement.dataset.theme = 'dark';
    resetPrefsCache();
    expect(getPrefs().theme).toBe('dark');
  });

  it('persists in localStorage leitor.epub.prefs and survives a reload', () => {
    setPrefs({ theme: 'sepia', fontSize: 130 });
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toEqual({
      theme: 'sepia',
      fontSize: 130,
      lineHeight: 'normal',
    });
    resetPrefsCache();
    expect(getPrefs()).toEqual({ theme: 'sepia', fontSize: 130, lineHeight: 'normal' });
  });

  it('keeps the letter size within 80–200 % in 10 % steps', () => {
    expect(clampFont(75)).toBe(80);
    expect(clampFont(203)).toBe(200);
    expect(clampFont(114)).toBe(110);
    expect(setPrefs({ fontSize: 250 }).fontSize).toBe(200);
  });

  it('ignores corrupt or partial storage', () => {
    expect(parsePrefs('{not json')).toEqual({ theme: 'light', fontSize: 100, lineHeight: 'normal' });
    expect(parsePrefs('{"theme":"neon","fontSize":"big","lineHeight":"relaxed"}')).toEqual({
      theme: 'light',
      fontSize: 100,
      lineHeight: 'relaxed',
    });
  });

  it('turns the prefs into the section CSS with the theme colours of the spec', () => {
    expect(THEME_COLORS.light).toMatchObject({ bg: '#ffffff', fg: '#1f1f1f' });
    expect(THEME_COLORS.sepia).toMatchObject({ bg: '#f4ecd8', fg: '#5b4636' });
    expect(THEME_COLORS.dark).toMatchObject({ bg: '#1e1e1e', fg: '#d6d6d6' });
    const css = readerCss({ theme: 'sepia', fontSize: 120, lineHeight: 'relaxed' });
    expect(css).toContain('background: #f4ecd8 !important');
    expect(css).toContain('font-size: 120% !important');
    expect(css).toContain('line-height: 1.8 !important');
    expect(readerCss({ theme: 'dark', fontSize: 100, lineHeight: 'normal' })).toContain('color-scheme: dark');
  });

  it('measures contrast (links keep their colour unless unreadable)', () => {
    expect(contrast('rgb(0, 0, 0)', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrast('rgb(0, 0, 238)', '#1e1e1e')).toBeLessThan(3);
    expect(contrast('rgb(138, 180, 248)', '#1e1e1e')).toBeGreaterThan(3);
  });
});
