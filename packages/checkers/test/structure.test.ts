import { describe, expect, it } from 'vitest';
import { checkCommand } from '../src';
import { lexSegment } from '../src/lexer';
import { parseSegment } from '../src/structure';

const parse = (s: string) => {
  const l = lexSegment(s);
  return parseSegment(l.words, l.redirects);
};

describe('steps 5–9: structure', () => {
  it('parses env, sudo, program, path, positionals and options', () => {
    const p = parse('A=1 sudo -E B=2 ros2 topic pub --once /x std_msgs/String "{data: a}" -r 2');
    expect(p.env.map((t) => t.text)).toEqual(['A=1', 'B=2']);
    expect(p.sudo?.text).toBe('sudo');
    expect(p.sudoArgs.map((t) => t.text)).toEqual(['-E']);
    expect(p.program?.text).toBe('ros2');
    expect(p.pathNames).toEqual(['topic', 'pub']);
    expect(p.positionals.map((t) => t.text)).toEqual(['/x', 'std_msgs/String', '{data: a}']);
    expect(p.options.map((o) => [o.name, o.values.map((v) => v.text)])).toEqual([
      ['--once', []],
      ['--rate', ['2']],
    ]);
  });

  it('VAR=val prefixes are a set', () => {
    expect(checkCommand({ expected: 'A=1 B=2 make', answer: 'B=2 A=1 make' }).verdict).toBe('equivalent');
    expect(checkCommand({ expected: 'A=1 B=2 make', answer: 'A=1 make' }).verdict).toBe('wrong');
    expect(checkCommand({ expected: 'A=1 make', answer: 'A=2 make' }).diffs[0]?.message).toBe('variável diferente: esperado `A=1`, veio `A=2`');
  });

  it('sudo as a prefix: missing or extra → almost', () => {
    const missing = checkCommand({ expected: 'sudo make install', answer: 'make install' });
    expect(missing.verdict).toBe('almost');
    expect(missing.diffs).toEqual([{ kind: 'prefix', expected: 'sudo', message: 'faltou sudo' }]);
    const extra = checkCommand({ expected: 'make install', answer: 'sudo make install' });
    expect(extra.verdict).toBe('almost');
    expect(extra.diffs[0]?.message).toBe('sudo a mais');
  });

  it('requires sudo: missing → wrong', () => {
    const r = checkCommand({ expected: 'sudo make install', requires: ['sudo'], answer: 'make install' });
    expect(r.verdict).toBe('wrong');
    expect(r.diffs).toEqual([{ kind: 'prefix', expected: 'sudo', message: 'faltou sudo (obrigatório)' }]);
    expect(checkCommand({ expected: 'sudo make install', requires: ['sudo'], answer: 'sudo make install' }).verdict).toBe('correct');
  });

  it('requires a flag: missing → wrong even for an identical Aceitas', () => {
    const r = checkCommand({ expected: 'colcon build --symlink-install', accepted: ['colcon build'], requires: ['--symlink-install'], answer: 'colcon build' });
    expect(r.verdict).toBe('wrong');
    expect(r.diffs.map((d) => d.message)).toEqual(['faltou `--symlink-install` (obrigatório)']);
    expect(checkCommand({ expected: 'apt install x', requires: ['-y'], answer: 'apt install --yes x' }).verdict).not.toBe('wrong');
  });

  it('requires a flag: a substring of another token does not count', () => {
    const apt = checkCommand({ expected: 'sudo apt install -y python3-yaml', requires: ['-y'], answer: 'sudo apt install python3-yaml' });
    expect(apt.verdict).toBe('wrong');
    expect(apt.diffs.map((d) => d.message)).toContain('faltou `-y` (obrigatório)');
    expect(checkCommand({ expected: 'sudo apt install -y python3-yaml', requires: ['-y'], answer: 'sudo apt install -y python3-yaml' }).verdict).toBe('correct');
    const ros = checkCommand({ expected: 'ros2 run demo_nodes_cpp talker -r', requires: ['-r'], answer: 'ros2 run demo_nodes_cpp talker --ros-args' });
    expect(ros.verdict).toBe('wrong');
    expect(ros.diffs.map((d) => d.message)).toContain('faltou `-r` (obrigatório)');
  });

  it('requires several words: matched as a contiguous run of whole tokens', () => {
    const expected = 'ros2 run turtlesim turtlesim_node --ros-args -r __node:=t';
    expect(checkCommand({ expected, requires: ['--ros-args -r'], answer: expected }).verdict).toBe('correct');
    expect(checkCommand({ expected, requires: ['--ros-args -r'], answer: 'ros2 run turtlesim turtlesim_node' }).verdict).toBe('wrong');
  });

  it('two light errors → wrong', () => {
    expect(checkCommand({ expected: 'sudo ros2 run tf2_ros tf2_echo world turtle1', answer: 'ros2 run tf2_ros tf2_eco world turtle1' }).verdict).toBe('wrong');
  });

  it('--opt=val ≡ --opt val', () => {
    expect(checkCommand({ expected: 'colcon build --parallel-workers 4', answer: 'colcon build --parallel-workers=4' }).verdict).toBe('equivalent');
  });

  it('positionals keep their order (message "ordem dos argumentos")', () => {
    const r = checkCommand({ expected: 'ros2 run tf2_ros tf2_echo world turtle1', answer: 'ros2 run tf2_ros tf2_echo turtle1 world' });
    expect(r.verdict).toBe('wrong');
    expect(r.diffs).toEqual([{ kind: 'order', message: 'ordem dos argumentos' }]);
  });

  it('reports missing, extra and different values', () => {
    const r = checkCommand({ expected: 'ros2 topic pub --once /x std_msgs/msg/Twist "{linear: {x: 2.0}}"', answer: 'ros2 topic pub /x std_msgs/msg/Twist "{linear: {x: 3.0}}"' });
    expect(r.diffs.map((d) => d.kind).sort()).toEqual(['missing', 'value']);
    expect(r.diffs.find((d) => d.kind === 'missing')?.message).toBe('faltou a opção `--once`');
    const extra = checkCommand({ expected: 'ls dir', answer: 'ls dir other' });
    expect(extra.diffs).toEqual([{ kind: 'extra', got: 'other', message: 'argumento a mais: `other`' }]);
  });

  it('redirect order and targets', () => {
    expect(checkCommand({ expected: 'cmd > a 2> b', answer: 'cmd 2> b > a' }).diffs[0]?.message).toBe('ordem dos redirecionamentos');
    expect(checkCommand({ expected: 'cmd > out.txt', answer: 'cmd > other.log' }).verdict).toBe('wrong');
    expect(checkCommand({ expected: 'cmd > out.txt', answer: 'cmd >> out.txt' }).verdict).toBe('wrong');
    expect(checkCommand({ expected: 'cmd > output.txt', answer: 'cmd > outptu.txt' }).verdict).toBe('almost');
    expect(checkCommand({ expected: '> out.txt cmd', answer: 'cmd > out.txt' }).verdict).toBe('correct');
  });

  it('a different program is wrong; a typo in the program is almost', () => {
    expect(checkCommand({ expected: 'colcon build', answer: 'catkin build' }).verdict).toBe('wrong');
    expect(checkCommand({ expected: 'colcon build', answer: 'colcn build' }).verdict).toBe('almost');
  });
});

describe('NAME=value tokens', () => {
  it('compare by value: numbers are never typos', () => {
    expect(checkCommand({ expected: 'export ROS_DOMAIN_ID=5', answer: 'export ROS_DOMAIN_ID=7' }).verdict).toBe('wrong');
    expect(checkCommand({ expected: 'export ROS_DOMAIN_ID=5', answer: 'export ROS_DOMAIN_ID=5' }).verdict).toBe('correct');
    expect(checkCommand({ expected: 'export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp', answer: 'export RMW_IMPLEMENTATION=rmw_cyclonedds_cp' }).verdict).toBe('almost');
  });

  it('-std=c++20 vs -std=c++17 is a different value, not a typo', () => {
    const r = checkCommand({ expected: 'g++ -std=c++20 main.cpp', answer: 'g++ -std=c++17 main.cpp' });
    expect(r.verdict).toBe('wrong');
    expect(r.diffs).toEqual([{ kind: 'value', expected: '-std=c++20', got: '-std=c++17', message: 'valor diferente em `-std`: esperado `c++20`, veio `c++17`' }]);
  });

  it('a redirect with another operator is one diff', () => {
    const r = checkCommand({ expected: 'echo x >> ~/.bashrc', answer: 'echo x > ~/.bashrc' });
    expect(r.diffs).toEqual([{ kind: 'value', expected: '>> ~/.bashrc', got: '> ~/.bashrc', message: 'redirecionamento diferente: esperado `>> ~/.bashrc`, veio `> ~/.bashrc`' }]);
  });
});
