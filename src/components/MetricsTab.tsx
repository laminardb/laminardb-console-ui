import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AlertCircle, Gauge, RefreshCw, Search, Timer, Zap } from 'lucide-react';
import {
  M, fetchMetricsSnapshot, formatBytes, formatCompact, formatRate, formatSeconds,
  gaugeSeries, histogramQuantile, latestSnapshot, previousSnapshot, quantileSeries,
  rate, rateSeries, subsystemOf, value,
} from '../metrics';
import type { MetricFamily, MetricsSnapshot } from '../metrics';
import { SERIES_COLORS } from '../chartTheme';
import { LineChart, StatTile } from './charts';

const HIDDEN_LABELS = new Set(['instance', 'pipeline']); // constant on every series

function labelText(labels: Record<string, string>): string {
  const entries = Object.entries(labels).filter(([k]) => !HIDDEN_LABELS.has(k));
  if (entries.length === 0) return '';
  return entries.map(([k, v]) => `${k}="${v}"`).join(', ');
}

function formatMetricValue(fam: MetricFamily, v: number): string {
  if (/bytes/.test(fam.name)) return formatBytes(v);
  if (/seconds|duration/.test(fam.name)) return formatSeconds(v);
  return formatCompact(v);
}

export default function MetricsTab() {
  const [snap, setSnap] = useState<MetricsSnapshot | null>(null);
  const [prevSnap, setPrevSnap] = useState<MetricsSnapshot | null>(null);
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState<string>('');
  const [scrapeError, setScrapeError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [, setTick] = useState(0);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const result = await fetchMetricsSnapshot();
    setScrapeError(result ? '' : 'The /metrics scrape failed. Existing chart history is retained while the console retries.');
    setSnap(latestSnapshot());
    setPrevSnap(previousSnapshot());
    setTick((t) => t + 1);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  // KPI row
  const ingestRate = rate(prevSnap, snap, M.eventsIngested);
  const emitRate = rate(prevSnap, snap, M.eventsEmitted);
  const cycleP99 = histogramQuantile(snap, M.cycleDuration, 0.99, prevSnap);
  const watermark = value(snap, M.pipelineWatermark);
  // Lag relative to the scrape time of the snapshot (not render time).
  const watermarkLagSec = snap && watermark && watermark > 0 ? Math.max(0, (snap.at - watermark) / 1000) : undefined;

  // Grouped browser rows
  const grouped = useMemo(() => {
    const map = new Map<string, MetricFamily[]>();
    if (!snap) return map;
    const q = search.trim().toLowerCase();
    const fams = Array.from(snap.families.values()).sort((a, b) => a.name.localeCompare(b.name));
    for (const fam of fams) {
      const g = subsystemOf(fam.name);
      if (group && g !== group) continue;
      if (q && !fam.name.toLowerCase().includes(q) && !fam.help.toLowerCase().includes(q)) continue;
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(fam);
    }
    return map;
  }, [snap, search, group]);

  const allGroups = useMemo(() => {
    if (!snap) return [];
    return Array.from(new Set(Array.from(snap.families.keys()).map(subsystemOf))).sort();
  }, [snap]);

  const totalSeries = snap ? Array.from(snap.families.values()).reduce((acc, f) => acc + Math.max(1, f.samples.length), 0) : 0;

  return (
    <div className="tab-page" aria-labelledby="metrics-title">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 id="metrics-title" style={{ fontSize: 26, fontWeight: 800, margin: 0 }}>Metrics</h1>
          <p style={{ color: 'hsl(var(--text-secondary))', fontSize: 13, marginTop: 4 }}>
            Live Prometheus scrape of <code style={{ fontFamily: 'var(--font-mono)' }}>/metrics</code> — {snap ? `${snap.families.size} metric families, ${totalSeries} series` : 'connecting…'}. Charts accumulate while the console is open (5s cadence).
          </p>
        </div>
        <button className="btn btn-secondary" type="button" onClick={() => void refresh()} disabled={refreshing}>
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} aria-hidden="true" />
          <span>Refresh now</span>
        </button>
      </div>

      {scrapeError && <div className="notice notice-error" role="alert"><AlertCircle size={16} aria-hidden="true" /><span>{scrapeError}</span></div>}

      {/* KPI row */}
      <div className="grid-container grid-cols-4">
        <StatTile label="Ingestion rate" value={formatRate(ingestRate)} icon={<Zap size={16} style={{ color: 'hsl(var(--status-success))' }} />} trend={rateSeries(M.eventsIngested)} />
        <StatTile label="Emission rate" value={formatRate(emitRate)} icon={<Activity size={16} style={{ color: 'hsl(var(--primary))' }} />} trend={rateSeries(M.eventsEmitted)} />
        <StatTile label="Cycle p99 (window)" value={formatSeconds(cycleP99)} icon={<Timer size={16} style={{ color: 'hsl(var(--primary))' }} />} />
        <StatTile label="Watermark lag" value={watermarkLagSec === undefined ? '—' : formatSeconds(watermarkLagSec)} icon={<Gauge size={16} style={{ color: 'hsl(var(--primary))' }} />} />
      </div>

      {/* Charts */}
      <div className="grid-container grid-cols-2">
        <div className="glass-card">
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Throughput (events/s)</div>
          <LineChart
            series={[
              { name: 'ingested', points: rateSeries(M.eventsIngested), color: SERIES_COLORS[0] },
              { name: 'emitted', points: rateSeries(M.eventsEmitted), color: SERIES_COLORS[1] },
            ]}
            valueFormat={(v) => formatCompact(v)}
            height={180}
          />
        </div>
        <div className="glass-card">
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Cycle duration quantiles</div>
          <LineChart
            series={[
              { name: 'p50', points: quantileSeries(M.cycleDuration, 0.5), color: SERIES_COLORS[0] },
              { name: 'p95', points: quantileSeries(M.cycleDuration, 0.95), color: SERIES_COLORS[1] },
              { name: 'p99', points: quantileSeries(M.cycleDuration, 0.99), color: SERIES_COLORS[2] },
            ]}
            valueFormat={(v) => formatSeconds(v)}
            height={180}
          />
        </div>
        <div className="glass-card">
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Accounted live managed state</div>
          <LineChart
            series={[
              { name: 'phase=live', points: gaugeSeries(M.managedStateAccountedBytes, { phase: 'live' }), color: SERIES_COLORS[0] },
            ]}
            valueFormat={(v) => formatBytes(v)}
            height={180}
          />
        </div>
        <div className="glass-card">
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Backpressured cycles /s</div>
          <LineChart
            series={[{ name: 'backpressured', points: rateSeries(M.cyclesBackpressured), color: SERIES_COLORS[2] }]}
            valueFormat={(v) => formatCompact(v)}
            height={180}
          />
        </div>
      </div>

      {/* Filter row for the browser */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 260px', maxWidth: 380 }}>
          <Search size={14} aria-hidden="true" style={{ position: 'absolute', left: 10, top: 10, color: 'hsl(var(--text-muted))' }} />
          <label className="sr-only" htmlFor="metric-search">Filter metrics</label>
          <input
            id="metric-search"
            type="text"
            className="input-field"
            placeholder="Filter metrics by name or description…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ paddingLeft: 30 }}
          />
        </div>
        <label className="sr-only" htmlFor="metric-subsystem">Metric subsystem</label>
        <select id="metric-subsystem" className="input-field" style={{ width: 220 }} value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="">All subsystems</option>
          {allGroups.map((g) => (
            <option key={g} value={g}>{g}</option>
          ))}
        </select>
      </div>

      {/* Metrics browser (the table view twin for every chart above) */}
      {Array.from(grouped.entries()).map(([g, fams]) => (
        <div key={g} className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border-translucent)', fontWeight: 600, fontSize: 13 }}>
            {g} <span style={{ color: 'hsl(var(--text-muted))', fontWeight: 400 }}>({fams.length})</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="meta-table">
              <caption className="sr-only">{g} Prometheus metrics</caption>
              <thead>
                <tr>
                  <th scope="col" style={{ width: '38%' }}>Metric</th>
                  <th scope="col">Type</th>
                  <th scope="col">Value</th>
                  <th scope="col">Rate /s</th>
                  <th scope="col">Labels</th>
                </tr>
              </thead>
              <tbody>
                {fams.map((fam) => {
                  const rows: { key: string; labels: string; v: number | undefined }[] = [];
                  if (fam.type === 'histogram' || fam.type === 'summary') {
                    rows.push({ key: fam.name, labels: `count=${formatCompact(fam.count)}, sum=${fam.sum === undefined ? '—' : formatSeconds(fam.sum)}`, v: histogramQuantile(snap, fam.name, 0.95) });
                  } else if (fam.samples.length <= 1) {
                    rows.push({ key: fam.name, labels: fam.samples[0] ? labelText(fam.samples[0].labels) : '', v: fam.samples[0]?.value });
                  } else {
                    // multi-series family: one row per labeled sample (capped)
                    fam.samples.slice(0, 8).forEach((s, i) => rows.push({ key: `${fam.name}-${i}`, labels: labelText(s.labels), v: s.value }));
                    if (fam.samples.length > 8) rows.push({ key: `${fam.name}-more`, labels: `… ${fam.samples.length - 8} more series`, v: undefined });
                  }
                  const r = fam.type === 'counter' ? rate(prevSnap, snap, fam.name) : undefined;
                  return rows.map((row, i) => (
                    <tr key={row.key} title={fam.help}>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{i === 0 ? fam.name : ''}</td>
                      <td>{i === 0 ? <span className="badge badge-purple" style={{ fontSize: 9 }}>{fam.type}{fam.type === 'histogram' ? ' (p95 shown)' : ''}</span> : ''}</td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                        {row.v === undefined ? '—' : formatMetricValue(fam, row.v)}
                      </td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'hsl(var(--text-secondary))' }}>
                        {i === 0 && r !== undefined ? formatCompact(Math.round(r * 100) / 100) : ''}
                      </td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'hsl(var(--text-muted))' }}>{row.labels}</td>
                    </tr>
                  ));
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {snap && grouped.size === 0 && (
        <div className="glass-card" style={{ textAlign: 'center', color: 'hsl(var(--text-muted))', padding: 30 }}>
          No metrics match the current filter.
        </div>
      )}
    </div>
  );
}
