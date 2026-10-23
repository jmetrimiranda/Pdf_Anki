// Mock of the Anki sync commands (spec 9): login against a pretend server (user `test`, password `test`), normal and
// full syncs, the offline state and the scheduler notifications. Persisted in sessionStorage ('leitor.mock.sync').
// The e2e tests drive the network and the server through the mock handle (`syncSetOffline`, `syncRequireFull`…).
import {
  CoreError,
  type AnkiSyncStatus,
  type CoreClient,
  type FullSyncChoice,
  type FullSyncDirection,
  type FullSyncResult,
  type SyncErrorInfo,
  type SyncNotifyEvent,
  type SyncState,
} from '../types';
import { emitAnkiChanged, later, listenTo, logAnki, mockLatency, type AnkiSyncMockKeys } from './ankiData';
import { pushBackup } from './ankiDecks';

const MIN = 60_000;
/** The core's retry delay after a failed attempt (shown as "Tentando de novo às …"). */
export const MOCK_RETRY_MS = MIN;

export interface SyncMockState {
  url: string | null;
  user: string | null;
  loggedIn: boolean;
  certificateFingerprint: string | null;
  firstSyncPending: boolean;
  lastSyncAt: number | null;
  state: SyncState;
  lastError: SyncErrorInfo | null;
  fullSync: FullSyncChoice | null;
  nextRetryAt: number | null;
  mediaError: string | null;
  serverMessage: string | null;
  /** Test switch: the network is down. */
  offline: boolean;
  /** Test switch: the server answers the next sync with "full sync required". */
  pendingFull: FullSyncChoice | null;
  /** Every `ankiSyncNotify` call, in order. */
  notifications: SyncNotifyEvent[];
}

// ---------------------------------------------------------------- errors (same codes and texts as the core)

export const syncErrors = {
  invalidUrl: () =>
    new CoreError('anki_sync_invalid_url', 'Endereço do servidor inválido. Use algo como https://anki.seu-dominio/.'),
  ankiWebRefused: () =>
    new CoreError('anki_sync_anki_web_refused', 'Este app não sincroniza com o AnkiWeb. Use o seu servidor próprio.'),
  authFailed: () =>
    new CoreError('anki_sync_auth_failed', 'Usuário ou senha incorretos, ou a sessão expirou. Entre de novo.'),
  invalidCertificate: () =>
    new CoreError('anki_sync_invalid_certificate', 'O arquivo não contém exatamente um certificado PEM válido.'),
  notLoggedIn: () =>
    new CoreError(
      'anki_sync_not_logged_in',
      'Entre no servidor de sincronização em Configurações → Anki e sincronização.',
    ),
  offline: () => new CoreError('anki_sync_offline', 'Sem conexão com o servidor de sincronização.'),
  uploadNotAllowed: () =>
    new CoreError('anki_sync_upload_not_allowed', 'A coleção deste aparelho está vazia: não há o que enviar.'),
  firstSyncUpload: () =>
    new CoreError(
      'anki_sync_upload_not_allowed',
      'Na primeira sincronização deste aparelho, a coleção vem do servidor.',
    ),
  downloadNotAllowed: () =>
    new CoreError('anki_sync_download_not_allowed', 'O servidor ainda não tem uma coleção para baixar.'),
  fullNotRequired: () =>
    new CoreError(
      'anki_sync_full_not_required',
      'A sincronização completa não é necessária agora. Use “Sincronizar agora”.',
    ),
};

/**
 * Same rule as the core's `check_full_sync_allowed`: a full sync only while the last sync asked for one, in a
 * direction the server allowed; the first sync of an account may always download and uploads only to an empty server.
 */
export function checkFullSync(
  direction: FullSyncDirection,
  required: FullSyncChoice | null,
  firstSyncPending: boolean,
): void {
  if (required === null) {
    if (direction === 'download' && firstSyncPending) return;
    throw syncErrors.fullNotRequired();
  }
  if (direction === 'upload') {
    if (firstSyncPending && required.downloadOk) throw syncErrors.firstSyncUpload();
    if (!required.uploadOk) throw syncErrors.uploadNotAllowed();
  } else if (!required.downloadOk) {
    throw syncErrors.downloadNotAllowed();
  }
}

function errorInfo(e: CoreError): SyncErrorInfo {
  return { code: e.code, message: e.message };
}

// ---------------------------------------------------------------- validation

/** The normalized server URL (always ending in `/`), or a CoreError like the core's. */
export function normalizeSyncUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw syncErrors.invalidUrl();
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) throw syncErrors.invalidUrl();
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'ankiweb.net' || host.endsWith('.ankiweb.net')) throw syncErrors.ankiWebRefused();
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  u.search = '';
  u.hash = '';
  return u.toString();
}

const PEM_RE = /^-----BEGIN CERTIFICATE-----\s+([A-Za-z0-9+/=\s]+?)\s*-----END CERTIFICATE-----$/;

/** Exactly one PEM certificate (what rslib's reqwest accepts); the base64 body. */
export function pemBody(pem: string): string {
  const text = pem.trim();
  const m = PEM_RE.exec(text);
  if (!m || text.split('-----BEGIN').length !== 2) throw syncErrors.invalidCertificate();
  const body = m[1]!.replace(/\s+/g, '');
  if (body.length < 16 || body.length % 4 !== 0) throw syncErrors.invalidCertificate();
  return body;
}

/** A stand-in for the SHA-256 fingerprint ("AB:CD:…", 32 bytes), deterministic per certificate. */
export function mockFingerprint(body: string): string {
  const out: string[] = [];
  let h = 0x811c9dc5;
  for (let i = 0; i < 32; i++) {
    for (let j = 0; j < body.length; j++) h = Math.imul(h ^ (body.charCodeAt(j) + i), 0x01000193) >>> 0;
    out.push((h & 0xff).toString(16).toUpperCase().padStart(2, '0'));
  }
  return out.join(':');
}

// ---------------------------------------------------------------- state

const STORAGE_KEY = 'leitor.mock.sync';

function initialState(): SyncMockState {
  return {
    url: null,
    user: null,
    loggedIn: false,
    certificateFingerprint: null,
    firstSyncPending: false,
    lastSyncAt: null,
    state: 'off',
    lastError: null,
    fullSync: null,
    nextRetryAt: null,
    mediaError: null,
    serverMessage: null,
    offline: false,
    pendingFull: null,
    notifications: [],
  };
}

function load(): SyncMockState {
  try {
    const raw = globalThis.sessionStorage?.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as SyncMockState;
      if (parsed && typeof parsed.state === 'string') {
        // A sync cut by a reload never finished.
        if (parsed.state === 'syncing') parsed.state = parsed.loggedIn ? 'idle' : 'off';
        return { ...initialState(), ...parsed };
      }
    }
  } catch {
    // Corrupt or unavailable storage: start over.
  }
  return initialState();
}

let state: SyncMockState | null = null;
/** Bumped by `resetSync`, so a sync still running from before the reset does nothing. */
let generation = 0;
let running: Promise<AnkiSyncStatus> | null = null;

function st(): SyncMockState {
  state ??= load();
  return state;
}

function persist(): void {
  try {
    if (state) globalThis.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Keep the in-memory state only.
  }
}

export function syncStatusOf(s: SyncMockState): AnkiSyncStatus {
  return {
    state: s.state,
    url: s.url,
    user: s.user,
    loggedIn: s.loggedIn,
    certificateFingerprint: s.certificateFingerprint,
    firstSyncPending: s.firstSyncPending,
    lastSyncAt: s.lastSyncAt,
    lastError: s.lastError ? { ...s.lastError } : null,
    fullSync: s.fullSync ? { ...s.fullSync } : null,
    nextRetryAt: s.nextRetryAt,
    mediaSyncing: false,
    mediaError: s.mediaError,
    serverMessage: s.serverMessage,
  };
}

const listeners = new Set<(s: AnkiSyncStatus) => void>();

function emit(): AnkiSyncStatus {
  persist();
  const status = syncStatusOf(st());
  for (const cb of listeners) cb(syncStatusOf(st()));
  return status;
}

/** How long a pretend sync takes (visible "Sincronizando…" in the browser, instant in unit tests). */
function syncDuration(): number {
  return mockLatency() * 5;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function goOffline(): void {
  const s = st();
  s.state = 'offline';
  s.lastError = errorInfo(syncErrors.offline());
  s.nextRetryAt = Date.now() + MOCK_RETRY_MS;
}

function requireLogin(): SyncMockState {
  const s = st();
  if (!s.loggedIn) throw syncErrors.notLoggedIn();
  return s;
}

/** A normal sync (or the first one: a full download with a backup first, spec 9). */
function runSync(): Promise<AnkiSyncStatus> {
  if (running) return running;
  const gen = generation;
  const job = (async () => {
    const s = st();
    if (s.offline) {
      goOffline();
      return emit();
    }
    if (s.pendingFull && !s.firstSyncPending) {
      s.state = 'fullSyncRequired';
      s.fullSync = { ...s.pendingFull };
      s.nextRetryAt = null;
      return emit();
    }
    s.state = 'syncing';
    emit();
    await delay(syncDuration());
    // Reset/logout meanwhile, or the server started asking for a full sync (test handle): that wins.
    if (gen !== generation || (s.state as SyncState) === 'fullSyncRequired') return syncStatusOf(st());
    if (s.offline) {
      goOffline();
      return emit();
    }
    const first = s.firstSyncPending;
    if (first) {
      const backup = pushBackup('preSync');
      logAnki('syncFull', { direction: 'download', first: true, backup: backup.fileName });
      s.firstSyncPending = false;
      s.pendingFull = null;
    } else {
      logAnki('sync', {});
    }
    s.state = 'idle';
    s.lastSyncAt = Date.now();
    s.lastError = null;
    s.nextRetryAt = null;
    const status = emit();
    emitAnkiChanged({ reason: first ? 'syncFull' : 'sync' });
    return status;
  })();
  running = job;
  void job.finally(() => {
    if (running === job) running = null;
  });
  return job;
}

/**
 * Same as the core after a `.colpkg` import: the collection is disposable, so the next sync of the account is a first
 * sync again (a download, never a merge or an upload) and a pending full-sync choice no longer applies.
 */
export function syncCollectionReplaced(): void {
  const s = st();
  if (!s.loggedIn) return;
  s.firstSyncPending = true;
  if (s.state === 'fullSyncRequired') s.state = 'idle';
  s.fullSync = null;
  emit();
}

export function resetSync(): void {
  generation++;
  running = null;
  state = initialState();
  persist();
}

// ---------------------------------------------------------------- client

export const ankiSyncMock: Pick<CoreClient, AnkiSyncMockKeys> = {
  ankiSyncStatus: () => later(() => syncStatusOf(st())),

  ankiSyncLogin: (url, user, password, certificatePem) =>
    later(() => {
      const s = st();
      const normalized = normalizeSyncUrl(url);
      const fingerprint = certificatePem === null ? s.certificateFingerprint : mockFingerprint(pemBody(certificatePem));
      if (s.offline) throw syncErrors.offline();
      if (user.trim() !== 'test' || password !== 'test') throw syncErrors.authFailed();
      s.url = normalized;
      s.user = user.trim();
      s.loggedIn = true;
      s.certificateFingerprint = fingerprint;
      s.firstSyncPending = true;
      s.lastSyncAt = null;
      s.lastError = null;
      s.fullSync = null;
      s.nextRetryAt = null;
      s.state = 'syncing';
      logAnki('syncLogin', { url: normalized, user: s.user });
      return emit();
    }).then((status) => {
      void runSync();
      return status;
    }),

  ankiSyncLogout: () =>
    later(() => {
      generation++;
      running = null;
      const s = st();
      s.loggedIn = false;
      s.state = 'off';
      s.firstSyncPending = false;
      s.lastError = null;
      s.fullSync = null;
      s.nextRetryAt = null;
      s.mediaError = null;
      s.serverMessage = null;
      logAnki('syncLogout', {});
      return emit();
    }),

  ankiSyncSetCertificate: (pem) =>
    later(() => {
      st().certificateFingerprint = pem === null ? null : mockFingerprint(pemBody(pem));
      return emit();
    }),

  ankiSync: () =>
    later(() => requireLogin()).then(() => {
      const s = st();
      if (s.state === 'fullSyncRequired') return syncStatusOf(s);
      return runSync();
    }),

  ankiSyncFull: (direction) =>
    later((): FullSyncResult => {
      const s = requireLogin();
      checkFullSync(direction, s.fullSync, s.firstSyncPending);
      if (s.offline) throw syncErrors.offline();
      const backup = pushBackup('preSync');
      s.pendingFull = null;
      s.fullSync = null;
      s.firstSyncPending = false;
      s.state = 'idle';
      s.lastSyncAt = Date.now();
      s.lastError = null;
      s.nextRetryAt = null;
      logAnki('syncFull', { direction, backup: backup.fileName });
      const status = emit();
      emitAnkiChanged({ reason: 'syncFull' });
      return { status, backup };
    }),

  ankiSyncNotify: (event) =>
    later(() => {
      const s = st();
      s.notifications.push(event);
      persist();
      if (!s.loggedIn || s.state === 'fullSyncRequired') return;
      const age = s.lastSyncAt === null ? Infinity : Date.now() - s.lastSyncAt;
      if (event === 'offline') {
        if (s.state !== 'syncing') {
          goOffline();
          emit();
        }
      } else if (event === 'online') {
        if (s.state === 'offline' || s.state === 'error') void runSync();
      } else if (s.state === 'idle' && age > (event === 'tabEntered' ? 2 * MIN : 5 * MIN)) {
        void runSync();
      }
    }),

  onAnkiSync: (cb) => listenTo(listeners, cb),
};

// ---------------------------------------------------------------- e2e handle

/** `window.__leitorMock.anki` sync controls. */
export interface MockSyncHandle {
  /** Network down (`true`) or back (`false`); going down while logged in shows the offline state at once. */
  syncSetOffline(offline: boolean): void;
  /** The server answers the next sync with "full sync required" (`null` clears it); applies at once when logged in. */
  syncRequireFull(choice: FullSyncChoice | null): void;
  /** Pretends the last sync happened at `ms` (epoch). */
  syncSetLastSyncAt(ms: number | null): void;
  /** The server refused the stored key (like the core: the key is dropped, logged out, the error stays visible). */
  syncRefuseKey(): void;
  syncStatus(): AnkiSyncStatus;
  readonly syncNotifications: SyncNotifyEvent[];
}

export const mockSyncHandle: MockSyncHandle = {
  syncSetOffline(offline) {
    const s = st();
    s.offline = offline;
    if (offline && s.loggedIn && s.state !== 'fullSyncRequired') goOffline();
    emit();
  },
  syncRequireFull(choice) {
    const s = st();
    s.pendingFull = choice ? { ...choice } : null;
    if (s.loggedIn && !s.firstSyncPending) {
      if (choice) {
        s.state = 'fullSyncRequired';
        s.fullSync = { ...choice };
      } else if (s.state === 'fullSyncRequired') {
        s.state = 'idle';
        s.fullSync = null;
      }
    }
    emit();
  },
  syncSetLastSyncAt(ms) {
    st().lastSyncAt = ms;
    emit();
  },
  syncRefuseKey() {
    const s = st();
    if (!s.loggedIn) return;
    generation++;
    running = null;
    s.loggedIn = false;
    s.state = 'off';
    s.firstSyncPending = false;
    s.fullSync = null;
    s.pendingFull = null;
    s.nextRetryAt = null;
    s.lastError = errorInfo(syncErrors.authFailed());
    emit();
  },
  syncStatus: () => syncStatusOf(st()),
  get syncNotifications() {
    return [...st().notifications];
  },
};
