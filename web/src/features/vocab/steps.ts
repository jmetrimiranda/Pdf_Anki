// The steps of the vocabulary wizard (spec 12.1) and their URL names (`/vocabulario/escanear?passo=…`).
export const VOCAB_STEPS = ['pasta', 'trecho', 'campos', 'criterio'] as const;
export type VocabStepParam = (typeof VOCAB_STEPS)[number];
/** The wizard's screens: the four steps of the URL plus the running scan. */
export type WizardStep = VocabStepParam | 'escanear';

export function parseStep(v: unknown): VocabStepParam | undefined {
  return typeof v === 'string' && (VOCAB_STEPS as readonly string[]).includes(v) ? (v as VocabStepParam) : undefined;
}
