import { describe, expect, it } from 'vitest';
import { IDLE_MS, SessionWiring } from './sessions';
import { UID_A, UID_B } from './testing';

function setup() {
  const log: string[] = [];
  let now = 1_000_000;
  const s = new SessionWiring({
    start: (uid, page) => log.push(`start ${uid[0]} ${page}`),
    heartbeat: (uid, page) => log.push(`hb ${uid[0]} ${page}`),
    stop: (uid, reason) => log.push(`stop ${uid[0]} ${reason}`),
    now: () => now,
  });
  return { s, log, tick: (ms: number) => (now += ms) };
}

describe('SessionWiring', () => {
  it('starts when a book becomes active while the tab is visible', () => {
    const { s, log } = setup();
    s.setTabVisible(true);
    s.active(UID_A, 4);
    expect(log).toEqual(['start a 4']);
  });

  it('does not start while the Leitor tab is hidden; starts when it shows', () => {
    const { s, log } = setup();
    s.active(UID_A, 4);
    s.activity(UID_A, 5);
    expect(log).toEqual([]);
    s.setTabVisible(true);
    expect(log).toEqual(['start a 5']);
  });

  it('heartbeats only for the active book while visible', () => {
    const { s, log } = setup();
    s.setTabVisible(true);
    s.active(UID_A, 0);
    s.activity(UID_A, 1);
    s.activity(UID_B, 7);
    s.activity(null, 2);
    s.setPageVisible(false);
    s.activity(UID_A, 3);
    expect(log).toEqual(['start a 0', 'hb a 1', 'stop a background']);
  });

  it('stops with "tab" when leaving the Leitor and restarts on return', () => {
    const { s, log } = setup();
    s.setTabVisible(true);
    s.active(UID_A, 2);
    s.setTabVisible(false);
    s.setTabVisible(true);
    expect(log).toEqual(['start a 2', 'stop a tab', 'start a 2']);
  });

  it('stops with "doc" when another book comes to front', () => {
    const { s, log } = setup();
    s.setTabVisible(true);
    s.active(UID_A, 2);
    s.active(UID_B, 0);
    s.active(null, 0);
    expect(log).toEqual(['start a 2', 'stop a doc', 'start b 0', 'stop b doc']);
  });

  it('stops with "background" when the window is hidden and resumes when shown', () => {
    const { s, log } = setup();
    s.setTabVisible(true);
    s.active(UID_A, 1);
    s.setPageVisible(false);
    s.setPageVisible(true);
    expect(log).toEqual(['start a 1', 'stop a background', 'start a 1']);
  });

  it('stops with "close" and stays closed', () => {
    const { s, log } = setup();
    s.setTabVisible(true);
    s.active(UID_A, 1);
    s.close();
    s.activity(UID_A, 2);
    expect(log).toEqual(['start a 1', 'stop a close']);
    s.reopen();
    expect(log.at(-1)).toBe('start a 2');
  });

  it('starts a new session after the core ended the old one for inactivity', () => {
    const { s, log, tick } = setup();
    s.setTabVisible(true);
    s.active(UID_A, 1);
    tick(IDLE_MS + 1);
    s.activity(UID_A, 1);
    expect(log).toEqual(['start a 1', 'start a 1']);
    tick(30_000);
    s.activity(UID_A, 2);
    expect(log.at(-1)).toBe('hb a 2');
  });

  it('a re-sent active for the same book does not restart', () => {
    const { s, log } = setup();
    s.setTabVisible(true);
    s.active(UID_A, 1);
    s.active(UID_A, 3);
    expect(log).toEqual(['start a 1']);
  });
});
