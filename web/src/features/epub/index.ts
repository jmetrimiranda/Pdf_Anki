// The EPUB reader (spec 7.1): a self-contained view W2 mounts in the Leitor tab. Contract: docs/tecnico/foliate.md.
export { EpubReader } from './EpubReader';
export { useEpubTheme } from './prefs';
export type {
  EpubLocation,
  EpubOpenOptions,
  EpubReaderEvents,
  EpubReaderHandle,
  EpubSelection,
  EpubTheme,
  EpubVocabWord,
} from './types';
