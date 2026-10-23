// Contract snapshot (spec 15, 20): the mock core must produce values with exactly the JSON keys the Rust core
// serializes. `contract.json` is written and checked by `src-tauri/app/tests/contract.rs` from the fixture collection.
import { beforeEach, describe, expect, it } from 'vitest';
import importExample from '../../../../src-tauri/crates/core-code/tests/fixtures/import_example.md?raw';
import contract from './__fixtures__/contract.json';
import { mockClient, mockHandle } from './mock';
import { intervalLabel, NEW_CARD_LABELS } from './mock/ankiStudy';
import type { AvTag, DeckNode, StudyCard } from './types';

type Shapes = Record<string, string[]>;

/** A "Due" cell reduced to its format, like `due_format` in contract.rs ("Novo #9", "9-9-9", "(9-9-9)"; Fluent wraps
 * numbers in the isolation marks U+2068/U+2069). */
function dueFormat(text: string): string {
  return text.replace(/\d+/g, '9');
}

function keysOf(v: unknown): string[] {
  expect(v && typeof v === 'object' && !Array.isArray(v)).toBe(true);
  return Object.keys(v as object).sort();
}

function collect(out: Shapes, name: string, v: unknown) {
  const k = keysOf(v);
  if (out[name]) expect(k, `${name} keys differ between samples`).toEqual(out[name]);
  else out[name] = k;
}

function collectAv(out: Shapes, list: AvTag[]) {
  for (const tag of list) collect(out, `AvTag.${tag.kind}`, tag);
}

function collectCode(out: Shapes, card: StudyCard) {
  if (card.code) {
    collect(out, 'CodeCard', card.code);
    collect(out, 'CodeCardFields', card.code.fields);
  }
}

function walk(nodes: DeckNode[], fn: (n: DeckNode) => void) {
  for (const n of nodes) {
    fn(n);
    walk(n.children, fn);
  }
}

beforeEach(() => mockHandle.reset());

describe('mock core vs the Rust contract snapshot', () => {
  it('serializes the same keys as the Rust core', async () => {
    const out: Shapes = {};
    const tree = await mockClient.ankiDeckTree();
    collect(out, 'DeckTree', tree);
    walk(tree.decks, (n) => collect(out, 'DeckNode', n));
    collect(out, 'StudiedToday', tree.studiedToday);

    for (const deck of await mockClient.ankiDeckNames()) {
      const next = await mockClient.ankiStudyNext(deck.id);
      if (next.kind === 'card') {
        collect(out, 'StudyNext.card', next);
        collect(out, 'StudyCard', next.card);
        collectCode(out, next.card);
        collect(out, 'QueueCounts', next.card.counts);
        collectAv(out, next.card.questionAv);
        collectAv(out, next.card.answerAv);
        if (next.card.source) collect(out, 'SourceLink', next.card.source);
        const side = await mockClient.ankiShowAnswer(next.card.cardId, 'x');
        collect(out, 'AnswerSide', side);
        collectAv(out, side.av);
      } else {
        collect(out, 'StudyNext.done', next);
      }
    }
    const empty = await mockClient.ankiDeckCreate('Contrato vazio');
    collect(out, 'StudyNext.done', await mockClient.ankiStudyNext(empty));
    await mockClient.ankiStudyClose();

    for (const nt of await mockClient.ankiNotetypes()) {
      collect(out, 'NotetypeInfo', nt);
      for (const f of nt.fields) collect(out, 'FieldInfo', f);
    }
    const ids = await mockClient.ankiSearch('', null);
    for (const row of await mockClient.ankiBrowseRows(ids.slice(0, 20))) collect(out, 'BrowseRow', row);
    collect(out, 'BackupInfo', await mockClient.ankiBackupNow());

    // Sync (spec 9): off, after login, an error status, a required full sync and its result.
    collect(out, 'AnkiSyncStatus', await mockClient.ankiSyncStatus());
    collect(out, 'AnkiSyncStatus', await mockClient.ankiSyncLogin('http://ankisync:8080/', 'test', 'test', null));
    await new Promise((r) => setTimeout(r, 5));
    mockHandle.syncSetOffline(true);
    const offline = await mockClient.ankiSync();
    collect(out, 'AnkiSyncStatus', offline);
    collect(out, 'SyncErrorInfo', offline.lastError);
    mockHandle.syncSetOffline(false);
    mockHandle.syncRequireFull({ uploadOk: true, downloadOk: true });
    const required = await mockClient.ankiSync();
    collect(out, 'FullSyncChoice', required.fullSync);
    const full = await mockClient.ankiSyncFull('download');
    collect(out, 'FullSyncResult', full);
    collect(out, 'AnkiSyncStatus', full.status);
    collect(out, 'BackupInfo', full.backup);

    // Book panel (spec 10): the Animal Farm book with a content deck, the cards of the book, the mini-review, the study
    // owner event, "Definir palavra" with a vocabulary folder and a deep link.
    const farmBook = (await mockClient.libraryList()).find((b) => b.title === 'Animal Farm')!;
    const farmDeck = (await mockClient.ankiDeckNames()).find((d) => d.name === 'Livros::Animal Farm')!.id;
    const panel = await mockClient.bookPanelSet(farmBook.bookUid, { contentDeckId: farmDeck });
    collect(out, 'BookPanelInfo', panel);
    collect(out, 'BookDeckInfo', panel.vocabDeck);
    collect(out, 'BookDeckInfo', panel.contentDeck);
    collect(out, 'QueueCounts', panel.vocabDeck.counts);
    for (const c of await mockClient.ankiBookCards(farmBook.bookUid)) collect(out, 'BookCard', c);
    const changes: unknown[] = [];
    const stop = mockClient.onStudyOwner((c) => changes.push(c));
    collect(out, 'MiniReviewOpened', await mockClient.ankiMiniReviewOpen(farmDeck));
    collect(out, 'MiniReviewClosed', await mockClient.ankiMiniReviewClose());
    stop();
    for (const c of changes) collect(out, 'StudyOwnerChange', c);
    mockHandle.setVocabRoot((await mockClient.ankiDeckNames()).find((d) => d.name === '5000 palavras')!.id);
    const def = await mockClient.vocabDefine('windmills', farmBook.bookUid);
    collect(out, 'WordDefinition', def);
    collect(out, 'WordDefinition.note', def.note);
    const links: unknown[] = [];
    const stopLinks = mockClient.onDeepLink((l) => links.push(l));
    mockHandle.deepLink(`leitor://livro/${farmBook.bookUid}?pagina=3&q=windmill`);
    stopLinks();
    for (const l of links) collect(out, 'DeepLink', l);

    // Code cards (spec 11): the mapped user type studied as a code card, the mapping, extras, "Contestar", C++
    // results, status/settings and the Markdown import of the spec's example.
    const user = (await mockClient.ankiNotetypes()).find((n) => n.name === 'ROS 2 · Digite o comando')!;
    const list = await mockClient.codeMappingSet(user.id, {
      question: 'Frente',
      answer: 'Comando',
      notes: 'Explicação',
    });
    collect(out, 'CodeMapping', list[0]);
    collect(out, 'CodeMappingFields', list[0]!.fields);
    const ros = (await mockClient.ankiDeckNames()).find((d) => d.name === 'ROS 2 — Revisão')!.id;
    let mapped = false;
    let step = await mockClient.ankiStudyNext(ros);
    for (let i = 0; i < 20 && step.kind === 'card'; i++) {
      collect(out, 'StudyCard', step.card);
      collectCode(out, step.card);
      if (step.card.code?.notetypeId === user.id) {
        mapped = true;
        break;
      }
      step = await mockClient.ankiAnswer(step.card.cardId, 3, 1000);
    }
    expect(mapped, 'the mapped user card was studied as a code card').toBe(true);
    const userNote = (await mockClient.ankiSearch(`note:"${user.name}"`, null))[0]!;
    const userNoteId = (await mockClient.ankiBrowseRows([userNote]))[0]!.noteId;
    collect(out, 'CodeNoteExtra', await mockClient.codeNoteExtraSet(userNoteId, ['ls -la'], ['sudo']));
    collect(out, 'CodeAcceptResult', await mockClient.codeAcceptAnswer(userNoteId, 'ls -l -a'));
    const run = await mockClient.codeRunCpp(
      { 'main.cpp': '#include <iostream>\nint main() { std::cout << "oi\\n"; }' },
      '',
    );
    collect(out, 'CppRunResult', run);
    collect(out, 'CppCompileResult', run.compile);
    collect(out, 'CppRunOutput', run.run);
    const status = await mockClient.codeStatus();
    collect(out, 'CodeStatus', status);
    collect(out, 'CppStatus', status.cpp);
    collect(out, 'LocalCppStatus', status.cpp.local);
    collect(out, 'RemoteCppStatus', status.cpp.remote);
    collect(out, 'CodeSettings', await mockClient.codeSettingsGet());
    collect(out, 'RunnerTestResult', await mockClient.codeRunnerTest());
    collect(out, 'CodeFormatted', await mockClient.codeFormatCpp('int main() {}\n'));
    const preview = await mockClient.codeImportMarkdown(importExample);
    collect(out, 'ImportPreview', preview);
    for (const item of preview.items) collect(out, 'ImportItem', item);
    const words = (await mockClient.ankiDeckNames()).find((d) => d.name === '5000 palavras')!.id;
    const imported = await mockClient.codeImportCommit(importExample, words, [0, 1]);
    expect(imported.added).toBe(2);
    collect(out, 'CodeImportResult', imported);

    const expected = contract as Shapes;
    for (const required of [
      'StudyNext.card',
      'StudyNext.done',
      'StudyCard',
      'SourceLink',
      'AnswerSide',
      'BrowseRow',
      'NotetypeInfo',
      'FieldInfo',
      'BackupInfo',
      'DeckNode',
      'AnkiSyncStatus',
      'SyncErrorInfo',
      'FullSyncChoice',
      'FullSyncResult',
      'BookPanelInfo',
      'BookDeckInfo',
      'BookCard',
      'MiniReviewOpened',
      'MiniReviewClosed',
      'StudyOwnerChange',
      'WordDefinition',
      'WordDefinition.note',
      'DeepLink',
      'CodeCard',
      'CodeCardFields',
      'CodeMapping',
      'CodeMappingFields',
      'CodeNoteExtra',
      'CodeAcceptResult',
      'CppRunResult',
      'CppCompileResult',
      'CppRunOutput',
      'CodeStatus',
      'CppStatus',
      'LocalCppStatus',
      'RemoteCppStatus',
      'CodeSettings',
      'RunnerTestResult',
      'CodeFormatted',
      'ImportPreview',
      'ImportItem',
      'CodeImportResult',
    ]) {
      expect(out[required], `the mock produced no ${required}`).toBeDefined();
    }
    for (const [name, keys] of Object.entries(out)) {
      if (name.startsWith('Values.')) continue;
      expect(expected[name], `${name} is not in contract.json`).toBeDefined();
      expect(keys, name).toEqual(expected[name]);
    }
  });

  // Value-level samples (the text the UI shows as is), from rslib with the pt-BR translations.
  it('shows the same pt-BR interval labels as rslib', () => {
    const samples = (contract as Shapes)['Values.intervalLabels'];
    expect(samples?.length).toBeGreaterThan(0);
    for (const sample of samples!) {
      const m = /^(\d+)(?:<(\d+))?=(.*)$/.exec(sample);
      expect(m, sample).not.toBeNull();
      const [, secs, collapse, label] = m!;
      const collapsed = collapse !== undefined && Number(secs) < Number(collapse);
      expect(intervalLabel(Number(secs), collapsed), sample).toBe(label);
    }
    // Again/hard/good of a new card (the easy interval is fuzzed, so it is checked through the 4-day sample).
    expect((contract as Shapes)['Values.newCardButtons']).toEqual([NEW_CARD_LABELS.slice(0, 3).join('|')]);
    expect(samples).toContain(`345600=${NEW_CARD_LABELS[3]}`);
  });

  it('formats the browser "Due" column like rslib', async () => {
    const ids = await mockClient.ankiSearch('', null);
    const rows = await mockClient.ankiBrowseRows(ids.slice(0, 200));
    const review = rows.find((r) => !r.due.startsWith('Novo'));
    expect(review).toBeDefined();
    await mockClient.ankiCardsSuspend([review!.cardId], true);
    rows.push(...(await mockClient.ankiBrowseRows([review!.cardId])));
    const formats = new Set(rows.map((r) => dueFormat(r.due)));
    const expected = (contract as Shapes)['Values.browseDueFormats'];
    expect(expected).toEqual(expect.arrayContaining(['Novo #\u20689\u2069', '9-9-9', '(9-9-9)']));
    for (const f of formats) expect(expected, `mock due format ${f}`).toContain(f);
  });
});
