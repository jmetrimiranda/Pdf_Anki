import type { ToolSpec } from './types';

/**
 * Unknown tools: no subcommand table, arity deduced from the canonical answer,
 * no combined-flag expansion (`g++ -Wall`, `-std=c++20` stay one option).
 */
export function genericTool(program: string): ToolSpec {
  return { id: program, names: [program], combineShortFlags: false, root: {} };
}
