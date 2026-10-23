/**
 * Step 11 (spec 11.3): ROS 2 specifics.
 * - Message types: `pkg/msg/Type` ≡ `pkg/Type` (also `srv` and `action`).
 * - The `--ros-args` section has its own table (`-r` is `--remap` there),
 *   compared as a multiset.
 */
import type { OptionSpec } from './tools/types';
import { flag, value } from './tools/types';

export const ROS_ARGS = '--ros-args';

/** Options inside `--ros-args … [--]`. */
export const ROS_ARGS_OPTIONS: readonly OptionSpec[] = [
  value('--remap', '-r'),
  value('--param', '-p'),
  value('--params-file'),
  value('--log-level'),
  value('--enclave', '-e'),
  value('--log-config-file'),
  flag('--enable-rosout-logs'),
  flag('--disable-rosout-logs'),
  flag('--enable-stdout-logs'),
  flag('--disable-stdout-logs'),
  flag('--enable-external-lib-logs'),
  flag('--disable-external-lib-logs'),
];

const MESSAGE_TYPE_RE = /^([A-Za-z_][A-Za-z0-9_]*)\/(?:msg|srv|action)\/([A-Za-z_][A-Za-z0-9_]*)$/;

/** `geometry_msgs/msg/Twist` → `geometry_msgs/Twist`; other text unchanged. */
export function normalizeMessageType(text: string): string {
  const m = MESSAGE_TYPE_RE.exec(text);
  return m ? `${m[1] ?? ''}/${m[2] ?? ''}` : text;
}

/** Both tokens name the same interface, once normalized. */
export function sameMessageType(a: string, b: string): boolean {
  return a !== b && normalizeMessageType(a) === normalizeMessageType(b) && /\//.test(a) && /\//.test(b);
}

/** Splits `name:=value` (ROS remaps, params and launch arguments). */
export function splitAssignment(text: string): { name: string; value: string } | null {
  const at = text.indexOf(':=');
  if (at <= 0) return null;
  return { name: text.slice(0, at), value: text.slice(at + 2) };
}

/** Splits `name:=value` or `NAME=value` (`export ROS_DOMAIN_ID=5`, `-std=c++20`). */
export function splitKeyValue(text: string): { name: string; value: string } | null {
  const ros = splitAssignment(text);
  if (ros) return ros;
  const m = /^(-{0,2}[A-Za-z_][\w.\-/]*)=(.*)$/s.exec(text);
  return m ? { name: m[1] ?? '', value: m[2] ?? '' } : null;
}
