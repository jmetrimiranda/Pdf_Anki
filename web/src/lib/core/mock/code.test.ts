import importExample from '../../../../../src-tauri/crates/core-code/tests/fixtures/import_example.md?raw';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient, mockHandle } from '../mock';
import { CoreError, type StudyCard } from '../types';
import { deckByName, NT_USER_COMMAND } from './ankiData';
import { CODE_CSS } from './ankiStudy';

beforeEach(() => mockHandle.reset());

const deckId = (name: string) => deckByName(name)!.id;

async function cardsOf(deck: string): Promise<StudyCard[]> {
  const out: StudyCard[] = [];
  let next = await mockClient.ankiStudyNext(deckId(deck));
  while (next.kind === 'card' && out.length < 20) {
    out.push(next.card);
    next = await mockClient.ankiAnswer(next.card.cardId, 4, 1000);
  }
  await mockClient.ankiStudyClose();
  return out;
}

async function rejects(p: Promise<unknown>): Promise<CoreError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CoreError) return e;
    throw e;
  }
  throw new Error('did not reject');
}

describe('mock code cards', () => {
  it('StudyCard.code: app types always (only the Pergunta, no type box), user type only once mapped', async () => {
    const ros = await cardsOf('ROS 2 — Revisão');
    const command = ros.find((c) => c.questionHtml.includes('tf2_echo') || c.code?.fields.answer.includes('tf2_echo'))!;
    expect(command.code).toMatchObject({
      role: 'command',
      appType: true,
      acceptedField: true,
      answerShowsNotes: true,
      answerShowsAnswer: false,
    });
    expect(command.typeAnswer).toBe(false);
    expect(command.questionHtml).not.toContain('typeans');
    const stock = ros.find((c) => c.questionHtml.includes('compilar o workspace'))!;
    expect(stock.code).toBeNull();
    expect(stock.typeAnswer).toBe(true);
    const user = ros.filter((c) => c.questionHtml.includes('DIGITE O COMANDO'));
    expect(user).toHaveLength(3);
    expect(user.every((c) => c.code === null)).toBe(true);

    await mockClient.codeMappingSet(NT_USER_COMMAND, { question: 'Frente', answer: 'Comando', notes: 'Explicação' });
    mockHandle.reset();
    await mockClient.codeMappingSet(NT_USER_COMMAND, { question: 'Frente', answer: 'Comando', notes: 'Explicação' });
    const mapped = (await cardsOf('ROS 2 — Revisão')).filter((c) => c.code?.notetypeId === NT_USER_COMMAND);
    expect(mapped).toHaveLength(3);
    expect(mapped[0]!.code).toMatchObject({
      role: 'command',
      appType: false,
      acceptedField: false,
      answerShowsNotes: true,
      answerShowsAnswer: true,
    });
    expect(mapped[0]!.questionHtml).not.toContain('textarea');
    expect(mapped.map((c) => c.code!.fields.answer)).toContain('sudo apt install ros-humble-turtlesim');

    const prog = await cardsOf('Programação');
    expect(prog.map((c) => [c.code?.fields.language, c.code?.fields.mode])).toEqual([
      ['python', 'testes'],
      ['python', 'saida'],
      ['python', 'estrutura'],
      ['cpp', 'testes'],
      ['cpp', 'saida'],
    ]);
    expect(prog[0]!.code!.fields.answer).toBe('def soma_pares(xs):<br>    return sum(x for x in xs if x % 2 == 0)');
  });

  it("the app code types carry core's CODE_CSS (left-aligned, scrolling <pre>); other types don't", async () => {
    const ros = await cardsOf('ROS 2 — Revisão');
    const command = ros.find((c) => c.code?.appType)!;
    expect(command.questionHtml).toContain(CODE_CSS);
    expect(ros.find((c) => c.code === null)!.questionHtml).not.toContain(CODE_CSS);
    const prog = await cardsOf('Programação');
    expect(prog.every((c) => c.questionHtml.includes(CODE_CSS))).toBe(true);
  });

  it('mapping validation: the same error codes as the core', async () => {
    const nts = await mockClient.ankiNotetypes();
    const app = nts.find((n) => n.name === 'Código · Comando')!;
    const cloze = nts.find((n) => n.kind === 'cloze' && !n.appType)!;
    const f = { question: 'Frente', answer: 'Comando', notes: null };
    expect((await rejects(mockClient.codeMappingSet(app.id, f))).code).toBe('code_mapping_app_type');
    expect(
      (await rejects(mockClient.codeMappingSet(cloze.id, { question: 'Texto', answer: 'Verso extra', notes: null })))
        .code,
    ).toBe('code_mapping_cloze');
    expect((await rejects(mockClient.codeMappingSet(1, f))).code).toBe('not_found');
    expect((await rejects(mockClient.codeMappingSet(NT_USER_COMMAND, { ...f, answer: 'Nada' }))).code).toBe(
      'invalid_input',
    );
    expect((await rejects(mockClient.codeMappingSet(NT_USER_COMMAND, { ...f, answer: 'Frente' }))).code).toBe(
      'invalid_input',
    );
    const list = await mockClient.codeMappingSet(NT_USER_COMMAND, f);
    expect(list).toEqual([
      expect.objectContaining({
        notetypeId: NT_USER_COMMAND,
        notetypeName: 'ROS 2 · Digite o comando',
        role: 'code_command',
        fields: { question: 'Frente', answer: 'Comando', notes: null },
        noteCount: 3,
        missingFields: [],
      }),
    ]);
    expect(await mockClient.codeMappingSet(NT_USER_COMMAND, null)).toEqual([]);
  });

  it('note extra and "Contestar": the Aceitas field of app types, code_note_extra otherwise', async () => {
    await mockClient.codeMappingSet(NT_USER_COMMAND, { question: 'Frente', answer: 'Comando', notes: null });
    const rows = await mockClient.ankiBrowseRows(await mockClient.ankiSearch('', null));
    const ids = new Set(rows.map((r) => r.noteId));
    const fieldsOf = (id: number) => mockHandle.anki.noteFields(id);
    const app = [...ids].find((id) => fieldsOf(id)['Resposta'] === 'ros2 topic list')!;
    const user = [...ids].find((id) => fieldsOf(id)['Comando'] === 'ros2 pkg executables turtlesim')!;

    expect(await mockClient.codeAcceptAnswer(app, ' ros2  topic list ')).toMatchObject({ target: 'already' });
    expect(await mockClient.codeAcceptAnswer(app, 'ros2 topic list -t')).toEqual({
      target: 'field',
      accepted: ['ros2 topic list -t'],
    });
    expect(fieldsOf(app)['Aceitas']).toBe('ros2 topic list -t');
    expect(await mockClient.codeAcceptAnswer(app, 'ros2 topic list --show-types')).toMatchObject({
      accepted: ['ros2 topic list -t', 'ros2 topic list --show-types'],
    });

    expect(await mockClient.codeAcceptAnswer(user, 'ros2 pkg executables  turtlesim')).toMatchObject({
      target: 'already',
    });
    expect(await mockClient.codeAcceptAnswer(user, 'ros2 pkg executables turtlesim --full-path')).toEqual({
      target: 'extra',
      accepted: ['ros2 pkg executables turtlesim --full-path'],
    });
    expect(await mockClient.codeNoteExtraGet(user)).toEqual({
      noteId: user,
      accepted: ['ros2 pkg executables turtlesim --full-path'],
      requires: [],
    });
    expect(await mockClient.codeNoteExtraSet(user, [' a ', 'a', ''], ['sudo'])).toEqual({
      noteId: user,
      accepted: ['a'],
      requires: ['sudo'],
    });
    expect(
      (
        await rejects(
          mockClient.codeNoteExtraSet(
            user,
            Array.from({ length: 51 }, (_, i) => `x${i}`),
            [],
          ),
        )
      ).code,
    ).toBe('invalid_input');
    expect((await rejects(mockClient.codeAcceptAnswer(user, '  '))).code).toBe('invalid_input');
  });

  it('code_run_cpp simulation: PASS/FAIL, stdout, timeout, compile error, unavailable', async () => {
    const testes = (answer: string) => ({
      'main.cpp': `#include "check.hpp"\n#line 1 "setup.cpp"\n\n#line 1 "resposta.cpp"\n${answer}\n#line 1 "testes.cpp"\nint main() {\n    CHECK(quadrado(3) == 9);\n    CHECK(quadrado(-2) == 4);\n}`,
    });
    const ok = await mockClient.codeRunCpp(testes('int quadrado(int x) { return x * x; }'), '');
    expect(ok.run).toMatchObject({ exitCode: 0, stdout: 'PASS quadrado(3) == 9\nPASS quadrado(-2) == 4\n' });
    const wrong = await mockClient.codeRunCpp(testes('int quadrado(int x) { return x + x; }'), '');
    expect(wrong.run?.stdout).toContain('FAIL quadrado(3) == 9');
    expect(wrong.run?.exitCode).toBe(1);
    expect(
      (await mockClient.codeRunCpp(testes('int quadrado(int x) { return x * x; } // FAIL_ME'), '')).run?.exitCode,
    ).toBe(1);
    const hello = await mockClient.codeRunCpp(
      { 'main.cpp': '#include <iostream>\nint main() { std::cout << "Olá, mundo!\\n"; }' },
      '',
    );
    expect(hello.run?.stdout).toBe('Olá, mundo!\n');
    const loop = await mockClient.codeRunCpp({ 'main.cpp': 'int main() { while (true) {} }' }, '');
    expect(loop.run).toMatchObject({ timedOut: true, exitCode: null });
    const broken = await mockClient.codeRunCpp({ 'main.cpp': 'int main() { SYNTAX_ERROR }' }, '');
    expect(broken).toMatchObject({ compile: { ok: false }, run: null });
    const glued = await mockClient.codeRunCpp({ 'main.cpp': '#include <iostream>int main() {}' }, '');
    expect(glued).toMatchObject({ compile: { ok: false }, run: null });
    mockHandle.anki.setCppAvailable(false);
    expect((await rejects(mockClient.codeRunCpp({ 'main.cpp': '' }, ''))).code).toBe('code_cpp_unavailable');
    expect((await mockClient.codeStatus()).cppBackend).toBe('none');
  });

  it('settings: defaults, validation, the runner token follows its URL', async () => {
    expect(await mockClient.codeSettingsGet()).toEqual({
      suggestEasy: false,
      suggestEasySecs: 10,
      outputExact: false,
      cppBackend: 'auto',
      runnerUrl: null,
      runnerTokenSet: false,
    });
    expect((await rejects(mockClient.codeSettingsSet({ suggestEasySecs: 0 }))).code).toBe('invalid_input');
    expect((await rejects(mockClient.codeSettingsSet({ runnerUrl: 'ftp://x' }))).code).toBe('invalid_input');
    expect((await rejects(mockClient.codeSettingsSet({ runnerUrl: 'http://runner.example.com' }))).code).toBe(
      'invalid_input',
    );
    expect(await mockClient.codeRunnerTest()).toMatchObject({ ok: false });
    const s = await mockClient.codeSettingsSet({ runnerUrl: 'http://runner-proxy:8080', runnerToken: 'segredo' });
    expect(s).toMatchObject({ runnerUrl: 'http://runner-proxy:8080/', runnerTokenSet: true });
    expect(await mockClient.codeRunnerTest()).toMatchObject({ ok: true });
    expect(await mockClient.codeSettingsSet({ runnerUrl: 'https://runner.example.com/' })).toMatchObject({
      runnerTokenSet: false,
    });
  });

  it('Markdown import: the exact example of spec 11.7, previews and commits', async () => {
    const preview = await mockClient.codeImportMarkdown(importExample);
    expect(preview.errors).toEqual([]);
    expect(preview.items).toHaveLength(2);
    expect(preview.items[0]).toMatchObject({
      index: 0,
      title: 'Ver a transformação entre os frames world e turtle1',
      kind: 'command',
      language: 'bash',
      mode: null,
      tags: ['ros2', 'tf2'],
      errors: [],
      fields: {
        Pergunta: 'Ver a transformação entre os frames world e turtle1',
        Resposta: 'ros2 run tf2_ros tf2_echo world turtle1',
        Aceitas: 'ros2 run tf2_ros tf2_echo world turtle1 --ros-args -r __node:=eco',
        Observação: 'Imprime Translation e Rotation (quaternion) a cada atualização.',
      },
    });
    expect(preview.items[1]).toMatchObject({
      kind: 'program',
      language: 'python',
      mode: 'testes',
      tags: ['python'],
      fields: {
        Resposta: 'def soma_pares(xs):\n    return sum(x for x in xs if x % 2 == 0)',
        Testes: 'assert soma_pares([1, 2, 3, 4]) == 6\nassert soma_pares([]) == 0',
        Linguagem: 'python',
        Modo: 'testes',
      },
    });
    const deck = deckId('Programação');
    const res = await mockClient.codeImportCommit(importExample, deck, [0, 1, 7]);
    expect(res).toMatchObject({ added: 2, skipped: 1 });
    const fields = mockHandle.anki.noteFields(res.noteIds[1]!);
    expect(fields['Resposta']).toBe('def soma_pares(xs):<br>    return sum(x for x in xs if x % 2 == 0)');
    expect(fields['Modo']).toBe('testes');
  });

  it('Markdown import: per-item errors (no fence, unknown language, unclosed fence)', async () => {
    const text = [
      '### Sem bloco',
      'só texto',
      '',
      '### Linguagem estranha',
      '```rust',
      'fn main() {}',
      '```',
      '',
      '### Aberto',
      '```bash',
      'ls -la',
      '',
      '### Depois',
      '```sh',
      'pwd',
      '```',
    ].join('\n');
    const p = await mockClient.codeImportMarkdown(text);
    expect(p.items.map((i) => i.title)).toEqual(['Sem bloco', 'Linguagem estranha', 'Aberto', 'Depois']);
    expect(p.items[0]!.errors).toContain('Falta o bloco de código com a resposta (```bash, ```python…).');
    expect(p.items[0]!.warnings[0]).toMatch(/^Linha 2 ignorada/);
    expect(p.items[1]!.errors).toContain('Linguagem do bloco desconhecida: rust. Use bash, sh, ros2, python ou cpp.');
    expect(p.items[2]!.errors).toContain('Bloco de código sem fechamento (linha 10): feche-o com ```.');
    expect(p.items[2]!.fields['Resposta']).toBe('ls -la');
    expect(p.items[3]).toMatchObject({ kind: 'command', errors: [] });
    const res = await mockClient.codeImportCommit(text, deckId('ROS 2 — Revisão'), [0, 1, 2, 3]);
    expect(res).toMatchObject({ added: 1, skipped: 3 });
  });
});
