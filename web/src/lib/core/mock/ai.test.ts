// The mock AI follows the core's rules (app/tests/ai.rs, app/tests/vocab.rs): consent per activation, the key shown
// by its last 4 characters, caps and confirmation before anything is "sent", the cache, the queue that never
// overwrites an edit.
import { beforeEach, describe, expect, it } from 'vitest';
import pricesToml from '../../../../../src-tauri/crates/core-ai/model-prices.toml?raw';
import { mockClient, mockHandle } from '../mock';
import { CoreError } from '../types';
import { mockAiFailNext, mockAiQueueStep, parsePrices } from './ai';

beforeEach(() => mockHandle.reset());

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as CoreError).code;
  }
  return 'ok';
}

async function claude() {
  await mockClient.aiSettingsSet({
    enrich: { provider: 'anthropic' },
    judge: { provider: 'anthropic' },
    consent: ['anthropic'],
  });
  await mockClient.aiKeySet('anthropic', 'test-key-anthropic-TEST');
}

const judge = {
  language: 'bash',
  question: 'Instalar o turtlesim',
  answer: 'sudo apt install ros-humble-turtlesim',
  accepted: [],
  userAnswer: 'apt install ros-humble-turtlesim',
  autoVerdict: 'almost',
  diffs: 'faltou sudo',
};

describe('mock AI', () => {
  it('reads the repository price table', () => {
    const models = parsePrices(pricesToml);
    expect(models.length).toBeGreaterThanOrEqual(8);
    const haiku = models.find((m) => m.id === 'claude-haiku-5-5')!;
    expect([haiku.input, haiku.output, haiku.role_default, haiku.tiers]).toEqual([0.1, 0.5, 'enrich', 1]);
  });

  it('is off by default and asks for consent at each activation', async () => {
    const s = await mockClient.aiSettingsGet();
    expect([s.enrich.provider, s.judge.provider, s.limitDayUsd, s.limitMonthUsd]).toEqual([null, null, 1, 5]);
    expect(await code(mockClient.aiSettingsSet({ enrich: { provider: 'anthropic' } }))).toBe('ai_consent_required');
    expect(
      await code(mockClient.aiSettingsSet({ enrich: { provider: 'gemini' }, consent: ['gemini'] })),
    ).toBe('ai_provider_unavailable');
    await claude();
    const on = await mockClient.aiSettingsGet();
    expect(on.enrich.effectiveModel).toBe('claude-haiku-5-5');
    expect(on.judge.effectiveModel).toBe('claude-sonnet-5-5');
    expect(on.providers[0]).toMatchObject({ hasKey: true, keySuffix: 'TEST' });
    expect(JSON.stringify(on)).not.toContain('anthropic-TEST');
    expect(await code(mockClient.aiSettingsSet({ enrich: { model: 'claude-x' } }))).toBe('ai_model_unpriced');
    await mockClient.aiPricesSet('anthropic', 'claude-x', { input: 1, output: 2 });
    expect((await mockClient.aiSettingsSet({ enrich: { model: 'claude-x' } })).enrich.effectiveModel).toBe('claude-x');
  });

  it('stops before sending: no key, confirmation, caps', async () => {
    expect(await code(mockClient.aiJudgeCode(judge, false))).toBe('ai_disabled');
    await claude();
    const r = await mockClient.aiJudgeCode(judge, false);
    expect([r.veredito, r.notaSugerida]).toEqual(['quase', 2]);
    await mockClient.aiSettingsSet({ confirmAboveUsd: 0.000_001 });
    expect(await code(mockClient.aiJudgeCode(judge, false))).toBe('ai_needs_confirmation');
    await mockClient.aiJudgeCode(judge, true);
    await mockClient.aiSettingsSet({ limitDayUsd: 0.001 });
    expect(await code(mockClient.aiJudgeCode(judge, true))).toBe('ai_limit_reached');
    const usage = await mockClient.aiUsage();
    expect(usage.day).toEqual([expect.objectContaining({ feature: 'judge', calls: 2 })]);
    expect(usage.state).toBe('blocked');
    await mockClient.aiKeyDelete('anthropic');
    expect(await code(mockClient.aiJudgeCode(judge, true))).toBe('ai_no_key');
  });

  it('defines from the cache the second time and reports scripted failures', async () => {
    await claude();
    const a = await mockClient.aiDefineWord('Windmill', null, 'The windmill  was finished.', false);
    expect([a.translation, a.cached]).toEqual(['moinho de vento', false]);
    const b = await mockClient.aiDefineWord('windmill', null, 'The windmill was finished.', false);
    expect(b.cached).toBe(true);
    mockAiFailNext('ai_offline', 'Sem conexão com o provedor de IA.');
    expect(await code(mockClient.aiDefineWord('pasture', 'n', 'The pasture.', false))).toBe('ai_offline');
  });

  it('proposes cards without saving them', async () => {
    await claude();
    const cards = await mockClient.aiCardsFromText('Pigs are clever. Windmills grind grain.', 'cloze', 5, false);
    expect(cards).toHaveLength(2);
    expect(Object.keys(cards[0]!.fields)).toEqual(['texto']);
    expect(cards[0]!.fields.texto).toContain('{{c1::');
    expect(await code(mockClient.aiCardsFromText('x', 'basico', 11, false))).toBe('invalid_input');
  });

  it('the queue fills only what the app wrote and pauses above the threshold', async () => {
    await claude();
    await mockClient.aiSettingsSet({ backgroundEnrich: true, backgroundPaused: true });
    const nt = (await mockClient.ankiNotetypes()).find((t) => t.name === 'Vocabulário · Livro')!;
    const names = nt.fields.map((f) => f.name);
    const add = async (word: string) =>
      (
        await mockClient.ankiNoteAdd({
          notetypeId: nt.id,
          deckId: 1,
          fields: names.map((n) => (n === 'Palavra' || n === 'Lema' ? word : '')),
          tags: [],
        })
      ).noteId;
    const pig = await add('pig');
    const learner = await add('learner');
    await mockClient.aiQueueAddNote(pig, 'All the pigs.');
    await mockClient.aiQueueAddNote(learner, 'A slow learner.');
    expect((await mockClient.aiQueueGet()).pending).toBe(2);
    // The user edits the translation before the queue runs.
    const note = await mockClient.ankiNoteGet(learner);
    const fields = [...note.fields];
    fields[names.indexOf('Tradução')] = 'estudante';
    await mockClient.ankiNoteUpdate(learner, fields, []);
    await mockClient.aiQueueSetPaused(false);
    expect(mockAiQueueStep()).toBe('worked');
    const pigNote = await mockClient.ankiNoteGet(pig);
    expect(pigNote.fields[names.indexOf('Tradução')]).toBe('porco');
    const learnerNote = await mockClient.ankiNoteGet(learner);
    expect(learnerNote.fields[names.indexOf('Tradução')]).toBe('estudante');
    expect(learnerNote.fields[names.indexOf('Definição')]).toBe('a person who is learning');
    expect((await mockClient.aiQueueGet()).pending).toBe(0);

    await mockClient.aiSettingsSet({ confirmAboveUsd: 0.000_001 });
    await mockClient.aiQueueAddNote(await add('windmill'), 'The windmill.');
    expect(mockAiQueueStep()).toBe('idle');
    const q = await mockClient.aiQueueGet();
    expect([q.paused, q.pending]).toEqual([true, 1]);
    expect(q.status).toContain('pausada');
  });
});
