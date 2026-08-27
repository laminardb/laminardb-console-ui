// Chart primitives for the console: line chart (crosshair + tooltip), sparkline,
// stat tile and budget meter. Hand-rolled SVG — no chart dependency.
//
// Color roles (validated categorical palette on the white card surface):
//   series 1 #2a78d6 (blue) · 2 #1baf7a (aqua) · 3 #eda100 (yellow) · 4 #4a3aa7 (violet)
// Status colors are reserved for state, never used as series colors.

import { useRef, useState } from 'react';
import type { TimePoint } from '../metrics';
import { SERIES_COLORS, STATUS } from '../chartTheme';

const GRID = '#e7e5e0';
const AXIS_INK = '#64748b';

export interface ChartSeries {
  name: string;
  points: TimePoint[];
  color?: string;
}

interface LineChartProps {
  series: ChartSeries[];
  height?: number;
  valueFormat: (v: number) => string;
  /** Optional fixed y-max (e.g. a budget line). */
  yMax?: number;
}

function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const ticks: number[] = [0];
  // Always cover max so no data point renders above the top gridline.
  while (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

function timeLabel(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/**
 * Multi-series time line chart. 2px lines, hairline solid grid, hover
 * crosshair snapping to the nearest sample with a one-tooltip-every-series
 * readout. Legend renders for >= 2 series (single series is named by the
 * panel title).
 */
export function LineChart({ series, height = 180, valueFormat, yMax }: LineChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const W = 640;
  const H = height;
  const PAD = { left: 46, right: 14, top: 10, bottom: 22 };

  const visible = series.filter((s) => s.points.length > 0);
  const allPoints = visible.flatMap((s) => s.points);

  const times = allPoints.map((p) => p.t);
  const t0 = times.length ? Math.min(...times) : 0;
  const t1 = times.length ? Math.max(...times) : 1;
  const rawMax = yMax ?? Math.max(...allPoints.map((p) => p.v), 0);
  const ticks = niceTicks(rawMax || 1);
  const vMax = ticks[ticks.length - 1] || 1;

  if (visible.length === 0 || allPoints.length < 2) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'hsl(var(--text-muted))', fontSize: 12 }}>
        Collecting samples… charts fill in as the console polls /metrics.
      </div>
    );
  }

  const x = (t: number) => PAD.left + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.left - PAD.right);
  const y = (v: number) => H - PAD.bottom - (v / vMax) * (H - PAD.top - PAD.bottom);

  // Hover: snap to nearest time across the union of sample times.
  const sampleTimes = Array.from(new Set(allPoints.map((p) => p.t))).sort((a, b) => a - b);

  const handleMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const targetT = t0 + ((px - PAD.left) / Math.max(1, W - PAD.left - PAD.right)) * (t1 - t0);
    let best = 0;
    let bestD = Infinity;
    sampleTimes.forEach((t, i) => {
      const d = Math.abs(t - targetT);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    setHoverIdx(best);
  };

  const hoverT = hoverIdx !== null ? sampleTimes[hoverIdx] : null;
  const hoverRows = hoverT !== null
    ? visible.map((s) => {
        // nearest point in this series to hoverT
        let bp: TimePoint | null = null;
        let bd = Infinity;
        for (const p of s.points) {
          const d = Math.abs(p.t - hoverT);
          if (d < bd) {
            bd = d;
            bp = p;
          }
        }
        return { name: s.name, color: s.color ?? SERIES_COLORS[0], v: bp?.v };
      })
    : [];

  // x tick positions: first, middle, last
  const xTicks = [t0, t0 + (t1 - t0) / 2, t1];

  // Endpoint labels with simple collision handling: skip when two ends are
  // within 12px vertically (legend + tooltip still carry the values).
  const endLabels: { x: number; y: number; text: string; color: string }[] = [];
  if (visible.length <= 3) {
    const used: number[] = [];
    for (let i = 0; i < visible.length; i++) {
      const s = visible[i];
      const last = s.points[s.points.length - 1];
      const ly = y(last.v);
      if (used.some((u) => Math.abs(u - ly) < 12)) continue;
      used.push(ly);
      endLabels.push({ x: x(last.t), y: ly, text: valueFormat(last.v), color: s.color ?? SERIES_COLORS[i] });
    }
  }

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      {visible.length >= 2 && (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 4 }}>
          {visible.map((s, i) => (
            <span key={s.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'hsl(var(--text-secondary))' }}>
              <span style={{ width: 14, height: 2, background: s.color ?? SERIES_COLORS[i], display: 'inline-block', borderRadius: 1 }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 'auto', display: 'block', touchAction: 'none' }}
        onPointerMove={handleMove}
        onPointerLeave={() => setHoverIdx(null)}
        role="img"
        aria-label={`Time series chart: ${visible.map((item) => item.name).join(', ')}`}
      >
        {/* hairline grid + y ticks */}
        {ticks.map((tv) => (
          <g key={tv}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(tv)} y2={y(tv)} stroke={GRID} strokeWidth={1} />
            <text x={PAD.left - 6} y={y(tv) + 3.5} textAnchor="end" fontSize={10} fill={AXIS_INK} style={{ fontVariantNumeric: 'tabular-nums' }}>
              {valueFormat(tv)}
            </text>
          </g>
        ))}
        {/* x ticks */}
        {xTicks.map((tv, i) => (
          <text
            key={i}
            x={x(tv)}
            y={H - 6}
            textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}
            fontSize={10}
            fill={AXIS_INK}
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {timeLabel(tv)}
          </text>
        ))}
        {/* area wash for single series */}
        {visible.length === 1 && (
          <path
            d={`M ${visible[0].points.map((p) => `${x(p.t)} ${y(p.v)}`).join(' L ')} L ${x(visible[0].points[visible[0].points.length - 1].t)} ${y(0)} L ${x(visible[0].points[0].t)} ${y(0)} Z`}
            fill={visible[0].color ?? SERIES_COLORS[0]}
            opacity={0.1}
          />
        )}
        {/* series lines */}
        {visible.map((s, i) => (
          <path
            key={s.name}
            d={`M ${s.points.map((p) => `${x(p.t)} ${y(p.v)}`).join(' L ')}`}
            fill="none"
            stroke={s.color ?? SERIES_COLORS[i]}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {/* endpoint markers + selective end labels */}
        {visible.map((s, i) => {
          const last = s.points[s.points.length - 1];
          return (
            <circle
              key={`end-${s.name}`}
              cx={x(last.t)}
              cy={y(last.v)}
              r={4}
              fill={s.color ?? SERIES_COLORS[i]}
              stroke="#ffffff"
              strokeWidth={2}
            />
          );
        })}
        {endLabels.map((l, i) => (
          <text key={i} x={Math.min(l.x + 6, W - 2)} y={Math.max(10, l.y - 6)} fontSize={10} fontWeight={600} fill="hsl(var(--text-secondary))" textAnchor="end" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {l.text}
          </text>
        ))}
        {/* crosshair */}
        {hoverT !== null && (
          <line x1={x(hoverT)} x2={x(hoverT)} y1={PAD.top} y2={H - PAD.bottom} stroke="#94a3b8" strokeWidth={1} />
        )}
        {hoverT !== null &&
          hoverRows.map(
            (r, i) =>
              r.v !== undefined && (
                <circle key={i} cx={x(hoverT)} cy={y(r.v)} r={4} fill={r.color} stroke="#ffffff" strokeWidth={2} />
              )
          )}
      </svg>
      {/* tooltip: values lead, series names follow, line keys */}
      {hoverT !== null && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            background: '#ffffff',
            border: '1px solid var(--border-translucent)',
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 11,
            boxShadow: '0 2px 8px rgba(15,23,42,0.08)',
            pointerEvents: 'none',
            minWidth: 120,
          }}
        >
          <div style={{ color: 'hsl(var(--text-muted))', marginBottom: 2, fontVariantNumeric: 'tabular-nums' }}>{timeLabel(hoverT)}</div>
          {hoverRows.map((r) => (
            <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 10, height: 2, background: r.color, display: 'inline-block', borderRadius: 1 }} />
              <span style={{ fontWeight: 700, color: 'hsl(var(--text-primary))', fontVariantNumeric: 'tabular-nums' }}>
                {r.v === undefined ? '—' : valueFormat(r.v)}
              </span>
              <span style={{ color: 'hsl(var(--text-muted))' }}>{r.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 12-point sparkline for stat tiles (de-emphasis stroke, accent endpoint). */
export function Sparkline({ points, color = '#94a3b8', accent = '#2a78d6' }: { points: TimePoint[]; color?: string; accent?: string }) {
  if (points.length < 2) return null;
  const recent = points.slice(-12);
  const W = 88;
  const H = 26;
  const vMax = Math.max(...recent.map((p) => p.v), 0);
  const vMin = Math.min(...recent.map((p) => p.v), 0);
  const range = vMax - vMin || 1;
  const x = (i: number) => (i / (recent.length - 1)) * (W - 6) + 2;
  const y = (v: number) => H - 4 - ((v - vMin) / range) * (H - 8);
  const last = recent[recent.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true">
      <path d={`M ${recent.map((p, i) => `${x(i)} ${y(p.v)}`).join(' L ')}`} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(recent.length - 1)} cy={y(last.v)} r={3} fill={accent} stroke="#ffffff" strokeWidth={1.5} />
    </svg>
  );
}

interface StatTileProps {
  label: string;
  value: string;
  sub?: string;
  icon?: React.ReactNode;
  trend?: TimePoint[];
  /** Optional status accent for the value. */
  tone?: 'default' | 'good' | 'warning' | 'critical';
}

export function StatTile({ label, value, sub, icon, trend, tone = 'default' }: StatTileProps) {
  const toneColor =
    tone === 'good' ? STATUS.good : tone === 'warning' ? STATUS.warning : tone === 'critical' ? STATUS.critical : 'hsl(var(--text-primary))';
  return (
    <div className="glass-card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'hsl(var(--text-muted))', letterSpacing: '0.5px' }}>
          {label}
        </span>
        {icon}
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: toneColor }}>{value}</div>
          {sub && (
            <div style={{ fontSize: 11, color: 'hsl(var(--text-muted))', marginTop: 2 }}>{sub}</div>
          )}
        </div>
        {trend && trend.length >= 2 && <Sparkline points={trend} />}
      </div>
    </div>
  );
}

interface MeterProps {
  label: string;
  value: number;
  max: number;
  format: (v: number) => string;
  /** true renders the fill in critical status (e.g. over budget). */
  over?: boolean;
}

/** Ratio-against-a-limit meter. Track = lighter step of the same blue ramp. */
export function Meter({ label, value, max, format, over }: MeterProps) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const fill = over ? STATUS.critical : pct > 85 ? STATUS.warningFill : '#2a78d6';
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
        <span style={{ color: 'hsl(var(--text-secondary))' }}>{label}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'hsl(var(--text-secondary))' }}>
          {format(value)} / {max > 0 ? format(max) : 'unlimited'}
        </span>
      </div>
      <div
        style={{ width: '100%', height: 8, background: max > 0 ? '#cde2fb' : 'hsl(var(--bg-base))', borderRadius: 4, overflow: 'hidden' }}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max > 0 ? max : undefined}
        aria-valuenow={max > 0 ? Math.min(value, max) : undefined}
        aria-valuetext={max > 0 ? `${format(value)} of ${format(max)}` : `${format(value)}, unlimited`}
      >
        {max > 0 && <div style={{ width: `${pct}%`, height: '100%', background: fill, borderRadius: 4, transition: 'width 0.4s ease' }} />}
      </div>
    </div>
  );
}
