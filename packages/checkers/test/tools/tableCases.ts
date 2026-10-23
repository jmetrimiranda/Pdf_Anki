/**
 * Generates one test per tool-table entry: every subcommand path is
 * recognised, and every option exercises its aliases, arity and harmlessness
 * with an equivalent pair and a non-equivalent pair.
 */
import { describe, expect, it } from 'vitest';
import { checkCommand } from '../../src';
import { lexSegment } from '../../src/lexer';
import { parseSegment } from '../../src/structure';
import type { CommandSpec, OptionSpec, ToolSpec } from '../../src/tools';

export interface NodeEntry {
  path: string[];
  node: CommandSpec;
}

export function walk(tool: ToolSpec): NodeEntry[] {
  const out: NodeEntry[] = [];
  const visit = (path: string[], node: CommandSpec): void => {
    out.push({ path, node });
    for (const [name, child] of Object.entries(node.subcommands ?? {})) visit([...path, name], child);
  };
  visit([], tool.root);
  return out;
}

/** Path completed down to a leaf (first child each time), so inherited options are tried on a real command. */
function leafPath(path: string[], node: CommandSpec): string[] {
  const out = [...path];
  let n = node;
  for (;;) {
    const first = Object.entries(n.subcommands ?? {})[0];
    if (!first) return out;
    out.push(first[0]);
    n = first[1];
  }
}

export function parsePath(command: string): string[] {
  const lexed = lexSegment(command);
  return parseSegment(lexed.words, lexed.redirects).pathNames;
}

const GOOD = new Set(['correct', 'equivalent']);

function expectEquivalent(expected: string, answer: string): void {
  const r = checkCommand({ expected, answer });
  expect(r.verdict, `${expected}  ⇔  ${answer}: ${JSON.stringify(r.diffs)}`).toBe('equivalent');
}

function expectNotEquivalent(expected: string, answer: string): void {
  const r = checkCommand({ expected, answer });
  expect(GOOD.has(r.verdict), `${expected}  ≠  ${answer}`).toBe(false);
}

/** `--opt=value` only for long options. */
function attached(name: string, value: string): string {
  return name.startsWith('--') ? `${name}=${value}` : `${name} ${value}`;
}

export function optionCases(base: string, opt: OptionSpec): void {
  const [main, ...aliases] = opt.names as [string, ...string[]];
  const label = `${base} ${opt.names.join('/')} (${opt.harmless ? 'harmless' : opt.arity})`;
  it(label, () => {
    if (opt.harmless) {
      for (const name of opt.names) {
        expectEquivalent(`${base} alpha`, `${base} alpha ${name}`);
        expectEquivalent(`${base} ${name} alpha`, `${base} alpha`);
        expectNotEquivalent(`${base} alpha`, `${base} zulu99 ${name}`);
      }
      return;
    }
    switch (opt.arity) {
      case 'flag':
        // The flag never eats the positional after it.
        expectEquivalent(`${base} ${main} alpha`, `${base} alpha ${main}`);
        for (const alias of aliases) expectEquivalent(`${base} ${main} alpha`, `${base} alpha ${alias}`);
        expectNotEquivalent(`${base} ${main} alpha`, `${base} alpha`);
        expectNotEquivalent(`${base} ${main} alpha`, `${base} ${main} zulu99`);
        break;
      case 'value':
        expectEquivalent(`${base} ${main} kilo alpha`, `${base} alpha ${attached(main, 'kilo')}`);
        for (const alias of aliases) expectEquivalent(`${base} ${main} kilo alpha`, `${base} alpha ${alias} kilo`);
        expectNotEquivalent(`${base} ${main} kilo alpha`, `${base} ${main} zulu99 alpha`);
        expectNotEquivalent(`${base} ${main} kilo alpha`, `${base} kilo alpha`);
        break;
      case 'variadic': {
        const [v1, v2] = opt.dashValues ? ['-Dkilo=1', '-Dlima=2'] : ['kilo', 'lima'];
        expectEquivalent(`${base} alpha ${main} ${v1} ${v2}`, `${base} alpha ${main} ${v2} ${v1}`);
        expectEquivalent(`${base} alpha ${main} ${v1} ${v2}`, `${base} ${main} ${v2} ${v1}`.replace(base, `${base} alpha`));
        if (main.startsWith('--')) expectEquivalent(`${base} alpha ${main} ${v1} ${v2}`, `${base} alpha ${main}=${v1} ${v2}`);
        for (const alias of aliases) expectEquivalent(`${base} alpha ${main} ${v1} ${v2}`, `${base} alpha ${alias} ${v2} ${v1}`);
        expectNotEquivalent(`${base} alpha ${main} ${v1} ${v2}`, `${base} alpha ${main} ${v1}`);
        break;
      }
    }
  });
}

/** One `it` per subcommand path and one per option entry of the tool. */
export function describeTool(tool: ToolSpec, program = tool.names[0] ?? tool.id): void {
  const nodes = walk(tool);
  if (nodes.some((e) => e.path.length > 0)) describePaths(tool, program, nodes);
  if (nodes.some((e) => (e.node.options ?? []).length > 0)) describeOptions(tool, program, nodes);
}

function describePaths(tool: ToolSpec, program: string, nodes: NodeEntry[]): void {
  describe(`${tool.id}: subcommand paths`, () => {
    for (const { path } of nodes) {
      if (path.length === 0) continue;
      it(`${program} ${path.join(' ')}`, () => {
        const cmd = `${program} ${path.join(' ')} alpha`;
        expect(parsePath(cmd)).toEqual(path);
        expect(checkCommand({ expected: cmd, answer: cmd }).verdict).toBe('correct');
        const parent = nodes.find((e) => e.path.join(' ') === path.slice(0, -1).join(' '))?.node;
        const sibling = Object.keys(parent?.subcommands ?? {}).find((s) => s !== path[path.length - 1]) ?? 'zzzzzz';
        const other = `${program} ${[...path.slice(0, -1), sibling].join(' ')} alpha`;
        expect(checkCommand({ expected: cmd, answer: other }).verdict).toBe('wrong');
      });
    }
  });
}

function describeOptions(tool: ToolSpec, program: string, nodes: NodeEntry[]): void {
  describe(`${tool.id}: options`, () => {
    for (const { path, node } of nodes) {
      const base = [program, ...leafPath(path, node)].join(' ');
      for (const opt of node.options ?? []) optionCases(base, opt);
    }
  });
}
