// Test page of the EPUB reader (dev/mock server only, never in the production build): served by Vite at
// /src/features/epub/harness/index.html?book=sample|epub2|script|mediatypes|garbage|notoc|drm. Records the reader's events in
// `window.__epubHarness` for web/e2e/epub-reader.spec.ts.
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TooltipProvider } from '../../../components/ui';
import { core } from '../../../lib/core/client';
import {
  buildEpub,
  escapeXml,
  mediaTypeEpub,
  SAMPLE_EPUB_CHAPTERS,
  sampleEpub,
  scriptEpub,
  zipStore,
} from '../../../lib/epub/build';
import { initTheme } from '../../../lib/theme';
import { EpubReader, type EpubReaderEvents, type EpubReaderHandle } from '../index';
import '../../../styles/app.css';

interface HarnessEvent {
  type: string;
  [k: string]: unknown;
}

declare global {
  interface Window {
    __epubHarness?: {
      events: HarnessEvent[];
      handle: EpubReaderHandle | null;
      opened: boolean;
      error: string | null;
      /** open() → first page laid out, in ms. */
      openMs: number | null;
      bytes: number;
    };
  }
}

const harness: NonNullable<Window['__epubHarness']> = {
  events: [],
  handle: null,
  opened: false,
  error: null,
  openMs: null,
  bytes: 0,
};
window.__epubHarness = harness;

function bytesFor(kind: string): Uint8Array {
  switch (kind) {
    case 'epub2':
      return sampleEpub(2);
    case 'script':
      return scriptEpub();
    case 'mediatypes':
      return mediaTypeEpub();
    case 'notoc':
      return buildEpub({
        title: 'No TOC',
        author: 'Test',
        language: 'en',
        version: 3,
        omitToc: true,
        chapters: [{ title: 'Only chapter', html: '<p>A book without a table of contents.</p>' }],
      });
    case 'big':
      return bigEpub();
    case 'garbage':
      return new TextEncoder().encode('this is not an epub at all');
    case 'drm':
      return zipStore([
        { name: 'mimetype', data: 'application/epub+zip' },
        {
          name: 'META-INF/encryption.xml',
          data: '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/></EncryptedData></encryption>',
        },
      ]);
    default:
      return sampleEpub(3);
  }
}

/** About 1 MB of text: the sample's chapters repeated (performance check, spec 7.1). */
function bigEpub(): Uint8Array {
  const chapters = SAMPLE_EPUB_CHAPTERS.filter((c) => c.depth === 1);
  const parts = Array.from({ length: 6 }, (_, p) => ({
    title: `Part ${p + 1}`,
    html: '<p>Part opening.</p>',
    children: Array.from({ length: 6 }, (_, i) => {
      const c = chapters[i % chapters.length]!;
      const paragraphs = c.text.split('\n\n').slice(1);
      const html = Array.from({ length: 6 }, () => paragraphs.map((x) => `<p>${escapeXml(x)}</p>`).join('\n')).join(
        '\n',
      );
      return { title: `${p + 1}.${i + 1} ${c.title}`, html };
    }),
  }));
  return buildEpub({ title: 'Big Book', author: 'Test', language: 'en', version: 3, chapters: parts });
}

function Harness() {
  const ref = useRef<EpubReaderHandle>(null);
  const [uid, setUid] = useState<string | null>(null);
  const params = new URLSearchParams(location.search);
  const kind = params.get('book') ?? 'sample';

  const log = (type: string, payload: Record<string, unknown> = {}) => harness.events.push({ type, ...payload });
  const events: EpubReaderEvents = {
    onLocation: (l) => log('location', { ...l }),
    onActivity: (u) => log('activity', { uid: u }),
    onSelection: (s) => log('selection', { selection: s }),
    onMenu: (key, s) => log('menu', { key, selection: s }),
    onVocabClick: (e) => log('vocabClick', { ...e }),
    onSectionShown: (u, section) => log('sectionShown', { uid: u, section }),
    onKey: (e) => log('key', { key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey }),
    onError: (message) => log('error', { message }),
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const books = await core.libraryList();
      const epub = books.find((b) => b.format === 'epub');
      if (!cancelled) setUid(epub?.bookUid ?? 'missing');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!uid) return;
    harness.handle = ref.current;
    const cfi = params.get('cfi');
    const section = params.get('section');
    const bytes = bytesFor(kind);
    harness.bytes = bytes.length;
    const started = performance.now();
    void ref.current
      ?.open({
        uid,
        bytes,
        title: kind === 'script' ? 'Hostile Book' : 'The Time Machine',
        cfi,
        section: section != null ? Number(section) : null,
        find: params.get('find'),
      })
      .then(
        () => {
          harness.openMs = performance.now() - started;
          harness.opened = true;
          harness.error = null;
        },
        (e: unknown) => {
          if (!String(e).includes('superseded')) harness.error = String(e);
        },
      );
    return () => ref.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  return (
    <div style={{ height: '100vh' }}>
      <EpubReader ref={ref} events={events} />
    </div>
  );
}

initTheme();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider delayDuration={400}>
      <Harness />
    </TooltipProvider>
  </StrictMode>,
);
