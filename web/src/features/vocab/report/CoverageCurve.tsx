// The coverage curve of the report (spec 12.4): coverage after learning the N most frequent unknown words, with the
// 95% and 98% goals marked. A small inline SVG (no chart library), described for screen readers by its label.
import { t } from '../../../i18n';
import type { VocabCurvePoint } from '../../../lib/core/types';
import { formatPct, formatPct0 } from '../model';

const W = 260;
const H = 110;
const PAD = { left: 30, right: 10, top: 8, bottom: 18 };
const GOALS = [0.95, 0.98] as const;

export function CoverageCurve({
  curve,
  wordsTo95,
  wordsTo98,
}: {
  curve: readonly VocabCurvePoint[];
  wordsTo95: number;
  wordsTo98: number;
}) {
  if (curve.length < 2) return null;
  const maxN = curve[curve.length - 1]!.n || 1;
  const start = curve[0]!.coverage;
  const end = curve[curve.length - 1]!.coverage;
  // The y axis starts a little under the curve (or 90%), so the goals near the top stay readable.
  const yMin = Math.max(0, Math.min(0.9, Math.floor((start - 0.02) * 20) / 20));
  const x = (n: number) => PAD.left + (n / maxN) * (W - PAD.left - PAD.right);
  const y = (c: number) => PAD.top + (1 - (c - yMin) / (1 - yMin)) * (H - PAD.top - PAD.bottom);
  const path = curve.map((p, i) => `${i ? 'L' : 'M'}${x(p.n).toFixed(1)},${y(p.coverage).toFixed(1)}`).join(' ');
  const marks = [
    { goal: 0.95, n: wordsTo95 },
    { goal: 0.98, n: wordsTo98 },
  ].filter((m) => end + 1e-9 >= m.goal);
  return (
    <figure className="m-0 flex flex-col gap-1">
      <svg
        role="img"
        aria-label={t('vocab.report.curveLabel', { inicio: formatPct(start), fim: formatPct(end), n: maxN })}
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        className="max-w-full overflow-visible"
        data-testid="vocab-curve"
      >
        {GOALS.map((g) => (
          <g key={g}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(g)}
              y2={y(g)}
              stroke="var(--border)"
              strokeDasharray="3 3"
              strokeWidth={1}
            />
            {/* 98% above its line, 95% below it: the two goals are close on the axis. */}
            <text
              x={PAD.left - 4}
              y={g === 0.98 ? y(g) - 1 : y(g) + 8}
              textAnchor="end"
              fontSize={9}
              fill="var(--muted)"
            >
              {formatPct0(g)}
            </text>
          </g>
        ))}
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={H - PAD.bottom}
          y2={H - PAD.bottom}
          stroke="var(--border)"
          strokeWidth={1}
        />
        <path d={path} fill="none" stroke="var(--lime-dark)" strokeWidth={2} strokeLinejoin="round" />
        {marks.map((m) => (
          <g key={m.goal}>
            <line
              x1={x(m.n)}
              x2={x(m.n)}
              y1={y(m.goal)}
              y2={H - PAD.bottom}
              stroke="var(--lime)"
              strokeWidth={1}
              strokeDasharray="2 2"
            />
            <circle cx={x(m.n)} cy={y(m.goal)} r={3} fill="var(--card)" stroke="var(--lime-dark)" strokeWidth={1.5} />
          </g>
        ))}
        <text x={PAD.left} y={H - 4} fontSize={9} fill="var(--muted)">
          0
        </text>
        <text x={W - PAD.right} y={H - 4} fontSize={9} fill="var(--muted)" textAnchor="end">
          {maxN}
        </text>
      </svg>
      <figcaption className="text-2xs text-muted" style={{ paddingLeft: PAD.left }}>
        {t('vocab.report.curveAxis')}
      </figcaption>
    </figure>
  );
}
