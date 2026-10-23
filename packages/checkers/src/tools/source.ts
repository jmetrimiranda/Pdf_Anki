import type { ToolSpec } from './types';

/** `source x` ≡ `. x` (spec 11.3). */
export const source: ToolSpec = {
  id: 'source',
  names: ['source', '.'],
  combineShortFlags: false,
  root: {},
};
