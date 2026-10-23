import type { ToolSpec } from './types';
import { flag, value, variadic } from './types';

const selection = [
  variadic('--packages-select'),
  variadic('--packages-up-to'),
  variadic('--packages-skip'),
  { names: ['--event-handlers'], arity: 'variadic', dashValues: true } as const,
];

/** `colcon` (spec 11.3). */
export const colcon: ToolSpec = {
  id: 'colcon',
  names: ['colcon'],
  combineShortFlags: false,
  root: {
    subcommands: {
      build: {
        options: [
          ...selection,
          flag('--symlink-install'),
          flag('--merge-install'),
          value('--parallel-workers'),
          { names: ['--cmake-args'], arity: 'variadic', dashValues: true },
        ],
      },
      test: {
        options: [
          ...selection,
          flag('--merge-install'),
          { names: ['--ctest-args'], arity: 'variadic', dashValues: true },
          { names: ['--pytest-args'], arity: 'variadic', dashValues: true },
        ],
      },
      'test-result': { options: [flag('--all'), flag('--verbose')] },
      list: { options: [flag('--names-only', '-n'), flag('--paths-only', '-p')] },
    },
  },
};
