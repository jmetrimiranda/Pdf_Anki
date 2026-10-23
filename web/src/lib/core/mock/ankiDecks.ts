// Mock of the deck, collection, import/export and backup commands, the Anki pages URL and the Anki events.
import { CoreError, type BackupInfo, type CoreClient, type DeckName, type ImportSummary } from '../types';
import {
  ankiChangedListeners,
  ankiPageListeners,
  ankiState,
  APP_NOTETYPES,
  backupInfo,
  baseName,
  buildDeckTree,
  colpkgAnki,
  DAY_MS,
  DEFAULT_DECK_ID,
  deckById,
  deckByName,
  deckTotal,
  emitAnkiChanged,
  later,
  listenTo,
  logAnki,
  newId,
  NT_BASIC,
  persistAnki,
  replaceAnki,
  subtree,
  type AnkiDecksMockKeys,
  type MockDeck,
} from './ankiData';

/** What the deck mock needs from the base mock (mock.ts): the one-shot export grants and its fake file system. */
export interface AnkiDecksMockDeps {
  takeExportGrant(path: string): void;
  writeFile(path: string, content: string): void;
  /** A `.colpkg` replaced the collection: the sync mock makes the next sync a first sync (a download). */
  collectionReplaced(): void;
}

export const KEEP_DAILY = 7;
export const KEEP_PRE_IMPORT = 5;
export const KEEP_PRE_SYNC = 5;
export const DEFAULT_PACKAGE_PICK = '/home/jorge/Downloads/Vocabulário do livro.apkg';

/** Splits and validates a full deck name like the core (`::` separated, no empty component). */
export function normalizeDeckName(name: string): string {
  const parts = name.split('::').map((p) => p.trim());
  if (!parts.length || parts.some((p) => !p)) {
    throw new CoreError('invalid_input', 'O nome do deck não pode ter partes vazias.');
  }
  return parts.join('::');
}

function liveDeck(id: number): MockDeck {
  const d = deckById(id);
  if (!d) throw new CoreError('anki_not_found', 'Deck não encontrado.');
  return d;
}

/** Anki keeps names unique by appending "+" (rslib `ensure_deck_name_unique`). */
function uniqueName(name: string, exceptIds: Set<number>): string {
  let out = name;
  while (ankiState().decks.some((d) => !exceptIds.has(d.id) && d.name.toLowerCase() === out.toLowerCase())) out += '+';
  return out;
}

/** Creates the deck and any missing parent; returns the id (the existing one when the name is taken). */
export function createDeck(name: string): number {
  const full = normalizeDeckName(name);
  const parts = full.split('::');
  let id = DEFAULT_DECK_ID;
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join('::');
    const existing = deckByName(prefix);
    if (existing) {
      id = existing.id;
      continue;
    }
    id = newId();
    ankiState().decks.push({
      id,
      name: prefix,
      collapsed: false,
      filtered: false,
      display: null,
      extraCards: 0,
    });
  }
  persistAnki();
  return id;
}

/** Renames a deck and its subdecks (prefix change), creating missing parents of the new name. */
function renameDeck(id: number, name: string): void {
  const deck = liveDeck(id);
  const full = normalizeDeckName(name);
  const tree = subtree(id);
  const ids = new Set(tree.map((d) => d.id));
  if (full.toLowerCase().startsWith(`${deck.name.toLowerCase()}::`)) {
    throw new CoreError('invalid_input', 'Um deck não pode ficar dentro dele mesmo.');
  }
  const target = uniqueName(full, ids);
  const old = deck.name;
  for (const d of tree) d.name = d.id === id ? target : target + d.name.slice(old.length);
  // Missing parents of the new name.
  const parts = target.split('::');
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join('::');
    if (!deckByName(prefix)) {
      ankiState().decks.push({
        id: newId(),
        name: prefix,
        collapsed: false,
        filtered: false,
        display: null,
        extraCards: 0,
      });
    }
  }
  persistAnki();
}

function leaf(name: string): string {
  const parts = name.split('::');
  return parts[parts.length - 1] ?? name;
}

function moveDecks(ids: number[], parentId: number | null): void {
  const parent = parentId === null ? null : liveDeck(parentId);
  for (const id of ids) {
    const deck = deckById(id);
    if (!deck) continue;
    // Like Anki's reparent: moving into itself or a descendant is skipped.
    if (parent && subtree(id).some((d) => d.id === parent.id)) continue;
    renameDeck(id, parent ? `${parent.name}::${leaf(deck.name)}` : leaf(deck.name));
  }
}

function deleteDeck(id: number): { cardsDeleted: number } {
  const deck = liveDeck(id);
  const s = ankiState();
  const tree = subtree(id);
  const ids = new Set(tree.map((d) => d.id));
  const cardsDeleted = deckTotal(id);
  const removedCards = s.cards.filter((c) => ids.has(c.deckId));
  s.cards = s.cards.filter((c) => !ids.has(c.deckId));
  const notesLeft = new Set(s.cards.map((c) => c.noteId));
  const removedNotes = new Set(removedCards.map((c) => c.noteId).filter((n) => !notesLeft.has(n)));
  s.notes = s.notes.filter((n) => !removedNotes.has(n.id));
  // The Default deck is never removed (Anki empties it).
  s.decks = s.decks.filter((d) => !ids.has(d.id) || d.id === DEFAULT_DECK_ID);
  const def = deckById(DEFAULT_DECK_ID);
  if (def && ids.has(DEFAULT_DECK_ID)) {
    def.extraCards = 0;
    def.display = null;
  }
  if (ids.has(s.currentDeckId)) s.currentDeckId = DEFAULT_DECK_ID;
  persistAnki();
  logAnki('deleteDeck', { deckId: id, name: deck.name, cardsDeleted });
  return { cardsDeleted };
}

function deckNames(): DeckName[] {
  return ankiState()
    .decks.filter((d) => d.id !== DEFAULT_DECK_ID || deckTotal(d.id) > 0)
    .map((d) => ({ id: d.id, name: d.name, filtered: d.filtered }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }));
}

function prepareCollection() {
  const s = ankiState();
  const created: string[] = [];
  const existing: string[] = [];
  for (const nt of APP_NOTETYPES) {
    if (s.notetypes.some((x) => x.name === nt.name)) existing.push(nt.name);
    else {
      s.notetypes.push(structuredClone(nt));
      created.push(nt.name);
    }
  }
  persistAnki();
  logAnki('prepare', { created, existing });
  return { created, existing };
}

function packagePath(path: string, ext: 'apkg' | 'colpkg'): void {
  if (!path.toLowerCase().endsWith(`.${ext}`)) {
    throw new CoreError('anki_invalid_package', `O arquivo não é um pacote .${ext} do Anki.`);
  }
  if (/corromp|invalid/i.test(path)) {
    throw new CoreError('anki_invalid_package', 'O pacote do Anki está corrompido ou não é válido.');
  }
}

function importApkg(path: string): ImportSummary {
  packagePath(path, 'apkg');
  const name = baseName(path).replace(/\.apkg$/i, '') || 'Importado';
  const deckId = createDeck(name);
  const s = ankiState();
  const words: [string, string][] = [
    ['meadow', 'prado'],
    ['harvest', 'colheita'],
    ['barn', 'celeiro'],
  ];
  let added = 0;
  let duplicates = 0;
  for (const [en, pt] of words) {
    if (s.notes.some((n) => n.fields[0] === en && s.cards.some((c) => c.noteId === n.id && c.deckId === deckId))) {
      duplicates++;
      continue;
    }
    const noteId = newId();
    s.notes.push({ id: noteId, notetypeId: NT_BASIC, fields: [en, pt], tags: ['importado'], mtime: Date.now() });
    s.cards.push({
      id: newId(),
      noteId,
      deckId,
      ord: 0,
      queue: 'new',
      due: 10_000 + (noteId % 1000),
      ivl: 0,
      ease: 0,
      reps: 0,
      lapses: 0,
      flag: 0,
    });
    added++;
  }
  persistAnki();
  const summary = { added, updated: 0, duplicates, conflicts: 0, skipped: 0 };
  logAnki('import', { path, ...summary });
  return summary;
}

/** Adds a backup of the mock collection (exported for the sync mock's pre-full-sync backups). */
export function pushBackup(kind: BackupInfo['kind']): BackupInfo {
  const s = ankiState();
  const info = backupInfo(kind, Date.now(), 2_400_000 + s.cards.length * 512);
  s.backups.push(info);
  // Retention like core-anki `backup`: the last 7 daily, 5 pre-import and 5 pre-sync; manual ones stay.
  const keep = (k: BackupInfo['kind'], n: number) => {
    const of = s.backups.filter((b) => b.kind === k).sort((a, b) => b.createdAt - a.createdAt);
    const drop = new Set(of.slice(n).map((b) => b.path));
    s.backups = s.backups.filter((b) => !drop.has(b.path));
  };
  keep('daily', KEEP_DAILY);
  keep('preImport', KEEP_PRE_IMPORT);
  keep('preSync', KEEP_PRE_SYNC);
  persistAnki();
  return info;
}

function importColpkg(path: string): BackupInfo {
  packagePath(path, 'colpkg');
  const backup = pushBackup('preImport');
  const old = ankiState();
  const next = colpkgAnki();
  // Backups live outside the collection: they survive the replacement.
  next.backups = old.backups;
  next.logs = old.logs;
  next.nextId = Math.max(old.nextId, next.nextId);
  replaceAnki(next);
  logAnki('importColpkg', { path, backup: backup.fileName });
  return backup;
}

/** HTML of the stand-in Anki page served by the mock (`/__mock-anki-page/<route>`, see vite.config.ts). */
export function mockAnkiPageUrl(route: string, night: boolean): string {
  const origin = typeof location !== 'undefined' ? location.origin : 'http://localhost';
  const clean = route.replace(/^\/+/, '');
  return `${origin}/__mock-anki-page/${clean}${night ? '#night' : ''}`;
}

export function createAnkiDecksMock(deps: AnkiDecksMockDeps): Pick<CoreClient, AnkiDecksMockKeys> {
  return {
    ankiDeckTree: () => later(buildDeckTree),
    ankiDeckNames: () => later(deckNames),
    ankiDeckCreate: (name) =>
      later(() => {
        const id = createDeck(name);
        logAnki('createDeck', { name, deckId: id });
        return id;
      }),
    ankiDeckRename: (deckId, name) =>
      later(() => {
        renameDeck(deckId, name);
        logAnki('renameDeck', { deckId, name });
      }),
    ankiDeckMove: (deckIds, parentId) =>
      later(() => {
        moveDecks(deckIds, parentId);
        logAnki('moveDecks', { deckIds, parentId });
      }),
    ankiDeckDelete: (deckId) => later(() => deleteDeck(deckId)),
    ankiDeckSetCollapsed: (deckId, collapsed) =>
      later(() => {
        liveDeck(deckId).collapsed = collapsed;
        persistAnki();
      }),
    ankiSetCurrentDeck: (deckId) =>
      later(() => {
        liveDeck(deckId);
        ankiState().currentDeckId = deckId;
        persistAnki();
      }),
    ankiPrepareCollection: () => later(prepareCollection),

    ankiPickPackage: () =>
      later(() => {
        const s = ankiState();
        const next = s.nextPackagePick;
        delete s.nextPackagePick;
        persistAnki();
        return next === undefined ? DEFAULT_PACKAGE_PICK : next;
      }),
    ankiImport: (path) =>
      later(() => {
        const summary = importApkg(path);
        emitAnkiChanged({ reason: 'import' });
        return summary;
      }),
    ankiImportColpkg: (path) =>
      later(() => {
        const backup = importColpkg(path);
        deps.collectionReplaced();
        emitAnkiChanged({ reason: 'colpkg' });
        return backup;
      }),
    ankiExport: (deckId, path, opts) =>
      later(() => {
        const deck = liveDeck(deckId);
        deps.takeExportGrant(path);
        const ids = new Set(subtree(deckId).map((d) => d.id));
        const s = ankiState();
        const notes = new Set(s.cards.filter((c) => ids.has(c.deckId)).map((c) => c.noteId)).size;
        deps.writeFile(path, `apkg:${deck.name}`);
        logAnki('export', { deckId, deck: deck.name, path, ...opts, notes });
        return { notes };
      }),
    ankiBackupNow: () =>
      later(() => {
        const info = pushBackup('manual');
        logAnki('backup', { fileName: info.fileName });
        return info;
      }),
    ankiBackups: () => later(() => [...ankiState().backups].sort((a, b) => b.createdAt - a.createdAt)),

    ankiPageUrl: mockAnkiPageUrl,
    onAnkiChanged: (cb) => listenTo(ankiChangedListeners, cb),
    onAnkiPageEvent: (cb) => listenTo(ankiPageListeners, cb),
  };
}

/** Today's daily backup, like the core's ticker (exposed to tests through the mock handle). */
export function mockDailyBackup(): BackupInfo | null {
  const s = ankiState();
  const last = s.backups.filter((b) => b.kind === 'daily').sort((a, b) => b.createdAt - a.createdAt)[0];
  if (last && Date.now() - last.createdAt < DAY_MS) return null;
  return pushBackup('daily');
}
