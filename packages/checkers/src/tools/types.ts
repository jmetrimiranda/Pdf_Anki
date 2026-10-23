/** Tool tables (spec 11.3): subcommand paths, option arity, aliases and harmless flags. */

/** `flag`: no value. `value`: exactly one value. `variadic`: one or more values, compared as a set. */
export type Arity = 'flag' | 'value' | 'variadic';

export interface OptionSpec {
  /** First name is the canonical one; the others are aliases (`-y` ≡ `--yes`). */
  readonly names: readonly string[];
  readonly arity: Arity;
  /** Presence or absence doesn't change the meaning (`apt -y`). */
  readonly harmless?: boolean;
  /** Variadic values may start with `-` (e.g. `colcon build --cmake-args -DX=1`). */
  readonly dashValues?: boolean;
}

/**
 * How positionals are compared: `ordered` (default, spec step 8), `set`
 * (e.g. `ros2 bag record` topics) or `launch` (ordered, except `name:=value`
 * launch arguments, compared as a set).
 */
export type PositionalMode = 'ordered' | 'set' | 'launch';

export interface CommandSpec {
  /** Options valid at this level and below. */
  readonly options?: readonly OptionSpec[];
  readonly subcommands?: Readonly<Record<string, CommandSpec>>;
  readonly positionals?: PositionalMode;
}

export interface ToolSpec {
  /** Canonical program name (`apt-get` → `apt`, `.` → `source`). */
  readonly id: string;
  /** Program names that select this table; using another name of the list is an equivalence. */
  readonly names: readonly string[];
  /** `-la` ≡ `-l -a` (only the common utilities). */
  readonly combineShortFlags: boolean;
  /** ROS 2 rules: message types `pkg/msg/Type` ≡ `pkg/Type`. */
  readonly rosTypes?: boolean;
  readonly root: CommandSpec;
}

export const flag = (...names: string[]): OptionSpec => ({ names, arity: 'flag' });
export const value = (...names: string[]): OptionSpec => ({ names, arity: 'value' });
export const variadic = (...names: string[]): OptionSpec => ({ names, arity: 'variadic' });
export const harmless = (...names: string[]): OptionSpec => ({ names, arity: 'flag', harmless: true });
