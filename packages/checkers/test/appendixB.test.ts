import { describe, expect, it } from 'vitest';
import { checkCommand } from '../src';
import { APPENDIX_B, PT_TO_VERDICT, resolveRow } from './appendixB.data';

describe('Apêndice B — casos do verificador de comandos', () => {
  it('has the 26 rows', () => {
    expect(APPENDIX_B.map((r) => r.n)).toEqual(Array.from({ length: 26 }, (_, k) => k + 1));
  });

  APPENDIX_B.forEach((row, index) => {
    const { canonical, requires } = resolveRow(APPENDIX_B, index);
    it(`#${row.n}: ${row.expected} — ${row.why}`, () => {
      const result = checkCommand({ expected: canonical, requires, answer: row.answer });
      expect(result.verdict, JSON.stringify(result, null, 1)).toBe(PT_TO_VERDICT[row.expected]);
      expect(result.matchedVariant).toBe(0);
    });
  });

  it('resolves idem and Exige', () => {
    expect(resolveRow(APPENDIX_B, 9)).toEqual({ canonical: 'sudo apt install ros-humble-turtlesim', requires: ['sudo'] });
    expect(resolveRow(APPENDIX_B, 12)).toEqual({ canonical: APPENDIX_B[10]?.canonical, requires: [] });
  });

  it('gives the spec messages', () => {
    const typo = checkCommand({ expected: 'ros2 run tf2_ros tf2_echo world turtle1', answer: 'ros2 run tf2_ros tf2_eco world turtle1' });
    expect(typo.diffs.map((d) => d.message)).toEqual(['erro de digitação em `tf2_eco` (esperado `tf2_echo`)']);
    const order = checkCommand({ expected: 'ros2 run tf2_ros tf2_echo world turtle1', answer: 'ros2 run tf2_ros tf2_echo turtle1 world' });
    expect(order.diffs).toEqual([{ kind: 'order', message: 'ordem dos argumentos' }]);
    const sudo = checkCommand({ expected: 'sudo apt install ros-humble-turtlesim', answer: 'apt install ros-humble-turtlesim' });
    expect(sudo.diffs).toEqual([{ kind: 'prefix', expected: 'sudo', message: 'faltou sudo' }]);
  });
});
