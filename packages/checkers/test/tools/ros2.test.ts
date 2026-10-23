import { describe, expect, it } from 'vitest';
import { checkCommand } from '../../src';
import { ros2 } from '../../src/tools';
import { describeTool, parsePath } from './tableCases';

describeTool(ros2);

describe('ros2 specifics', () => {
  it('lists every spec subcommand', () => {
    expect(Object.keys(ros2.root.subcommands ?? {}).sort()).toEqual(
      ['action', 'bag', 'component', 'daemon', 'doctor', 'interface', 'launch', 'lifecycle', 'node', 'param', 'pkg', 'run', 'service', 'topic'].sort(),
    );
    const sub = (name: string): string[] => Object.keys(ros2.root.subcommands?.[name]?.subcommands ?? {});
    expect(sub('topic')).toEqual(expect.arrayContaining(['list', 'echo', 'pub', 'info', 'hz', 'bw', 'type', 'find']));
    expect(sub('node')).toEqual(expect.arrayContaining(['list', 'info']));
    expect(sub('service')).toEqual(expect.arrayContaining(['list', 'call', 'type', 'find']));
    expect(sub('param')).toEqual(expect.arrayContaining(['list', 'get', 'set', 'dump', 'load', 'delete']));
    expect(sub('action')).toEqual(expect.arrayContaining(['list', 'info', 'send_goal']));
    expect(sub('interface')).toEqual(expect.arrayContaining(['list', 'show', 'proto', 'package', 'packages']));
    expect(sub('pkg')).toEqual(expect.arrayContaining(['create', 'executables', 'list', 'prefix', 'xml']));
    expect(sub('bag')).toEqual(expect.arrayContaining(['record', 'play', 'info']));
  });

  it('topic pub: -r is --rate, -t is --times, --qos-profile takes a value', () => {
    const e = 'ros2 topic pub -r 5 -t 3 --qos-profile sensor_data /x std_msgs/msg/String "{data: a}"';
    expect(checkCommand({ expected: e, answer: 'ros2 topic pub /x std_msgs/String "{data: a}" --times 3 --rate 5 --qos-profile=sensor_data' }).verdict).toBe('equivalent');
    expect(checkCommand({ expected: e, answer: 'ros2 topic pub -r 6 -t 3 --qos-profile sensor_data /x std_msgs/msg/String "{data: a}"' }).verdict).toBe('wrong');
  });

  it('topic echo: --once is a flag, --field takes a value', () => {
    expect(checkCommand({ expected: 'ros2 topic echo --once /odom', answer: 'ros2 topic echo /odom --once' }).verdict).toBe('equivalent');
    expect(checkCommand({ expected: 'ros2 topic echo --field pose /odom', answer: 'ros2 topic echo /odom --field pose' }).verdict).toBe('equivalent');
    expect(checkCommand({ expected: 'ros2 topic echo --field pose /odom', answer: 'ros2 topic echo --field /odom pose' }).verdict).toBe('wrong');
  });

  it('pkg create: --dependencies is variadic, --node-name/--license take values', () => {
    const e = 'ros2 pkg create p --build-type ament_cmake --node-name n --license MIT --dependencies rclcpp std_msgs';
    expect(checkCommand({ expected: e, answer: 'ros2 pkg create --license MIT --dependencies std_msgs rclcpp --node-name n p --build-type ament_cmake' }).verdict).toBe('equivalent');
    expect(checkCommand({ expected: e, answer: 'ros2 pkg create p --build-type ament_cmake --node-name n --license MIT --dependencies rclcpp' }).verdict).toBe('wrong');
  });

  it('bag record: topics compared as a set', () => {
    expect(checkCommand({ expected: 'ros2 bag record /a /b -o out', answer: 'ros2 bag record -o out /b /a' }).verdict).toBe('equivalent');
    expect(checkCommand({ expected: 'ros2 bag record /a /b -o out', answer: 'ros2 bag record -o out /a' }).verdict).toBe('wrong');
  });

  it('a typo in a subcommand resolves to the expected path', () => {
    expect(checkCommand({ expected: 'ros2 topic echo /chatter', answer: 'ros2 topic eho /chatter' }).verdict).toBe('almost');
    expect(parsePath('ros2 topic echo /chatter')).toEqual(['topic', 'echo']);
  });
});
