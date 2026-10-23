import { describe, expect, it } from 'vitest';
import type { CoreClient } from '../../lib/core/client';
import { leitorCore } from './instance';
import { UID_A, UID_B } from './testing';

describe('leitorCore', () => {
  it('sends session commands to the core in order, even when a call is slow or fails', async () => {
    const seen: string[] = [];
    const pending: Array<() => void> = [];
    const slow = (name: string, fail = false) =>
      new Promise<void>((resolve, reject) => {
        seen.push(`${name}:begin`);
        pending.push(() => {
          seen.push(`${name}:end`);
          if (fail) reject(new Error('x'));
          else resolve();
        });
      });
    const client = {
      readingSessionStart: (uid: string) => slow(`start ${uid.slice(0, 1)}`),
      readingSessionHeartbeat: (uid: string) => slow(`heartbeat ${uid.slice(0, 1)}`, true),
      readingSessionStop: (uid: string | null, reason: string) => slow(`stop ${uid?.slice(0, 1)} ${reason}`),
    } as unknown as CoreClient;
    const lc = leitorCore(client);

    const calls = [
      lc.sessionStart(UID_A, 0),
      lc.sessionHeartbeat(UID_A, 1).catch(() => 'failed'),
      lc.sessionStop(UID_A, 'doc'),
      lc.sessionStart(UID_B, 0),
    ];
    for (let i = 0; i < 4; i++) {
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
      expect(pending).toHaveLength(1);
      pending.shift()?.();
    }
    const results = await Promise.all(calls);
    expect(results[1]).toBe('failed');
    expect(seen).toEqual([
      'start a:begin',
      'start a:end',
      'heartbeat a:begin',
      'heartbeat a:end',
      'stop a doc:begin',
      'stop a doc:end',
      'start b:begin',
      'start b:end',
    ]);
  });
});
