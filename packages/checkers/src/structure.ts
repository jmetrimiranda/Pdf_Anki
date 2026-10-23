/**
 * Steps 5–9 (spec 11.3): parse a lexed segment into env + sudo + program +
 * subcommand path + positionals + options (+ the `--ros-args` section) +
 * redirects, and compare two parsed segments.
 */
import { MESSAGES } from './messages';
import type { CheckDiff } from './types';
import type { Token } from './lexer';
import { diffSequences } from './diff';
import { hasMarker, isMultiPlaceholder, matchSequence, matchesWithPlaceholders } from './placeholders';
import { ROS_ARGS, ROS_ARGS_OPTIONS, sameMessageType, splitAssignment, splitKeyValue } from './ros';
import { isKnownTool, toolFor } from './tools';
import type { Arity, CommandSpec, OptionSpec, PositionalMode, ToolSpec } from './tools';
import { isTypo } from './typo';
import { yamlEqual } from './yaml';

export interface ParsedOption {
  /** Canonical name (first name in the table), or the name as typed for unknown options. */
  name: string;
  /** Name as typed. */
  typed: string;
  arity: Arity;
  values: Token[];
  harmless: boolean;
}

export interface ParsedSegment {
  env: Token[];
  sudo: Token | null;
  sudoArgs: Token[];
  program: Token | null;
  tool: ToolSpec;
  /** Subcommand tokens as typed. */
  path: Token[];
  /** Subcommand names as resolved in the table (a typo resolves to the expected name). */
  pathNames: string[];
  positionals: Token[];
  positionalMode: PositionalMode;
  options: ParsedOption[];
  /** `null` when there's no `--ros-args` section. */
  rosArgs: ParsedOption[] | null;
  redirects: Token[];
  /** Unknown options and whether a value-looking token follows them (arity deduction). */
  unknownOptions: Array<{ key: string; followedByValue: boolean }>;
  /** Option lookup at the final path (for `requires`). */
  optionTable: ReadonlyMap<string, OptionSpec>;
}

export interface ParseContext {
  /** Arity deduced from the canonical answer for options the tables don't know (`ros:` prefix inside `--ros-args`). */
  deduced?: ReadonlyMap<string, Arity>;
  /** The canonical subcommand path, so a typo in the answer's subcommand still resolves. */
  expectedPath?: readonly string[];
  /** The canonical program, so a typo in the answer's program still selects the right table. */
  expectedProgram?: string;
}

const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const NEGATIVE_NUMBER_RE = /^-\d+(?:\.\d+)?$/;
const SUDO_VALUE_OPTIONS = new Set(['-u', '-g', '-C', '-D', '-p', '-r', '-t', '-U', '-h']);

const tableCache = new WeakMap<CommandSpec, Map<string, OptionSpec>>();

function optionTable(chain: readonly CommandSpec[]): Map<string, OptionSpec> {
  const last = chain[chain.length - 1];
  const cached = last ? tableCache.get(last) : undefined;
  if (cached) return cached;
  const map = new Map<string, OptionSpec>();
  for (const node of chain) for (const opt of node.options ?? []) for (const n of opt.names) map.set(n, opt);
  if (last) tableCache.set(last, map);
  return map;
}

const rosArgsTable = new Map<string, OptionSpec>();
for (const opt of ROS_ARGS_OPTIONS) for (const n of opt.names) rosArgsTable.set(n, opt);

function optionName(text: string): string {
  if (!text.startsWith('--')) return text;
  const eq = text.indexOf('=');
  return eq > 0 ? text.slice(0, eq) : text;
}

function looksLikeOption(text: string, table: ReadonlyMap<string, OptionSpec>): boolean {
  if (text.length < 2 || !text.startsWith('-') || text === '--') return false;
  if (hasMarker(text)) return false;
  if (NEGATIVE_NUMBER_RE.test(text)) return table.has(text);
  return true;
}

function hasOwn(record: Readonly<Record<string, CommandSpec>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function inlineToken(word: Token, at: number): Token {
  const rawAt = word.raw.indexOf('=');
  return {
    text: word.text.slice(at + 1),
    raw: rawAt >= 0 ? word.raw.slice(rawAt + 1) : word.text.slice(at + 1),
    quoted: word.quoted,
  };
}

/** Parses one segment. `words` are the lexed words, `redirects` the lexed redirects. */
export function parseSegment(words: readonly Token[], redirects: readonly Token[], ctx: ParseContext = {}): ParsedSegment {
  const deduced = ctx.deduced ?? new Map<string, Arity>();
  let i = 0;
  const env: Token[] = [];
  const sudoArgs: Token[] = [];
  let sudo: Token | null = null;
  const at = (k: number): Token | undefined => words[k];

  while (at(i) && ENV_RE.test(at(i)?.text ?? '')) env.push(at(i++) as Token);
  if (at(i)?.text === 'sudo') {
    sudo = at(i++) as Token;
    while (at(i) && (at(i)?.text ?? '').startsWith('-') && at(i)?.text !== '--') {
      const opt = at(i++) as Token;
      sudoArgs.push(opt);
      if (SUDO_VALUE_OPTIONS.has(opt.text) && at(i)) sudoArgs.push(at(i++) as Token);
    }
    if (at(i)?.text === '--') i++;
    while (at(i) && ENV_RE.test(at(i)?.text ?? '')) env.push(at(i++) as Token);
  }
  const program = at(i) ?? null;
  if (program) i++;
  const programText = program?.text ?? '';
  const tool =
    ctx.expectedProgram !== undefined && !isKnownTool(programText) && isTypo(programText, ctx.expectedProgram)
      ? toolFor(ctx.expectedProgram)
      : toolFor(programText);

  const chain: CommandSpec[] = [tool.root];
  let table = optionTable(chain);
  let node: CommandSpec = tool.root;
  const path: Token[] = [];
  const pathNames: string[] = [];
  const positionals: Token[] = [];
  const options: ParsedOption[] = [];
  let rosArgs: ParsedOption[] | null = null;
  const unknownOptions: ParsedSegment['unknownOptions'] = [];
  let pathOpen = true;
  let afterDoubleDash = false;

  const isValueLike = (t: Token | undefined): boolean =>
    t !== undefined && t.text !== '--' && t.text !== ROS_ARGS && !(t.text.startsWith('-') && t.text.length > 1 && !NEGATIVE_NUMBER_RE.test(t.text));

  /** Reads an option at `words[i]` using `tbl`; returns the parsed options and advances `i`. */
  const readOption = (tbl: ReadonlyMap<string, OptionSpec>, combine: boolean, keyPrefix: string): ParsedOption[] => {
    const word = at(i++) as Token;
    const text = word.text;
    let name = optionName(text);
    let inline: Token | null = name !== text ? inlineToken(word, name.length) : null;
    const spec = tbl.get(name);

    if (!spec && !text.startsWith('--') && combine && /^-[A-Za-z0-9]{2,}$/.test(text)) {
      // Combined short flags: `-la` → `-l -a`; a value-taking letter takes the rest or the next token.
      const out: ParsedOption[] = [];
      const letters = text.slice(1);
      for (let k = 0; k < letters.length; k++) {
        const short = `-${letters.charAt(k)}`;
        const s = tbl.get(short);
        const arity = s?.arity ?? 'flag';
        const opt: ParsedOption = { name: s?.names[0] ?? short, typed: short, arity, values: [], harmless: s?.harmless ?? false };
        out.push(opt);
        if (arity !== 'flag') {
          const rest = letters.slice(k + 1);
          if (rest) {
            opt.values.push({ text: rest, raw: rest, quoted: false });
          } else if (at(i)) {
            opt.values.push(at(i++) as Token);
          }
          break;
        }
      }
      return out;
    }
    if (!spec && !text.startsWith('--')) {
      // Single-dash unknown options stay whole (`-std=c++20`, `-Wall`).
      name = text;
      inline = null;
    }
    let arity: Arity = spec?.arity ?? deduced.get(keyPrefix + name) ?? 'flag';
    if (!spec) unknownOptions.push({ key: keyPrefix + name, followedByValue: inline === null && isValueLike(at(i)) });
    if (inline && arity === 'flag') arity = 'value';
    const opt: ParsedOption = {
      name: spec?.names[0] ?? name,
      typed: name,
      arity,
      values: [],
      harmless: spec?.harmless ?? false,
    };
    if (inline) opt.values.push(inline);
    if (arity === 'value' && !inline) {
      const next = at(i);
      if (next && next.text !== '--' && next.text !== ROS_ARGS) {
        opt.values.push(next);
        i++;
      }
    } else if (arity === 'variadic') {
      for (;;) {
        const next = at(i);
        if (!next || next.text === '--' || next.text === ROS_ARGS) break;
        if (tbl.has(optionName(next.text))) break;
        if (next.text.startsWith('-') && next.text.length > 1 && !(spec?.dashValues ?? false) && !NEGATIVE_NUMBER_RE.test(next.text)) break;
        // `--cmake-args -DX --foo`: long options still end the list.
        if (next.text.startsWith('--')) break;
        opt.values.push(next);
        i++;
      }
    }
    return [opt];
  };

  while (i < words.length) {
    const word = at(i) as Token;
    const text = word.text;
    if (!afterDoubleDash && text === ROS_ARGS) {
      i++;
      rosArgs ??= [];
      while (i < words.length && at(i)?.text !== '--') {
        if (looksLikeOption(at(i)?.text ?? '', rosArgsTable)) {
          rosArgs.push(...readOption(rosArgsTable, false, 'ros:'));
        } else {
          const t = at(i++) as Token;
          rosArgs.push({ name: t.text, typed: t.text, arity: 'flag', values: [], harmless: false });
        }
      }
      if (at(i)?.text === '--') i++;
      continue;
    }
    if (!afterDoubleDash && text === '--') {
      afterDoubleDash = true;
      pathOpen = false;
      i++;
      continue;
    }
    if (!afterDoubleDash && looksLikeOption(text, table)) {
      options.push(...readOption(table, tool.combineShortFlags, ''));
      continue;
    }
    if (pathOpen && node.subcommands) {
      const subs = node.subcommands;
      let name: string | null = hasOwn(subs, text) ? text : null;
      if (name === null && ctx.expectedPath) {
        const expected = ctx.expectedPath[pathNames.length];
        if (expected !== undefined && hasOwn(subs, expected) && isTypo(text, expected)) name = expected;
      }
      if (name !== null) {
        const child = subs[name] as CommandSpec;
        path.push(word);
        pathNames.push(name);
        node = child;
        chain.push(child);
        table = optionTable(chain);
        i++;
        continue;
      }
    }
    pathOpen = false;
    positionals.push(word);
    i++;
  }

  return {
    env,
    sudo,
    sudoArgs,
    program,
    tool,
    path,
    pathNames,
    positionals,
    positionalMode: node.positionals ?? 'ordered',
    options,
    rosArgs,
    redirects: [...redirects],
    unknownOptions,
    optionTable: table,
  };
}

/** Arity deduced from a canonical segment: unknown options followed by a value-looking token take it. */
export function deduceArity(parsed: ParsedSegment): Map<string, Arity> {
  const map = new Map<string, Arity>();
  for (const u of parsed.unknownOptions) if (u.followedByValue) map.set(u.key, 'value');
  return map;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export type Severity = 'light' | 'heavy';
export interface Issue {
  severity: Severity;
  diff: CheckDiff;
}

const heavy = (diff: CheckDiff): Issue => ({ severity: 'heavy', diff });
const light = (diff: CheckDiff): Issue => ({ severity: 'light', diff });

export type ValueMatch = 'same' | 'equiv' | 'typo' | 'diff';

const NUMBER_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/** Compares an expected value token with a got one (steps 9–12). */
export function compareValue(expected: string, got: string, ros: boolean): ValueMatch {
  if (matchesWithPlaceholders(expected, got)) return 'same';
  if (hasMarker(expected)) return 'diff';
  const y = yamlEqual(expected, got);
  if (y === true) return 'equiv';
  if (y === false) return 'diff';
  if (ros && sameMessageType(expected, got)) return 'equiv';
  const ea = splitKeyValue(expected);
  const ga = splitKeyValue(got);
  if (ea && ga && ea.name === ga.name && expected.includes(':=') === got.includes(':=')) {
    // `name:=value` / `NAME=value`: the value decides (YAML, message type, number, typo).
    const inner = compareValue(ea.value, ga.value, ros);
    return inner === 'same' ? 'equiv' : inner;
  }
  if (NUMBER_RE.test(expected) && NUMBER_RE.test(got)) return 'diff';
  return isTypo(got, expected) ? 'typo' : 'diff';
}

const matches = (m: ValueMatch): boolean => m === 'same' || m === 'equiv';

function shown(t: Token): string {
  return t.raw || t.text;
}

/** Positionals in order (step 8). */
function compareOrdered(exp: readonly Token[], got: readonly Token[], ros: boolean): Issue[] {
  const eq = (e: Token, g: Token): boolean => matches(compareValue(e.text, g.text, ros));
  if (matchSequence(exp, got, (e) => isMultiPlaceholder(e.text), eq)) return [];
  if (exp.length === got.length) {
    const left = unmatchedMultiset(exp, got, eq);
    if (left.exp.length === 0 && left.got.length === 0) {
      return [heavy({ kind: 'order', message: MESSAGES.argumentOrder })];
    }
  }
  const issues: Issue[] = [];
  const steps = diffSequences(exp, got, eq);
  let dels: Token[] = [];
  let ins: Token[] = [];
  const flush = (): void => {
    // A `<name...>` left in a gap absorbs the inserted tokens of that gap, or is missing.
    const multis = dels.filter((d) => isMultiPlaceholder(d.text));
    if (multis.length > 0) {
      dels = dels.filter((d) => !isMultiPlaceholder(d.text));
      if (ins.length > dels.length) ins = ins.slice(0, dels.length);
      else for (const d of multis) issues.push(heavy({ kind: 'missing', expected: shown(d), message: MESSAGES.missingArgument(shown(d)) }));
    }
    const pairs = Math.min(dels.length, ins.length);
    for (let k = 0; k < pairs; k++) issues.push(valueIssue(dels[k] as Token, ins[k] as Token, ros));
    for (const d of dels.slice(pairs)) issues.push(heavy({ kind: 'missing', expected: shown(d), message: MESSAGES.missingArgument(shown(d)) }));
    for (const g of ins.slice(pairs)) issues.push(heavy({ kind: 'extra', got: shown(g), message: MESSAGES.extraArgument(shown(g)) }));
    dels = [];
    ins = [];
  };
  for (const s of steps) {
    if (s.op === 'equal') flush();
    else if (s.op === 'delete') dels.push(exp[s.a] as Token);
    else ins.push(got[s.b] as Token);
  }
  flush();
  return issues;
}

function valueIssue(e: Token, g: Token, ros: boolean): Issue {
  const m = compareValue(e.text, g.text, ros);
  if (m === 'typo') return light({ kind: 'typo', expected: shown(e), got: shown(g), message: MESSAGES.typo(shown(g), shown(e)) });
  return heavy({ kind: 'value', expected: shown(e), got: shown(g), message: MESSAGES.argumentValue(shown(e), shown(g)) });
}

/** Greedy multiset matching; `<name...>` markers absorb whatever is left (one or more). */
function unmatchedMultiset<E, G>(
  exp: readonly E[],
  got: readonly G[],
  eq: (e: E, g: G) => boolean,
  isMulti: (e: E) => boolean = () => false,
): { exp: E[]; got: G[] } {
  const used = new Array<boolean>(got.length).fill(false);
  const leftExp: E[] = [];
  let multis = 0;
  for (const e of exp) {
    if (isMulti(e)) {
      multis++;
      continue;
    }
    const k = got.findIndex((g, idx) => !used[idx] && eq(e, g));
    if (k >= 0) used[k] = true;
    else leftExp.push(e);
  }
  let leftGot = got.filter((_, idx) => !used[idx]);
  if (multis > 0 && leftGot.length >= multis) leftGot = [];
  return { exp: leftExp, got: leftGot };
}

function compareSet(exp: readonly Token[], got: readonly Token[], ros: boolean): Issue[] {
  const left = unmatchedMultiset(
    exp,
    got,
    (e, g) => matches(compareValue(e.text, g.text, ros)),
    (e) => isMultiPlaceholder(e.text),
  );
  return pairLeftovers(left.exp, left.got, ros, MESSAGES.missingArgument, MESSAGES.extraArgument);
}

function pairLeftovers(
  exp: Token[],
  got: Token[],
  ros: boolean,
  missing: (s: string) => string,
  extra: (s: string) => string,
): Issue[] {
  const issues: Issue[] = [];
  const restGot = [...got];
  for (const e of exp) {
    const k = restGot.findIndex((g) => compareValue(e.text, g.text, ros) === 'typo');
    if (k >= 0) {
      const g = restGot.splice(k, 1)[0] as Token;
      issues.push(light({ kind: 'typo', expected: shown(e), got: shown(g), message: MESSAGES.typo(shown(g), shown(e)) }));
    } else {
      issues.push(heavy({ kind: 'missing', expected: shown(e), message: missing(shown(e)) }));
    }
  }
  for (const g of restGot) issues.push(heavy({ kind: 'extra', got: shown(g), message: extra(shown(g)) }));
  return issues;
}

/** Launch mode: `name:=value` arguments as a set, the rest in order. */
function compareLaunch(exp: readonly Token[], got: readonly Token[], ros: boolean): Issue[] {
  const isArg = (t: Token): boolean => splitAssignment(t.text) !== null;
  return [
    ...compareOrdered(exp.filter((t) => !isArg(t)), got.filter((t) => !isArg(t)), ros),
    ...compareSet(exp.filter(isArg), got.filter(isArg), ros),
  ];
}

function optionLabel(o: ParsedOption): string {
  return [o.typed, ...o.values.map(shown)].join(' ');
}

function valuesMatch(e: ParsedOption, g: ParsedOption, ros: boolean): boolean {
  const eq = (x: Token, y: Token): boolean => matches(compareValue(x.text, y.text, ros));
  if (e.arity === 'variadic' || g.arity === 'variadic') {
    const left = unmatchedMultiset(e.values, g.values, eq, (x) => isMultiPlaceholder(x.text));
    return left.exp.length === 0 && left.got.length === 0;
  }
  return matchSequence(e.values, g.values, (x) => isMultiPlaceholder(x.text), eq);
}

/** Options as a multiset (step 7); harmless flags are ignored. */
function compareOptions(expAll: readonly ParsedOption[], gotAll: readonly ParsedOption[], ros: boolean): Issue[] {
  const exp = expAll.filter((o) => !o.harmless);
  const got = gotAll.filter((o) => !o.harmless);
  const left = unmatchedMultiset(exp, got, (e, g) => e.name === g.name && valuesMatch(e, g, ros));
  const issues: Issue[] = [];
  const restGot = [...left.got];
  const restExp: ParsedOption[] = [];
  for (const e of left.exp) {
    const k = restGot.findIndex((g) => g.name === e.name);
    if (k < 0) {
      restExp.push(e);
      continue;
    }
    const g = restGot.splice(k, 1)[0] as ParsedOption;
    const ev = e.values.map(shown).join(' ');
    const gv = g.values.map(shown).join(' ');
    const single = e.values.length === 1 && g.values.length === 1;
    if (single && compareValue((e.values[0] as Token).text, (g.values[0] as Token).text, ros) === 'typo') {
      issues.push(light({ kind: 'typo', expected: ev, got: gv, message: MESSAGES.typo(gv, ev) }));
    } else {
      issues.push(heavy({ kind: 'value', expected: ev, got: gv, message: MESSAGES.optionValue(e.typed, ev, gv) }));
    }
  }
  for (const e of restExp) {
    const k = restGot.findIndex((g) => valuesMatch(e, g, ros) && compareValue(e.typed, g.typed, ros) !== 'diff');
    const g = k >= 0 ? restGot[k] : undefined;
    const kv = g ? null : restGot.findIndex((o) => sameKey(e.typed, o.typed));
    if (g && compareValue(e.typed, g.typed, ros) === 'typo') {
      restGot.splice(k, 1);
      issues.push(light({ kind: 'typo', expected: e.typed, got: g.typed, message: MESSAGES.typo(g.typed, e.typed) }));
    } else if (g) {
      // Equivalent spelling of the same option (`-std=c++20` written another way).
      restGot.splice(k, 1);
    } else if (kv !== null && kv >= 0) {
      // `-std=c++20` vs `-std=c++17`: same option, different value.
      const o = restGot.splice(kv, 1)[0] as ParsedOption;
      const ev = splitKeyValue(e.typed)?.value ?? e.typed;
      const gv = splitKeyValue(o.typed)?.value ?? o.typed;
      issues.push(heavy({ kind: 'value', expected: e.typed, got: o.typed, message: MESSAGES.optionValue(splitKeyValue(e.typed)?.name ?? e.typed, ev, gv) }));
    } else {
      issues.push(heavy({ kind: 'missing', expected: optionLabel(e), message: MESSAGES.missingOption(optionLabel(e)) }));
    }
  }
  for (const g of restGot) issues.push(heavy({ kind: 'extra', got: optionLabel(g), message: MESSAGES.extraOption(optionLabel(g)) }));
  return issues;
}

function sameKey(a: string, b: string): boolean {
  const x = splitKeyValue(a);
  const y = splitKeyValue(b);
  return x !== null && y !== null && x.name === y.name;
}

function compareEnv(exp: readonly Token[], got: readonly Token[]): Issue[] {
  const left = unmatchedMultiset(exp, got, (e, g) => matchesWithPlaceholders(e.text, g.text));
  const issues: Issue[] = [];
  const restGot = [...left.got];
  const varName = (t: Token): string => t.text.slice(0, t.text.indexOf('='));
  for (const e of left.exp) {
    const k = restGot.findIndex((g) => varName(g) === varName(e));
    if (k >= 0) {
      const g = restGot.splice(k, 1)[0] as Token;
      issues.push(heavy({ kind: 'value', expected: shown(e), got: shown(g), message: MESSAGES.variableValue(shown(e), shown(g)) }));
    } else {
      issues.push(heavy({ kind: 'missing', expected: shown(e), message: MESSAGES.missingVariable(shown(e)) }));
    }
  }
  for (const g of restGot) issues.push(heavy({ kind: 'extra', got: shown(g), message: MESSAGES.extraVariable(shown(g)) }));
  return issues;
}

function redirectMatch(e: Token, g: Token, ros: boolean): ValueMatch {
  const er = e.redirect;
  const gr = g.redirect;
  if (!er || !gr) return matchesWithPlaceholders(e.text, g.text) ? 'same' : 'diff';
  if (er.op !== gr.op) return 'diff';
  if (er.target === '' && gr.target === '') return 'same';
  return compareValue(er.target, gr.target, ros);
}

/** Redirects in order, with their targets (step 4). */
function compareRedirects(exp: readonly Token[], got: readonly Token[], ros: boolean): Issue[] {
  const eq = (e: Token, g: Token): boolean => matches(redirectMatch(e, g, ros));
  if (exp.length === got.length && exp.every((e, k) => eq(e, got[k] as Token))) return [];
  const left = unmatchedMultiset(exp, got, eq);
  if (exp.length === got.length && left.exp.length === 0) {
    return [heavy({ kind: 'order', message: MESSAGES.redirectOrder })];
  }
  const issues: Issue[] = [];
  const restGot = [...left.got];
  for (const e of left.exp) {
    const k = restGot.findIndex((g) => redirectMatch(e, g, ros) === 'typo');
    if (k >= 0) {
      const g = restGot.splice(k, 1)[0] as Token;
      issues.push(light({ kind: 'typo', expected: e.text, got: g.text, message: MESSAGES.typo(g.redirect?.target ?? g.text, e.redirect?.target ?? e.text) }));
      continue;
    }
    const j = restGot.findIndex(
      (g) => g.redirect?.op === e.redirect?.op || (g.redirect !== undefined && g.redirect.target === e.redirect?.target),
    );
    if (j >= 0) {
      const g = restGot.splice(j, 1)[0] as Token;
      issues.push(heavy({ kind: 'value', expected: e.text, got: g.text, message: MESSAGES.redirectDiffers(e.text, g.text) }));
      continue;
    }
    issues.push(heavy({ kind: 'missing', expected: e.text, message: MESSAGES.missingRedirect(e.text) }));
  }
  for (const g of restGot) issues.push(heavy({ kind: 'extra', got: g.text, message: MESSAGES.extraRedirect(g.text) }));
  return issues;
}

export interface CompareOptions {
  /** `sudo` is required (Exige): a missing sudo is reported by the requirement check, not here. */
  sudoRequired: boolean;
}

/** Compares two parsed segments; an empty list means equivalent. */
export function compareSegments(exp: ParsedSegment, got: ParsedSegment, opts: CompareOptions): Issue[] {
  const issues: Issue[] = [];
  const ros = exp.tool.rosTypes === true;

  // Step 5: env as a set, sudo as a prefix.
  issues.push(...compareEnv(exp.env, got.env));
  if (exp.sudo && !got.sudo) {
    if (!opts.sudoRequired) issues.push(light({ kind: 'prefix', expected: 'sudo', message: MESSAGES.missingSudo }));
  } else if (!exp.sudo && got.sudo) {
    issues.push(light({ kind: 'prefix', got: 'sudo', message: MESSAGES.extraSudo }));
  }
  if (exp.sudo && got.sudo) {
    const left = unmatchedMultiset(exp.sudoArgs, got.sudoArgs, (e, g) => e.text === g.text);
    for (const e of left.exp) issues.push(heavy({ kind: 'missing', expected: e.text, message: MESSAGES.missingOption(e.text) }));
    for (const g of left.got) issues.push(heavy({ kind: 'extra', got: g.text, message: MESSAGES.extraOption(g.text) }));
  }

  // Step 6: program and subcommand path.
  if (!exp.program || !got.program) {
    if (exp.program) issues.push(heavy({ kind: 'missing', expected: shown(exp.program), message: MESSAGES.missingProgram(shown(exp.program)) }));
    else if (got.program) issues.push(heavy({ kind: 'extra', got: shown(got.program), message: MESSAGES.extraArgument(shown(got.program)) }));
    return issues;
  }
  const ep = exp.program.text;
  const gp = got.program.text;
  if (!matchesWithPlaceholders(ep, gp) && !(exp.tool === got.tool && exp.tool.names.includes(gp))) {
    if (isTypo(gp, ep)) {
      issues.push(light({ kind: 'typo', expected: ep, got: gp, message: MESSAGES.typo(gp, ep) }));
    } else {
      issues.push(heavy({ kind: 'value', expected: ep, got: gp, message: MESSAGES.programDiffers(ep, gp) }));
      return issues;
    }
  }
  const depth = Math.max(exp.pathNames.length, got.pathNames.length);
  for (let k = 0; k < depth; k++) {
    const en = exp.pathNames[k];
    const gn = got.pathNames[k];
    const gt = got.path[k];
    if (en !== undefined && gn !== undefined && gt) {
      if (en !== gn) {
        issues.push(heavy({ kind: 'value', expected: en, got: shown(gt), message: MESSAGES.subcommandDiffers(en, shown(gt)) }));
        return issues;
      }
      if (gt.text !== en) issues.push(light({ kind: 'typo', expected: en, got: gt.text, message: MESSAGES.typo(gt.text, en) }));
    } else if (en !== undefined) {
      const instead = got.positionals[0];
      issues.push(
        instead
          ? heavy({ kind: 'value', expected: en, got: shown(instead), message: MESSAGES.subcommandDiffers(en, shown(instead)) })
          : heavy({ kind: 'missing', expected: en, message: MESSAGES.missingSubcommand(en) }),
      );
      return issues;
    } else if (gt) {
      issues.push(heavy({ kind: 'extra', got: shown(gt), message: MESSAGES.extraSubcommand(shown(gt)) }));
      return issues;
    }
  }

  // Steps 7–12: positionals, options, ros-args, redirects.
  switch (exp.positionalMode) {
    case 'set':
      issues.push(...compareSet(exp.positionals, got.positionals, ros));
      break;
    case 'launch':
      issues.push(...compareLaunch(exp.positionals, got.positionals, ros));
      break;
    default:
      issues.push(...compareOrdered(exp.positionals, got.positionals, ros));
  }
  issues.push(...compareOptions(exp.options, got.options, ros));
  if (exp.rosArgs && got.rosArgs) {
    issues.push(...compareOptions(exp.rosArgs, got.rosArgs, ros));
  } else if (exp.rosArgs && exp.rosArgs.length > 0) {
    issues.push(heavy({ kind: 'missing', expected: ROS_ARGS, message: MESSAGES.missingRosArgs }));
  } else if (got.rosArgs && got.rosArgs.length > 0) {
    issues.push(heavy({ kind: 'extra', got: ROS_ARGS, message: MESSAGES.extraRosArgs }));
  }
  issues.push(...compareRedirects(exp.redirects, got.redirects, ros));
  return issues;
}
