import { useQuery } from '@tanstack/react-query';
import { ImageOff } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { t } from '../../i18n';
import { cn } from '../../lib/cn';
import { core } from '../../lib/core/client';
import { q } from '../../lib/core/queries';
import type { PageSize, PageWord, Rect } from '../../lib/core/types';
import type { ReadingTheme } from '../../lib/protocol';

let measureCtx: CanvasRenderingContext2D | null | undefined;
const FONT = 'sans-serif';

function measure(text: string, fontPx: number): number {
  if (measureCtx === undefined) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * fontPx * 0.5;
  measureCtx.font = `${fontPx}px ${FONT}`;
  return measureCtx.measureText(text).width;
}

/**
 * One transparent span per word rect (spec 6.3), stretched horizontally so the native
 * selection highlight covers the glyphs on the page image.
 */
export const WordLayer = memo(function WordLayer({
  words,
  zoom,
  debug,
  hits,
  theme = 'claro',
}: {
  words: PageWord[];
  zoom: number;
  debug?: boolean;
  hits?: Rect[];
  theme?: ReadingTheme;
}) {
  const spans = useMemo(
    () =>
      words.flatMap((w) =>
        w.rects.map(([x, y, rw, rh], i) => {
          const fontPx = rh * zoom * 0.86;
          const natural = measure(w.text, fontPx) || 1;
          return (
            <span
              key={`${w.index}-${i}`}
              data-word={w.index}
              style={{
                left: x * zoom,
                top: y * zoom,
                height: rh * zoom,
                fontSize: fontPx,
                lineHeight: `${rh * zoom}px`,
                fontFamily: FONT,
                transform: `scaleX(${(rw * zoom) / natural})`,
              }}
            >
              {w.text}
              {i === w.rects.length - 1 ? ' ' : ''}
            </span>
          );
        }),
      ),
    [words, zoom],
  );
  return (
    <>
      {hits && hits.length > 0 && (
        <div
          aria-hidden
          data-testid="search-hits"
          className={cn('search-hits pointer-events-none absolute inset-0', theme === 'escuro' && 'on-dark')}
        >
          {hits.map(([x, y, w, h], i) => (
            <div key={i} style={{ left: x * zoom - 1, top: y * zoom - 1, width: w * zoom + 2, height: h * zoom + 2 }} />
          ))}
        </div>
      )}
      <div className={cn('word-layer', debug && 'debug')} data-testid="word-layer">
        {spans}
      </div>
    </>
  );
});

function useNearViewport<T extends Element>(margin = '600px'): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver((entries) => setNear(entries.some((e) => e.isIntersecting)), {
      rootMargin: margin,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [margin]);
  return [ref, near];
}

export const pageBg: Record<ReadingTheme, string> = {
  claro: 'var(--page-light-bg)',
  sepia: 'var(--page-sepia-bg)',
  escuro: 'var(--page-dark-bg)',
};

/** A rendered page with its word layer. Image and words load only near the viewport. */
export function PageView({
  docId,
  index,
  size,
  zoom,
  theme = 'claro',
  debugWords,
  hits,
  eager,
  onWordsLoaded,
}: {
  docId: string;
  index: number;
  size: PageSize;
  zoom: number;
  theme?: ReadingTheme;
  debugWords?: boolean;
  hits?: Rect[];
  eager?: boolean;
  onWordsLoaded?: (count: number) => void;
}) {
  const [ref, near] = useNearViewport<HTMLDivElement>();
  const visible = eager || near;
  // Keyed by URL so a new src resets the state without an effect racing a cached load.
  const [status, setStatus] = useState<{ src: string; ok: boolean } | null>(null);
  const dpr = typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, 3);
  const src = useMemo(
    () => (visible ? core.pageImageUrl(docId, index, { scale: zoom * dpr, theme }) : undefined),
    [visible, docId, index, zoom, dpr, theme],
  );
  const loaded = !!src && status?.src === src && status.ok;
  const failed = !!src && status?.src === src && !status.ok;
  const words = useQuery({ ...q.docWords(docId, index), enabled: visible });

  useEffect(() => {
    if (words.data) onWordsLoaded?.(words.data.words.length);
  }, [words.data, onWordsLoaded]);

  return (
    <div
      ref={ref}
      data-page={index}
      className="relative shrink-0 overflow-hidden rounded-[2px] shadow-[0_0_0_1px_var(--border)]"
      style={{ width: size.width * zoom, height: size.height * zoom, background: pageBg[theme] }}
      aria-label={t('reader.pageLabel', { n: index + 1 })}
      role="group"
    >
      {src && !failed && (
        <img
          src={src}
          alt=""
          draggable={false}
          onLoad={() => setStatus({ src, ok: true })}
          onError={() => setStatus({ src, ok: false })}
          className={cn(
            'absolute inset-0 size-full select-none transition-opacity',
            loaded ? 'opacity-100' : 'opacity-0',
          )}
        />
      )}
      {!loaded && !failed && <div className="absolute inset-0 bg-empty anim-shimmer opacity-40" aria-hidden />}
      {failed && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-base text-muted">
          <ImageOff size={22} aria-hidden />
          {t('reader.pageFailed')}
        </div>
      )}
      {words.data && <WordLayer words={words.data.words} zoom={zoom} debug={debugWords} hits={hits} theme={theme} />}
    </div>
  );
}
