import { describe, expect, it } from 'vitest';
import { checkCommand } from '../src';
import { lexSegment } from '../src/lexer';
import {
  isMultiPlaceholder,
  markPlaceholders,
  matchSequence,
  matchesWithPlaceholders,
  restorePlaceholders,
} from '../src/placeholders';

describe('step 1: placeholders', () => {
  it('replaces <nome> and <nome...> before lexing (no redirection)', () => {
    const marked = markPlaceholders('ros2 run <pacote> <executavel>');
    expect(marked).not.toContain('<');
    const lexed = lexSegment(marked);
    expect(lexed.redirects).toEqual([]);
    expect(lexed.words).toHaveLength(4);
    expect(restorePlaceholders(marked)).toBe('ros2 run <pacote> <executavel>');
  });

  it('accepts letters, digits, _ . - (unicode too) and the ... suffix', () => {
    for (const p of ['<nó>', '<arquivo.txt>', '<my-pkg_2>', '<args...>']) {
      const marked = markPlaceholders(p);
      expect(marked).not.toContain('<');
      expect(restorePlaceholders(marked)).toBe(p);
    }
    expect(isMultiPlaceholder(markPlaceholders('<args...>'))).toBe(true);
    expect(isMultiPlaceholder(markPlaceholders('<args>'))).toBe(false);
  });

  it('leaves real redirections alone', () => {
    expect(markPlaceholders('sort < in.txt > out.txt')).toBe('sort < in.txt > out.txt');
    expect(markPlaceholders('a <b c>')).toBe('a <b c>');
  });

  it('a single placeholder matches exactly one token', () => {
    expect(checkCommand({ expected: 'ros2 run <pacote> <executavel>', answer: 'ros2 run demo_nodes_cpp talker' }).verdict).toBe('correct');
    expect(checkCommand({ expected: 'ros2 run <pacote> <executavel>', answer: 'ros2 run demo_nodes_cpp' }).verdict).toBe('wrong');
    expect(checkCommand({ expected: 'ros2 run <pacote> <executavel>', answer: 'ros2 run a b c' }).verdict).toBe('wrong');
  });

  it('<nome...> matches one or more tokens', () => {
    const expected = 'ros2 pkg create <nome> --dependencies <deps...>';
    expect(checkCommand({ expected, answer: 'ros2 pkg create p --dependencies rclpy' }).verdict).toBe('correct');
    expect(checkCommand({ expected, answer: 'ros2 pkg create p --dependencies rclpy std_msgs geometry_msgs' }).verdict).toBe('correct');
    expect(checkCommand({ expected: 'rm <arquivos...>', answer: 'rm a b c' }).verdict).toBe('correct');
    expect(checkCommand({ expected: 'rm <arquivos...>', answer: 'rm' }).verdict).toBe('wrong');
    expect(checkCommand({ expected: 'echo <x...> end', answer: 'echo a b end' }).verdict).toBe('correct');
  });

  it('a placeholder inside a token matches the surrounding text', () => {
    expect(matchesWithPlaceholders(markPlaceholders('--name=<x>'), '--name=foo')).toBe(true);
    expect(matchesWithPlaceholders(markPlaceholders('--name=<x>'), '--other=foo')).toBe(false);
    expect(checkCommand({ expected: 'ros2 run a b --ros-args -r __node:=<nome>', answer: 'ros2 run a b --ros-args -r __node:=eco' }).verdict).toBe('correct');
  });

  it('placeholders in the answer are plain text', () => {
    expect(checkCommand({ expected: 'cat a', answer: 'cat <a>' }).verdict).toBe('wrong');
    expect(checkCommand({ expected: 'ros2 run <pkg> <exe>', answer: 'ros2 run <pkg> <exe>' }).verdict).toBe('correct');
  });

  it('matchSequence handles several multi markers', () => {
    const multi = (s: string): boolean => s === '*';
    const eq = (a: string, b: string): boolean => a === b;
    expect(matchSequence(['a', '*', 'b', '*'], ['a', 'x', 'y', 'b', 'z'], multi, eq)).toBe(true);
    expect(matchSequence(['a', '*', 'b', '*'], ['a', 'b', 'z'], multi, eq)).toBe(false);
  });
});

describe('placeholders in messages', () => {
  it('diffs show <name>, never the internal markers', () => {
    const r = checkCommand({ expected: 'rm <arquivos...>', answer: 'rm' });
    expect(r.diffs).toEqual([{ kind: 'missing', expected: '<arquivos...>', message: 'faltou o argumento `<arquivos...>`' }]);
    const s = checkCommand({ expected: 'cp <origem> <destino> extra', answer: 'cp a' });
    expect(JSON.stringify(s)).not.toMatch(/[\uE000-\uE002]/u);
  });
});
