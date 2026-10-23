/**
 * Spec Appendix B ("Casos de teste do verificador de comandos"), encoded
 * verbatim. `appendixB.parity.test.ts` checks this table against
 * docs/PROJETO.md cell by cell, so the two can't drift.
 *
 * Command cells hold the text inside the backticks of the doc (the escaped
 * `\|` of the Markdown table is a plain `|` here). `idem` is kept literally.
 */
import type { Verdict } from '../src';

export type ExpectedPt = 'Correto' | 'Equivalente' | 'Quase' | 'Errado';

export interface AppendixBRow {
  n: number;
  canonical: string;
  answer: string;
  expected: ExpectedPt;
  why: string;
}

export const APPENDIX_B: readonly AppendixBRow[] = [
  { n: 1, canonical: 'ros2 run tf2_ros tf2_echo world turtle1', answer: 'ros2 run tf2_ros tf2_echo world turtle1', expected: 'Correto', why: 'idêntico' },
  { n: 2, canonical: 'idem', answer: 'ros2  run tf2_ros   tf2_echo world turtle1 ', expected: 'Correto', why: 'espaços' },
  { n: 3, canonical: 'idem', answer: 'ros2 run tf2_ros tf2_echo turtle1 world', expected: 'Errado', why: 'ordem dos frames (posicionais)' },
  { n: 4, canonical: 'idem', answer: 'ros2 run tf2_ros tf2_eco world turtle1', expected: 'Quase', why: 'erro de digitação' },
  { n: 5, canonical: 'ros2 pkg executables turtlesim', answer: 'ros2 pkg executables turtlesim', expected: 'Correto', why: '—' },
  { n: 6, canonical: 'idem', answer: 'ros2 pkg list turtlesim', expected: 'Errado', why: 'subcomando diferente' },
  { n: 7, canonical: 'sudo apt install ros-humble-turtlesim', answer: 'sudo apt install -y ros-humble-turtlesim', expected: 'Equivalente', why: '`-y` é flag inofensiva' },
  { n: 8, canonical: 'idem', answer: 'sudo apt-get install ros-humble-turtlesim', expected: 'Equivalente', why: '`apt` ≡ `apt-get`' },
  { n: 9, canonical: 'idem', answer: 'apt install ros-humble-turtlesim', expected: 'Quase', why: 'faltou `sudo`' },
  { n: 10, canonical: 'idem (Exige = `sudo`)', answer: 'apt install ros-humble-turtlesim', expected: 'Errado', why: '`sudo` obrigatório' },
  {
    n: 11,
    canonical: 'ros2 topic pub --once /turtle1/cmd_vel geometry_msgs/msg/Twist "{linear: {x: 2.0}}"',
    answer: "ros2 topic pub /turtle1/cmd_vel geometry_msgs/msg/Twist '{linear: {x: 2}}' --once",
    expected: 'Equivalente',
    why: 'posição da flag, aspas, 2 ≡ 2.0',
  },
  { n: 12, canonical: 'idem', answer: 'ros2 topic pub -1 /turtle1/cmd_vel geometry_msgs/Twist "{linear: {x: 2.0}}"', expected: 'Equivalente', why: 'alias `-1`, tipo sem `/msg/`' },
  { n: 13, canonical: 'idem', answer: 'ros2 topic pub /turtle1/cmd_vel geometry_msgs/msg/Twist "{linear: {x: 3.0}}"', expected: 'Errado', why: 'valor diferente e faltou `--once`' },
  {
    n: 14,
    canonical: 'ros2 run turtlesim turtlesim_node --ros-args -r __node:=my_turtle',
    answer: 'ros2 run turtlesim turtlesim_node --ros-args --remap __node:=my_turtle',
    expected: 'Equivalente',
    why: 'alias de `--ros-args`',
  },
  {
    n: 15,
    canonical: 'ros2 run turtlesim turtlesim_node --ros-args -p background_r:=150 -r __node:=t',
    answer: 'ros2 run turtlesim turtlesim_node --ros-args -r __node:=t -p background_r:=150',
    expected: 'Equivalente',
    why: 'ros-args como multiconjunto',
  },
  { n: 16, canonical: 'ros2 run <pacote> <executavel>', answer: 'ros2 run demo_nodes_cpp talker', expected: 'Correto', why: 'placeholders' },
  {
    n: 17,
    canonical: 'colcon build --packages-select my_pkg --symlink-install',
    answer: 'colcon build --symlink-install --packages-select my_pkg',
    expected: 'Equivalente',
    why: 'ordem de opções',
  },
  {
    n: 18,
    canonical: 'ros2 pkg create meu_pkg --build-type ament_python --dependencies rclpy std_msgs',
    answer: 'ros2 pkg create --build-type ament_python meu_pkg --dependencies std_msgs rclpy',
    expected: 'Equivalente',
    why: 'posição da opção e variádica como conjunto',
  },
  { n: 19, canonical: 'ls -la', answer: 'ls -al', expected: 'Equivalente', why: 'flags curtas combinadas' },
  { n: 20, canonical: 'ls -la', answer: 'ls -l -a', expected: 'Equivalente', why: 'flags separadas' },
  { n: 21, canonical: 'source install/setup.bash', answer: '. install/setup.bash', expected: 'Equivalente', why: '`source` ≡ `.`' },
  { n: 22, canonical: 'ros2 topic echo /chatter', answer: 'ros2 topic echo /chatter | grep data', expected: 'Errado', why: 'segmento extra' },
  { n: 23, canonical: 'cat a.txt | grep foo', answer: 'cat a.txt | grep "foo"', expected: 'Correto', why: 'aspas não contam como diferença' },
  {
    n: 24,
    canonical: 'ros2 param set /turtlesim background_r 150',
    answer: 'ros2 param set /turtlesim background_r 150.0',
    expected: 'Errado',
    why: 'o tipo do parâmetro importa (int ≠ double); só normalizar números dentro de YAML',
  },
  { n: 25, canonical: 'ros2 bag record -a -o minha_gravacao', answer: 'ros2 bag record -o minha_gravacao -a', expected: 'Equivalente', why: 'ordem de opções' },
  { n: 26, canonical: 'ros2 topic echo /chatter > saida.txt', answer: 'ros2 topic echo /chatter >saida.txt', expected: 'Correto', why: 'redirecionamento tokenizado' },
];

export const PT_TO_VERDICT: Readonly<Record<ExpectedPt, Verdict>> = {
  Correto: 'correct',
  Equivalente: 'equivalent',
  Quase: 'almost',
  Errado: 'wrong',
};

/**
 * Resolves `idem` to the previous explicit canonical. `idem (Exige = `x`)`
 * also yields `requires: ['x']`.
 */
export function resolveRow(rows: readonly AppendixBRow[], index: number): { canonical: string; requires: string[] } {
  const row = rows[index];
  if (!row) throw new Error(`no row ${index}`);
  const idem = /^idem(?:\s*\(Exige = `([^`]+)`\))?$/.exec(row.canonical);
  if (!idem) return { canonical: row.canonical, requires: [] };
  for (let k = index - 1; k >= 0; k--) {
    const prev = rows[k] as AppendixBRow;
    if (!prev.canonical.startsWith('idem')) {
      return { canonical: prev.canonical, requires: idem[1] ? [idem[1]] : [] };
    }
  }
  throw new Error(`idem without a previous canonical at row ${row.n}`);
}
