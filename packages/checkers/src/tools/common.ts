import type { CommandSpec, ToolSpec } from './types';
import { flag, value } from './types';

const util = (name: string, root: CommandSpec): ToolSpec => ({
  id: name,
  names: [name],
  combineShortFlags: true,
  root,
});

/**
 * Common utilities whose short flags combine (`-la` ≡ `-l -a`, spec 11.3).
 * Only these tools expand combined short flags.
 */
export const common: readonly ToolSpec[] = [
  util('ls', {
    options: [
      flag('-l'),
      flag('--all', '-a'),
      flag('--almost-all', '-A'),
      flag('--human-readable', '-h'),
      flag('--recursive', '-R'),
      flag('-t'),
      flag('--reverse', '-r'),
      flag('-S'),
      flag('-1'),
    ],
  }),
  util('rm', {
    options: [flag('--recursive', '-r', '-R'), flag('--force', '-f'), flag('-i'), flag('--dir', '-d'), flag('--verbose', '-v')],
  }),
  util('cp', {
    options: [
      flag('--recursive', '-r', '-R'),
      flag('--force', '-f'),
      flag('--archive', '-a'),
      flag('--verbose', '-v'),
      flag('--interactive', '-i'),
      flag('--preserve', '-p'),
      value('--target-directory', '-t'),
    ],
  }),
  util('mv', {
    options: [
      flag('--force', '-f'),
      flag('--interactive', '-i'),
      flag('--verbose', '-v'),
      flag('--no-clobber', '-n'),
      value('--target-directory', '-t'),
    ],
  }),
  util('mkdir', { options: [flag('--parents', '-p'), flag('--verbose', '-v'), value('--mode', '-m')] }),
  util('grep', {
    options: [
      flag('--ignore-case', '-i'),
      flag('--recursive', '-r'),
      flag('--line-number', '-n'),
      flag('--invert-match', '-v'),
      flag('--extended-regexp', '-E'),
      flag('--count', '-c'),
      flag('--files-with-matches', '-l'),
      flag('--word-regexp', '-w'),
      value('--regexp', '-e'),
      value('--max-count', '-m'),
    ],
  }),
  util('tar', {
    options: [
      flag('--extract', '-x'),
      flag('--create', '-c'),
      flag('--list', '-t'),
      flag('--gzip', '-z'),
      flag('--bzip2', '-j'),
      flag('--xz', '-J'),
      flag('--verbose', '-v'),
      value('--file', '-f'),
      value('--directory', '-C'),
    ],
  }),
  util('chmod', { options: [flag('--recursive', '-R'), flag('--verbose', '-v')] }),
  util('ps', { options: [flag('-e', '-A'), flag('-f'), flag('-l'), value('-u'), value('-p'), value('-o')] }),
  util('du', {
    options: [flag('--summarize', '-s'), flag('--human-readable', '-h'), flag('--all', '-a'), flag('--total', '-c'), value('--max-depth', '-d')],
  }),
  util('df', { options: [flag('--human-readable', '-h'), flag('--print-type', '-T'), flag('--all', '-a')] }),
];
