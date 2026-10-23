import { apt } from './apt';
import { colcon } from './colcon';
import { common } from './common';
import { genericTool } from './generic';
import { ros2 } from './ros2';
import { source } from './source';
import type { ToolSpec } from './types';

export type { Arity, CommandSpec, OptionSpec, PositionalMode, ToolSpec } from './types';
export { apt, colcon, common, genericTool, ros2, source };

/** Every known tool table. */
export const TOOLS: readonly ToolSpec[] = [ros2, apt, colcon, source, ...common];

const byName = new Map<string, ToolSpec>();
for (const tool of TOOLS) for (const name of tool.names) byName.set(name, tool);

/** The table selected by the program name (spec 11.1: chosen by the program, no "tool" field). */
export function toolFor(program: string): ToolSpec {
  return byName.get(program) ?? genericTool(program);
}

export function isKnownTool(program: string): boolean {
  return byName.has(program);
}
