// "Testar resposta de referência" (spec 11.7): before a code note of the app's types is saved, its Resposta must
// pass the checker against itself (Correto/Equivalente). Comando: each Aceitas line is also checked against the
// Resposta and reported. C++ that cannot run (no compiler, no runner) is reported as such, so the screen can offer
// "Salvar sem testar".
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
import { core } from '../../../lib/core/client';
import type { CodeCard, CodeCardFields, NotetypeInfo } from '../../../lib/core/types';
import {
  referenceFromCard,
  runCodeCheck,
  type CodeOutcome,
  type CodeReference,
  type Verdict,
} from '../../code-review/run';
import { codeToHtml, htmlToCode } from './codeField';

export const COMMAND_TYPE = 'Código · Comando';
export const PROGRAM_TYPE = 'Código · Programa';

/** Field names (app notetypes) of each `CodeCardFields` entry. */
const FIELD_NAMES: Record<keyof CodeCardFields, string> = {
  answer: 'Resposta',
  accepted: 'Aceitas',
  requires: 'Exige',
  notes: 'Observação',
  language: 'Linguagem',
  mode: 'Modo',
  initial: 'Inicial',
  setup: 'Setup',
  tests: 'Testes',
  input: 'Entrada',
  expectedOutput: 'SaidaEsperada',
};

/** Fields whose change invalidates a passed test (Observação, Inicial and the Pergunta do not). */
const GATED: (keyof CodeCardFields)[] = [
  'answer',
  'accepted',
  'requires',
  'language',
  'mode',
  'setup',
  'tests',
  'input',
  'expectedOutput',
];

/** The role of an app code notetype, or null for every other type (they have no reference test). */
export function codeRoleOf(notetype: Pick<NotetypeInfo, 'appType'> | null): 'command' | 'program' | null {
  if (notetype?.appType === COMMAND_TYPE) return 'command';
  if (notetype?.appType === PROGRAM_TYPE) return 'program';
  return null;
}

/** The reference of a note being written: field HTML by the app notetype's field names. */
export function referenceFromFields(role: 'command' | 'program', byName: Record<string, string>): CodeReference {
  const fields = Object.fromEntries(
    (Object.keys(FIELD_NAMES) as (keyof CodeCardFields)[]).map((k) => [k, byName[FIELD_NAMES[k]] ?? '']),
  ) as unknown as CodeCardFields;
  const card: CodeCard = {
    role,
    notetypeId: 0,
    appType: true,
    acceptedField: true,
    answerShowsNotes: false,
    answerShowsAnswer: false,
    fields,
  };
  return referenceFromCard(card, null);
}

/** Field HTML by name, from a note's fields in notetype order. */
export function fieldsByName(
  notetype: Pick<NotetypeInfo, 'fields'>,
  values: readonly string[],
): Record<string, string> {
  return Object.fromEntries(notetype.fields.map((f, i) => [f.name, values[i] ?? '']));
}

/** Plain-text values (as typed in a form) → field HTML by name. */
export function textFieldsToHtml(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, codeToHtml(v)]));
}

/** What changes the test: the decoded code fields (so equivalent HTML spellings do not reset it). */
export function gateKey(byName: Record<string, string>): string {
  return JSON.stringify(GATED.map((k) => htmlToCode(byName[FIELD_NAMES[k]] ?? '')));
}

export const passes = (v: Verdict) => v === 'correct' || v === 'equivalent';

export interface AcceptedLine {
  line: string;
  verdict: Verdict;
}

export type ReferenceResult =
  | { kind: 'done'; reference: CodeReference; outcome: CodeOutcome; accepted: AcceptedLine[]; passed: boolean }
  /** C++ could not run (no compiler, no runner): only "Salvar sem testar" is left. */
  | { kind: 'unavailable'; outcome: CodeOutcome; notice: string }
  | { kind: 'error'; message: string };

/** The C++ check fell back to `estrutura` because no compiler/runner exists (spec 11.5). */
function cppUnavailable(ref: CodeReference, outcome: CodeOutcome): boolean {
  return (
    ref.role === 'program' &&
    ref.language === 'cpp' &&
    ref.mode !== 'estrutura' &&
    outcome.modeUsed === 'estrutura' &&
    outcome.compile === null
  );
}

/** Runs the reference against itself (and each Aceitas line of a Comando against the Resposta). */
export async function testReference(ref: CodeReference, outputExact: boolean): Promise<ReferenceResult> {
  try {
    const outcome = await runCodeCheck(ref, ref.answer, { outputExact });
    if (cppUnavailable(ref, outcome)) {
      return { kind: 'unavailable', outcome, notice: outcome.notice ?? '' };
    }
    const accepted: AcceptedLine[] = [];
    if (ref.role === 'command') {
      const alone: CodeReference = { ...ref, accepted: [] };
      for (const line of ref.accepted) {
        const r = await runCodeCheck(alone, line, { outputExact });
        accepted.push({ line, verdict: r.verdict });
      }
    }
    return { kind: 'done', reference: ref, outcome, accepted, passed: passes(outcome.verdict) };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

export interface ReferenceGate {
  /** The note is of an app code type: saving waits for the test. */
  required: boolean;
  running: boolean;
  /** The last result, while it still matches the code fields (null after an edit). */
  result: ReferenceResult | null;
  /** A result that the last edit made stale. */
  stale: boolean;
  /** Saving is allowed (not required, passed, or "Salvar sem testar" chosen). */
  canSave: boolean;
  run(): Promise<void>;
  /** "Salvar sem testar" (only after `unavailable`). */
  allowUntested(): void;
  reset(): void;
}

/**
 * The reference-test gate of a code note being written. `byName` is the current field HTML by name (null while
 * loading); `active` false turns the gate off (e.g. an edit that did not touch a code field).
 */
export function useReferenceGate(
  role: 'command' | 'program' | null,
  byName: Record<string, string> | null,
  active = true,
): ReferenceGate {
  const settings = useQuery({ queryKey: ['code', 'settings'], queryFn: () => core.codeSettingsGet() });
  const [state, setState] = useState<{ key: string; result: ReferenceResult; untested: boolean } | null>(null);
  const [running, setRunning] = useState(false);
  const runId = useRef(0);
  const key = useMemo(() => (byName ? gateKey(byName) : ''), [byName]);
  const required = role !== null && active;
  const current = state && state.key === key ? state : null;
  const passed = current?.result.kind === 'done' && current.result.passed;

  const latest = useRef({ role, byName, key });
  latest.current = { role, byName, key };

  const run = useCallback(async () => {
    const { role: r, byName: fields, key: k } = latest.current;
    if (!r || !fields) return;
    const id = ++runId.current;
    setRunning(true);
    const result = await testReference(referenceFromFields(r, fields), settings.data?.outputExact ?? false);
    if (id !== runId.current) return;
    setState({ key: k, result, untested: false });
    setRunning(false);
  }, [settings.data?.outputExact]);

  return {
    required,
    running,
    result: current?.result ?? null,
    stale: !!state && !current,
    canSave: !required || passed || !!current?.untested,
    run,
    allowUntested: () =>
      setState((s) => (s && s.key === key && s.result.kind === 'unavailable' ? { ...s, untested: true } : s)),
    reset: () => {
      runId.current++;
      setRunning(false);
      setState(null);
    },
  };
}
