import { describe, expect, it } from 'vitest';
import { checkCommand } from '../src';
import { lexSegment } from '../src/lexer';
import { normalizeMessageType, sameMessageType } from '../src/ros';
import { parseSegment } from '../src/structure';

describe('step 11: ROS 2', () => {
  it('pkg/msg/Type ≡ pkg/Type (msg, srv, action)', () => {
    expect(normalizeMessageType('geometry_msgs/msg/Twist')).toBe('geometry_msgs/Twist');
    expect(normalizeMessageType('std_srvs/srv/Empty')).toBe('std_srvs/Empty');
    expect(normalizeMessageType('nav2_msgs/action/NavigateToPose')).toBe('nav2_msgs/NavigateToPose');
    expect(sameMessageType('a/msg/T', 'a/T')).toBe(true);
    expect(sameMessageType('a/msg/T', 'b/T')).toBe(false);
    expect(checkCommand({ expected: 'ros2 service call /clear std_srvs/srv/Empty', answer: 'ros2 service call /clear std_srvs/Empty' }).verdict).toBe('equivalent');
    expect(checkCommand({ expected: 'ros2 interface show geometry_msgs/msg/Twist', answer: 'ros2 interface show geometry_msgs/msg/Pose' }).verdict).toBe('wrong');
  });

  it('message type equivalence is ROS-only', () => {
    expect(checkCommand({ expected: 'cat a/msg/b', answer: 'cat a/b' }).verdict).toBe('wrong');
  });

  it('--ros-args is a multiset with its own aliases', () => {
    const e = 'ros2 run pkg exe --ros-args -r __node:=n -p a:=1 --params-file p.yaml --log-level debug -e /enc';
    const a = 'ros2 run pkg exe --ros-args --enclave /enc --log-level debug --param a:=1 --params-file p.yaml --remap __node:=n';
    expect(checkCommand({ expected: e, answer: a }).verdict).toBe('equivalent');
    expect(checkCommand({ expected: e, answer: a.replace('a:=1', 'a:=2') }).verdict).toBe('wrong');
    expect(checkCommand({ expected: 'ros2 run a b --ros-args -r x:=y', answer: 'ros2 run a b' }).diffs[0]?.message).toBe('faltou a seção `--ros-args`');
  });

  it('-r is --rate in topic pub and --remap inside --ros-args', () => {
    const l = lexSegment('ros2 topic pub -r 2 /t std_msgs/String "{}" --ros-args -r __node:=x');
    const p = parseSegment(l.words, l.redirects);
    expect(p.options.map((o) => o.name)).toEqual(['--rate']);
    expect(p.rosArgs?.map((o) => o.name)).toEqual(['--remap']);
    expect(checkCommand({ expected: 'ros2 topic pub -r 2 /t std_msgs/String "{}"', answer: 'ros2 topic pub --remap 2 /t std_msgs/String "{}"' }).verdict).toBe('wrong');
    expect(checkCommand({ expected: 'ros2 run a b --ros-args -r x:=y', answer: 'ros2 run a b --ros-args --rate x:=y' }).verdict).toBe('wrong');
  });

  it('--ros-args ends at --', () => {
    const l = lexSegment('prog --ros-args -p a:=1 -- positional');
    const p = parseSegment(l.words, l.redirects);
    expect(p.rosArgs?.map((o) => o.name)).toEqual(['--param']);
    expect(p.positionals.map((t) => t.text)).toEqual(['positional']);
  });

  it('launch arguments are a set', () => {
    expect(checkCommand({ expected: 'ros2 launch p l.py a:=1 b:=2', answer: 'ros2 launch p l.py b:=2 a:=1' }).verdict).toBe('equivalent');
    expect(checkCommand({ expected: 'ros2 launch p l.py a:=1', answer: 'ros2 launch l.py p a:=1' }).verdict).toBe('wrong');
  });
});
