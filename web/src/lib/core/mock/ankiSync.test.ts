import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient, mockHandle } from '../mock';
import type { AnkiChanged, AnkiSyncStatus } from '../types';
import { checkFullSync, normalizeSyncUrl } from './ankiSync';

const PEM = `-----BEGIN CERTIFICATE-----
MIIBszCCAVmgAwIBAgIUQ2VydGlmaWNhZG8gZGUgdGVzdGUwCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMbGVpdG9yLWRldi1jYTAeFw0yNjEwMjMwMDAwMDBaFw0zNjEw
-----END CERTIFICATE-----
`;

/** Lets the pretend sync (timers at 0 ms in tests) run to the end. */
const settle = () => new Promise((r) => setTimeout(r, 5));

async function login(): Promise<AnkiSyncStatus> {
  const s = await mockClient.ankiSyncLogin('http://ankisync:8080', 'test', 'test', null);
  await settle();
  return s;
}

beforeEach(() => mockHandle.reset());

describe('mock Anki sync', () => {
  it('starts off, with nothing set', async () => {
    const s = await mockClient.ankiSyncStatus();
    expect(s).toMatchObject({ state: 'off', loggedIn: false, url: null, user: null, lastSyncAt: null });
    await expect(mockClient.ankiSync()).rejects.toMatchObject({ code: 'anki_sync_not_logged_in' });
  });

  it('validates the URL and refuses AnkiWeb', async () => {
    expect(normalizeSyncUrl(' https://anki.example.org ')).toBe('https://anki.example.org/');
    expect(normalizeSyncUrl('http://ankisync:8080/sync')).toBe('http://ankisync:8080/sync/');
    for (const url of ['https://ankiweb.net/', 'https://sync.ankiweb.net', 'https://SYNC2.AnkiWeb.net./']) {
      await expect(mockClient.ankiSyncLogin(url, 'test', 'test', null)).rejects.toMatchObject({
        code: 'anki_sync_anki_web_refused',
      });
    }
    for (const url of ['', 'anki.example.org', 'ftp://anki.example.org/', 'javascript:alert(1)']) {
      await expect(mockClient.ankiSyncLogin(url, 'test', 'test', null)).rejects.toMatchObject({
        code: 'anki_sync_invalid_url',
      });
    }
    expect((await mockClient.ankiSyncStatus()).loggedIn).toBe(false);
  });

  it('refuses a wrong password and a certificate that is not one PEM', async () => {
    await expect(mockClient.ankiSyncLogin('http://ankisync:8080/', 'test', 'x', null)).rejects.toMatchObject({
      code: 'anki_sync_auth_failed',
      message: 'Usuário ou senha incorretos, ou a sessão expirou. Entre de novo.',
    });
    await expect(
      mockClient.ankiSyncLogin('http://ankisync:8080/', 'test', 'test', 'not a certificate'),
    ).rejects.toMatchObject({ code: 'anki_sync_invalid_certificate' });
    await expect(mockClient.ankiSyncSetCertificate(PEM + PEM)).rejects.toMatchObject({
      code: 'anki_sync_invalid_certificate',
    });
  });

  it('logs in, then the first sync downloads with a backup before', async () => {
    const statuses: AnkiSyncStatus[] = [];
    const changes: AnkiChanged[] = [];
    const off1 = mockClient.onAnkiSync((s) => statuses.push(s));
    const off2 = mockClient.onAnkiChanged((e) => changes.push(e));
    const s = await mockClient.ankiSyncLogin('http://ankisync:8080', ' test ', 'test', PEM);
    expect(s).toMatchObject({ state: 'syncing', loggedIn: true, user: 'test', url: 'http://ankisync:8080/' });
    expect(s.firstSyncPending).toBe(true);
    expect(s.certificateFingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    await settle();
    off1();
    off2();
    const done = await mockClient.ankiSyncStatus();
    expect(done).toMatchObject({ state: 'idle', firstSyncPending: false, lastError: null });
    expect(done.lastSyncAt).toBeGreaterThan(Date.now() - 5000);
    expect(statuses.at(-1)?.state).toBe('idle');
    expect(changes).toEqual([{ reason: 'syncFull' }]);
    expect(mockHandle.anki.backups.filter((b) => b.kind === 'preSync')).toHaveLength(1);
    // The status never carries the password.
    expect(Object.keys(done)).not.toContain('password');
  });

  it('syncs normally, goes offline and comes back when the network returns', async () => {
    await login();
    const changes: AnkiChanged[] = [];
    const off = mockClient.onAnkiChanged((e) => changes.push(e));
    expect((await mockClient.ankiSync()).state).toBe('idle');
    expect(changes).toEqual([{ reason: 'sync' }]);

    mockHandle.syncSetOffline(true);
    const offline = mockHandle.syncStatus();
    expect(offline.state).toBe('offline');
    expect(offline.lastError?.code).toBe('anki_sync_offline');
    expect(offline.nextRetryAt).toBeGreaterThan(Date.now());
    expect((await mockClient.ankiSync()).state).toBe('offline');

    // Still offline: "online" from the window is not enough.
    await mockClient.ankiSyncNotify('online');
    await settle();
    expect(mockHandle.syncStatus().state).toBe('offline');

    mockHandle.syncSetOffline(false);
    await mockClient.ankiSyncNotify('online');
    await settle();
    expect(mockHandle.syncStatus()).toMatchObject({ state: 'idle', lastError: null, nextRetryAt: null });
    expect(mockHandle.syncNotifications).toEqual(['online', 'online']);
    off();
  });

  it('syncs on entering the Anki tab only after 2 minutes', async () => {
    await login();
    const spy = vi.fn();
    const off = mockClient.onAnkiChanged(spy);
    await mockClient.ankiSyncNotify('tabEntered');
    await settle();
    expect(spy).not.toHaveBeenCalled();
    mockHandle.syncSetLastSyncAt(Date.now() - 3 * 60_000);
    await mockClient.ankiSyncNotify('tabEntered');
    await settle();
    expect(spy).toHaveBeenCalledWith({ reason: 'sync' });
    off();
  });

  it('asks for a full sync and never decides alone; both directions back up first', async () => {
    await login();
    mockHandle.syncRequireFull({ uploadOk: false, downloadOk: true });
    expect(mockHandle.syncStatus()).toMatchObject({
      state: 'fullSyncRequired',
      fullSync: { uploadOk: false, downloadOk: true },
    });
    // A normal sync does not get out of it, nor do the scheduler's notifications.
    expect((await mockClient.ankiSync()).state).toBe('fullSyncRequired');
    await mockClient.ankiSyncNotify('visible');
    expect(mockHandle.syncStatus().state).toBe('fullSyncRequired');
    await expect(mockClient.ankiSyncFull('upload')).rejects.toMatchObject({ code: 'anki_sync_upload_not_allowed' });

    const before = mockHandle.anki.backups.length;
    const result = await mockClient.ankiSyncFull('download');
    expect(result.backup.kind).toBe('preSync');
    expect(result.backup.fileName).toMatch(/^backup-antes-da-sincronizacao-.*\.colpkg$/);
    expect(result.status).toMatchObject({ state: 'idle', fullSync: null });
    expect(mockHandle.anki.backups).toHaveLength(before + 1);
    expect((await mockClient.ankiBackups())[0]?.kind).toBe('preSync');

    mockHandle.syncRequireFull({ uploadOk: true, downloadOk: false });
    await expect(mockClient.ankiSyncFull('download')).rejects.toMatchObject({
      code: 'anki_sync_download_not_allowed',
    });
    expect((await mockClient.ankiSyncFull('upload')).backup.kind).toBe('preSync');
  });

  it('refuses a full sync the server did not ask for (same rule as the core)', async () => {
    await mockClient.ankiSyncLogin('http://ankisync:8080', 'test', 'test', null);
    // Before the first sync: a download may run, an upload never.
    expect(mockHandle.syncStatus().firstSyncPending).toBe(true);
    expect(() => checkFullSync('download', null, true)).not.toThrow();
    await expect(mockClient.ankiSyncFull('upload')).rejects.toMatchObject({ code: 'anki_sync_full_not_required' });
    expect(() => checkFullSync('upload', { uploadOk: true, downloadOk: true }, true)).toThrow(
      expect.objectContaining({ code: 'anki_sync_upload_not_allowed' }),
    );
    expect(() => checkFullSync('upload', { uploadOk: true, downloadOk: false }, true)).not.toThrow();
    await settle();
    const before = mockHandle.anki.backups.length;
    for (const direction of ['download', 'upload'] as const) {
      await expect(mockClient.ankiSyncFull(direction)).rejects.toMatchObject({ code: 'anki_sync_full_not_required' });
    }
    expect(mockHandle.anki.backups).toHaveLength(before);
    expect(mockHandle.syncStatus().state).toBe('idle');
  });

  it('makes the next sync a first sync after a .colpkg import', async () => {
    await login();
    mockHandle.syncRequireFull({ uploadOk: true, downloadOk: true });
    expect(mockHandle.syncStatus()).toMatchObject({ state: 'fullSyncRequired', firstSyncPending: false });
    await mockClient.ankiImportColpkg('/tmp/colecao.colpkg');
    expect(mockHandle.syncStatus()).toMatchObject({ state: 'idle', fullSync: null, firstSyncPending: true });
    await expect(mockClient.ankiSyncFull('upload')).rejects.toMatchObject({ code: 'anki_sync_full_not_required' });
  });

  it('keeps 5 pre-sync backups', async () => {
    await login();
    for (let i = 0; i < 7; i++) {
      mockHandle.syncRequireFull({ uploadOk: true, downloadOk: true });
      await mockClient.ankiSyncFull('download');
    }
    expect(mockHandle.anki.backups.filter((b) => b.kind === 'preSync').length).toBeLessThanOrEqual(5);
  });

  it('sets and removes the certificate; logout keeps the address', async () => {
    const withCert = await mockClient.ankiSyncSetCertificate(PEM);
    expect(withCert.certificateFingerprint).toBeTruthy();
    expect((await mockClient.ankiSyncSetCertificate(null)).certificateFingerprint).toBeNull();
    await login();
    const out = await mockClient.ankiSyncLogout();
    expect(out).toMatchObject({ state: 'off', loggedIn: false, url: 'http://ankisync:8080/', user: 'test' });
  });
});
