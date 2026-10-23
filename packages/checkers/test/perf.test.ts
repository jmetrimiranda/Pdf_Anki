import { describe, expect, it } from 'vitest';
import { checkCommand } from '../src';
import { APPENDIX_B, resolveRow } from './appendixB.data';

describe('performance', () => {
  it('1000 checks of Appendix B-sized commands in < 500 ms', () => {
    const cases = APPENDIX_B.map((row, k) => ({ ...resolveRow(APPENDIX_B, k), answer: row.answer }));
    // Warm-up (JIT), then measure.
    for (const c of cases) checkCommand({ expected: c.canonical, requires: c.requires, answer: c.answer });
    const start = performance.now();
    for (let k = 0; k < 1000; k++) {
      const c = cases[k % cases.length] as (typeof cases)[number];
      checkCommand({ expected: c.canonical, requires: c.requires, answer: c.answer });
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
  });
});
