/**
 * Steps 13–14 (spec 11.3): run steps 1–12 against the Resposta and every
 * Aceitas variant, keep the best verdict, and classify.
 */
import { commonLength } from './diff';
import type { LexedSegment, Token } from './lexer';
import { lexSegment, whitespaceTokens } from './lexer';
import { MESSAGES } from './messages';
import { normalizeCommand } from './normalize';
import { isMultiPlaceholder, markPlaceholders, matchSequence, matchesWithPlaceholders, restorePlaceholders } from './placeholders';
import type { Operator } from './segments';
import { splitSegments } from './segments';
import type { Issue, ParsedSegment } from './structure';
import { compareSegments, deduceArity, parseSegment } from './structure';
import type { Arity } from './tools';
import type { CheckDiff, CheckResult, CommandCheckInput, Verdict } from './types';
import { VERDICT_ORDER } from './types';

const SCORE: Readonly<Record<Verdict, number>> = {
  correct: 1,
  equivalent: 0.9,
  almost: 0.6,
  wrong: 0,
  unverifiable: 0,
};

interface Prepared {
  normalized: string;
  operators: Operator[];
  segments: LexedSegment[];
}

function restoreToken(t: Token): Token {
  const out: Token = { text: restorePlaceholders(t.text), raw: restorePlaceholders(t.raw), quoted: t.quoted };
  if (t.redirect) out.redirect = { op: t.redirect.op, target: restorePlaceholders(t.redirect.target) };
  return out;
}

/** Steps 1–4. In the user's answer, placeholders are plain text (they only match in the canonical). */
function prepare(command: string, isAnswer: boolean): Prepared {
  const normalized = normalizeCommand(markPlaceholders(command));
  const split = splitSegments(normalized);
  let segments = split.segments.map(lexSegment);
  if (isAnswer) {
    segments = segments.map((s) => ({
      words: s.words.map(restoreToken),
      redirects: s.redirects.map(restoreToken),
      display: s.display.map(restoreToken),
    }));
  }
  return { normalized, operators: split.operators, segments };
}

function flatTokens(p: Prepared): string[] {
  const out: string[] = [];
  p.segments.forEach((s, k) => {
    for (const t of s.words) out.push(t.text);
    for (const t of s.redirects) out.push(t.text);
    const op = p.operators[k];
    if (op) out.push(op);
  });
  return out;
}

/** Step 14, first rule: same token sequence after steps 1–4 (placeholders matched). */
function identical(c: Prepared, a: Prepared): boolean {
  if (c.segments.length !== a.segments.length) return false;
  if (c.operators.some((op, k) => op !== a.operators[k])) return false;
  return c.segments.every((cs, k) => {
    const as = a.segments[k] as LexedSegment;
    return (
      matchSequence(cs.words, as.words, (e) => isMultiPlaceholder(e.text), (e, g) => matchesWithPlaceholders(e.text, g.text)) &&
      cs.redirects.length === as.redirects.length &&
      cs.redirects.every((e, j) => matchesWithPlaceholders(e.text, (as.redirects[j] as Token).text))
    );
  });
}

function partialScore(c: Prepared, a: Prepared): number {
  const ct = flatTokens(c);
  const at = flatTokens(a);
  const denom = Math.max(ct.length, at.length);
  if (denom === 0) return 0;
  return (commonLength(ct, at, matchesWithPlaceholders) / denom) * 0.5;
}

function hasSudo(segments: readonly ParsedSegment[]): boolean {
  return segments.some((s) => s.sudo !== null);
}

/**
 * Whether `item` (one or more whitespace-separated words) appears in `text` as whole tokens, in order and contiguous; the
 * last word may also match `word=value`. Never a raw substring: Exige `-y` is not satisfied by `python3-yaml`.
 */
function containsTokenRun(text: string, item: string): boolean {
  const words = whitespaceTokens(item).map((t) => t.text);
  const tokens = whitespaceTokens(text).map((t) => t.text);
  if (words.length === 0) return false;
  for (let i = 0; i + words.length <= tokens.length; i++) {
    const ok = words.every((w, j) => {
      const t = tokens[i + j]!;
      return t === w || (j === words.length - 1 && t.startsWith(`${w}=`));
    });
    if (ok) return true;
  }
  return false;
}

/** Required prefixes/flags (Exige) missing from the answer. */
function requirementIssues(requires: readonly string[], answer: readonly ParsedSegment[], a: Prepared): Issue[] {
  const issues: Issue[] = [];
  for (const raw of requires) {
    const item = normalizeCommand(raw);
    if (!item) continue;
    if (item === 'sudo') {
      if (!hasSudo(answer)) issues.push({ severity: 'heavy', diff: { kind: 'prefix', expected: 'sudo', message: MESSAGES.requiredSudo } });
      continue;
    }
    const present = answer.some((seg) => {
      const words = [seg.sudo, ...seg.env, seg.program, ...seg.path, ...seg.positionals].filter((t): t is Token => t !== null);
      if (words.some((t) => t.text === item || t.text.startsWith(`${item}=`))) return true;
      const canonicalName = seg.optionTable.get(item)?.names[0] ?? item;
      return [...seg.options, ...(seg.rosArgs ?? [])].some((o) => o.name === canonicalName || o.typed === item);
    });
    if (!present && !containsTokenRun(a.normalized, item)) {
      issues.push({ severity: 'heavy', diff: { kind: 'prefix', expected: item, message: MESSAGES.missingRequired(item) } });
    }
  }
  return issues;
}

function parseAll(p: Prepared, deduced: ReadonlyArray<ReadonlyMap<string, Arity>> | null, expected: readonly ParsedSegment[] | null): ParsedSegment[] {
  return p.segments.map((s, k) => {
    const d = deduced?.[k];
    const e = expected?.[k];
    return parseSegment(s.words, s.redirects, {
      ...(d ? { deduced: d } : {}),
      ...(e ? { expectedPath: e.pathNames } : {}),
      ...(e?.program ? { expectedProgram: e.program.text } : {}),
    });
  });
}

function structuralIssues(c: Prepared, a: Prepared, cParsed: readonly ParsedSegment[], aParsed: readonly ParsedSegment[], sudoRequired: boolean): Issue[] {
  const issues: Issue[] = [];
  const n = Math.min(c.segments.length, a.segments.length);
  const opCount = Math.min(c.operators.length, a.operators.length);
  for (let k = 0; k < opCount; k++) {
    const eo = c.operators[k] as Operator;
    const go = a.operators[k] as Operator;
    if (eo !== go) issues.push({ severity: 'heavy', diff: { kind: 'value', expected: eo, got: go, message: MESSAGES.operatorDiffers(eo, go) } });
  }
  for (let k = 0; k < n; k++) {
    issues.push(...compareSegments(cParsed[k] as ParsedSegment, aParsed[k] as ParsedSegment, { sudoRequired }));
  }
  const segText = (p: Prepared, k: number): string => restorePlaceholders((p.segments[k]?.display ?? []).map((t) => t.raw).join(' '));
  for (let k = n; k < c.segments.length; k++) {
    issues.push({ severity: 'heavy', diff: { kind: 'missing', expected: segText(c, k), message: MESSAGES.missingSegment(segText(c, k)) } });
  }
  for (let k = n; k < a.segments.length; k++) {
    issues.push({ severity: 'heavy', diff: { kind: 'extra', got: segText(a, k), message: MESSAGES.extraSegment(segText(a, k)) } });
  }
  return issues;
}

function weight(issues: readonly Issue[]): [number, number] {
  let h = 0;
  let l = 0;
  for (const i of issues) {
    if (i.severity === 'heavy') h++;
    else l++;
  }
  return [h, l];
}

function classify(issues: readonly Issue[]): Verdict {
  const [h, l] = weight(issues);
  if (h === 0 && l === 0) return 'equivalent';
  if (h === 0 && l === 1) return 'almost';
  return 'wrong';
}

interface VariantResult {
  verdict: Verdict;
  score: number;
  diffs: CheckDiff[];
  normalizedExpected: string;
}

function checkVariant(canonical: string, a: Prepared, requires: readonly string[]): VariantResult {
  const c = prepare(canonical, false);
  const normalizedExpected = restorePlaceholders(c.normalized);
  const sudoRequired = requires.some((r) => r.trim() === 'sudo');

  // Arity deduced from the canonical (generic tools). Both readings are tried; the best one wins.
  const plainC = parseAll(c, null, null);
  const deduced = plainC.map(deduceArity);
  const readings: Array<ReadonlyArray<ReadonlyMap<string, Arity>> | null> = deduced.some((d) => d.size > 0) ? [deduced, null] : [null];

  let best: Issue[] | null = null;
  let bestReq: Issue[] = [];
  for (const reading of readings) {
    const cParsed = reading ? parseAll(c, reading, null) : plainC;
    const aParsed = parseAll(a, reading, cParsed);
    const req = requirementIssues(requires, aParsed, a);
    // A missing required item is reported once, by the requirement check.
    const requiredMissing = new Set(req.map((r) => r.diff.expected));
    const structural = structuralIssues(c, a, cParsed, aParsed, sudoRequired).filter(
      (i) => !(i.diff.kind === 'missing' && requiredMissing.has(i.diff.expected)),
    );
    const issues = [...req, ...structural];
    if (!best || compareWeight(weight(issues), weight(best)) < 0) {
      best = issues;
      bestReq = req;
    }
  }
  const issues = best ?? [];
  if (bestReq.length === 0 && identical(c, a)) {
    return { verdict: 'correct', score: SCORE.correct, diffs: [], normalizedExpected };
  }
  const verdict = classify(issues);
  const score = verdict === 'wrong' ? partialScore(c, a) : SCORE[verdict];
  return { verdict, score, diffs: issues.map((i) => displayDiff(i.diff)), normalizedExpected };
}

/** Placeholder markers back to `<name>` in everything the user sees. */
function displayDiff(d: CheckDiff): CheckDiff {
  const out: CheckDiff = { kind: d.kind, message: restorePlaceholders(d.message) };
  if (d.expected !== undefined) out.expected = restorePlaceholders(d.expected);
  if (d.got !== undefined) out.got = restorePlaceholders(d.got);
  return out;
}

function compareWeight(x: [number, number], y: [number, number]): number {
  return x[0] !== y[0] ? x[0] - y[0] : x[1] - y[1];
}

function rank(v: Verdict): number {
  return VERDICT_ORDER.indexOf(v);
}

/** Last-resort comparison on whitespace tokens (never throws). */
function fallback(input: CommandCheckInput): CheckResult {
  const expected = String(input.expected ?? '');
  const answer = String(input.answer ?? '');
  const e = whitespaceTokens(expected).map((t) => t.text);
  const a = whitespaceTokens(answer).map((t) => t.text);
  const same = e.length === a.length && e.every((t, k) => t === a[k]);
  let score = 0;
  try {
    const denom = Math.max(e.length, a.length);
    score = denom === 0 ? 0 : (commonLength(e, a, (x, y) => x === y) / denom) * 0.5;
  } catch {
    score = 0;
  }
  return {
    verdict: e.length === 0 ? 'unverifiable' : same ? 'correct' : 'wrong',
    score: same ? 1 : score,
    diffs: same || e.length === 0 ? [] : [{ kind: 'value', message: MESSAGES.differentCommand }],
    normalizedExpected: e.join(' '),
    normalizedAnswer: a.join(' '),
    matchedVariant: 0,
  };
}

function checkCommandUnsafe(input: CommandCheckInput): CheckResult {
  const variants = [input.expected, ...(input.accepted ?? [])].map((v) => (typeof v === 'string' ? v : ''));
  const requires = (input.requires ?? []).filter((r): r is string => typeof r === 'string');
  const a = prepare(typeof input.answer === 'string' ? input.answer : '', true);
  const normalizedAnswer = restorePlaceholders(a.normalized);

  const usable = variants.map((v, k) => ({ v, k })).filter(({ v }) => normalizeCommand(v) !== '');
  if (usable.length === 0) {
    return { verdict: 'unverifiable', score: 0, diffs: [], normalizedExpected: '', normalizedAnswer, matchedVariant: 0 };
  }
  if (normalizedAnswer === '') {
    const first = usable[0] as { v: string; k: number };
    const normalizedExpected = restorePlaceholders(normalizeCommand(markPlaceholders(first.v)));
    return {
      verdict: 'wrong',
      score: 0,
      diffs: [{ kind: 'missing', expected: normalizedExpected, message: MESSAGES.emptyAnswer }],
      normalizedExpected,
      normalizedAnswer,
      matchedVariant: first.k,
    };
  }

  let best: (VariantResult & { k: number }) | null = null;
  for (const { v, k } of usable) {
    const r = checkVariant(v, a, requires);
    if (!best || rank(r.verdict) < rank(best.verdict) || (rank(r.verdict) === rank(best.verdict) && r.score > best.score)) {
      best = { ...r, k };
    }
    if (best.verdict === 'correct') break;
  }
  const b = best as VariantResult & { k: number };
  return {
    verdict: b.verdict,
    score: b.score,
    diffs: b.diffs,
    normalizedExpected: b.normalizedExpected,
    normalizedAnswer,
    matchedVariant: b.k,
  };
}

/**
 * Checks a shell / ROS 2 command against the canonical answer and the
 * accepted variants (spec 11.3). Never throws.
 */
export function checkCommand(input: CommandCheckInput): CheckResult {
  try {
    return checkCommandUnsafe(input);
  } catch {
    return fallback(input);
  }
}
