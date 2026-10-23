/**
 * @leitor/checkers — code-card checkers (spec 11.3). Pure TypeScript, no DOM,
 * no Node APIs, no runtime dependencies: runs in the webview and in Node.
 */
export type { CheckDiff, CheckResult, CommandCheckInput, Verdict } from './types';
export { VERDICT_ORDER } from './types';
export { checkCommand } from './check';
export type { DiffOp } from './diff';
export { lineDiff, tokenDiff } from './diff';
export { shellTokens } from './display';
export type { CheckLine } from './output';
export { compareOutput, parseCheckLines } from './output';
export { cppStructureTokens, sameCppStructure } from './cpp';
export { suggestRating } from './rating';
export { normalizeCommand } from './normalize';
export { MESSAGES } from './messages';
