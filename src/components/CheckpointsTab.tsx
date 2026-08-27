import { useCallback, useEffect, useState } from 'react';
import {
  Activity, AlertCircle, AlertTriangle, CheckCircle, Database, Layers,
  RefreshCw, Timer, X, Zap,
} from 'lucide-react';
import { api } from '../api';
import type { CheckpointStatusRow } from '../api';
import {
  M, fetchMetricsSnapshot, formatBytes, formatCompact, formatSeconds, gaugeSeries,
  histogramMean, histogramQuantile, labeledValues, latestSnapshot, value,
} from '../metrics';
import type { MetricsSnapshot } from '../metrics';
import { LineChart, StatTile } from './charts';

interface ResultNotice {
  ok: boolean;
  title: string;
  detail: string;
}

function timestamp(value: string): string {
  if (value === '0') return 'Not recorded';
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) return value;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function CheckpointsTab() {
  const [snapshot, setSnapshot] = useState<MetricsSnapshot | null>(null);
  const [statusRows, setStatusRows] = useState<CheckpointStatusRow[]>([]);
  const [refreshError, setRefreshError] = useState('');
  const [result, setResult] = useState<ResultNotice | null>(null);
  const [triggerLoading, setTriggerLoading] = useState(false);

  const refresh = useCallback(async () => {
    const checkpointResult = await Promise.allSettled([api.getClusterCheckpoints(), fetchMetricsSnapshot()]);
    const errors: string[] = [];
    if (checkpointResult[0].status === 'fulfilled') {
      setStatusRows(checkpointResult[0].value);
    } else {
      errors.push(checkpointResult[0].reason instanceof Error
        ? checkpointResult[0].reason.message
        : 'Could not load checkpoint status.');
    }
    if (checkpointResult[1].status === 'rejected' || checkpointResult[1].value === null) {
      errors.push('Checkpoint metrics scrape failed; the status row may still be current.');
    }
    setRefreshError(errors.join(' '));
    setSnapshot(latestSnapshot());
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const triggerCheckpoint = async () => {
    setTriggerLoading(true);
    setResult(null);
    try {
      const response = await api.triggerCheckpoint();
      setResult({
        ok: response.success,
        title: response.success ? 'Checkpoint committed' : 'Checkpoint failed',
        detail: response.success
          ? `Checkpoint ${response.checkpoint_id}, epoch ${response.epoch}, completed in ${response.duration_ms} ms.`
          : `${response.error || 'The checkpoint did not commit.'}${response.failure_disposition ? ` Disposition: ${response.failure_disposition}.` : ''}`,
      });
      await refresh();
    } catch (error) {
      setResult({
        ok: false,
        title: 'Checkpoint request failed',
        detail: error instanceof Error ? error.message : 'Unknown checkpoint error.',
      });
    } finally {
      setTriggerLoading(false);
    }
  };

  const latest = statusRows[0] ?? null;
  const epoch = value(snapshot, M.checkpointEpoch);
  const completed = value(snapshot, M.checkpointsCompleted);
  const failed = value(snapshot, M.checkpointsFailed);
  const sizeBytes = value(snapshot, M.checkpointSizeBytes);
  const durationMean = histogramMean(snapshot, M.checkpointDuration);
  const durationP95 = histogramQuantile(snapshot, M.checkpointDuration, 0.95);
  const captureP95 = histogramQuantile(snapshot, M.checkpointStateCapture, 0.95);
  const localBarrierP95 = histogramQuantile(snapshot, M.checkpointBarrierLocal, 0.95);
  const stallP95 = histogramQuantile(snapshot, M.checkpointStall, 0.95);
  const alignedWaitP95 = histogramQuantile(snapshot, M.checkpointAlignedResumeWait, 0.95);
  const precommitP95 = histogramQuantile(snapshot, M.sinkPrecommitDuration, 0.95);
  const mvBytes = value(snapshot, M.mvBytesStored);
  const liveOperatorState = labeledValues(snapshot, M.managedStateAccountedBytes, 'operator', { phase: 'live' });
  const liveStateTotal = liveOperatorState.length > 0
    ? liveOperatorState.reduce((total, operator) => total + operator.value, 0)
    : undefined;
  const maxOperatorState = Math.max(...liveOperatorState.map((operator) => operator.value), 1);

  return (
    <div className="tab-page" aria-labelledby="checkpoints-title">
      <header className="tab-heading">
        <div>
          <h1 id="checkpoints-title">Checkpoints & managed state</h1>
          <p>Current checkpoint status and metrics emitted by the pinned 0.30 engine.</p>
        </div>
        <button className="btn btn-primary" type="button" onClick={() => void triggerCheckpoint()} disabled={triggerLoading}>
          {triggerLoading ? <RefreshCw size={14} className="animate-spin" aria-hidden="true" /> : <Zap size={14} aria-hidden="true" />}
          Trigger checkpoint
        </button>
      </header>

      {refreshError && <div className="notice notice-error" role="alert"><AlertCircle size={16} aria-hidden="true" /><span>{refreshError}</span></div>}
      {result && (
        <div className={`notice ${result.ok ? 'notice-success' : 'notice-error'}`} role={result.ok ? 'status' : 'alert'}>
          {result.ok ? <CheckCircle size={16} aria-hidden="true" /> : <AlertCircle size={16} aria-hidden="true" />}
          <span><strong>{result.title}.</strong> {result.detail}</span>
          <button className="icon-button" type="button" onClick={() => setResult(null)} aria-label="Dismiss checkpoint result"><X size={14} aria-hidden="true" /></button>
        </div>
      )}

      <section aria-labelledby="checkpoint-health-title" className="section-stack">
        <h2 id="checkpoint-health-title">Checkpoint health</h2>
        <div className="grid-container grid-cols-4">
          <StatTile label="Current epoch" value={formatCompact(epoch)} sub={latest ? `Checkpoint ${latest.checkpoint_id}` : undefined} icon={<Zap size={16} aria-hidden="true" />} />
          <StatTile
            label="Completed / failed"
            value={`${formatCompact(completed)} / ${formatCompact(failed)}`}
            tone={failed !== undefined && failed > 0 ? 'warning' : 'default'}
            icon={<CheckCircle size={16} aria-hidden="true" />}
          />
          <StatTile label="Last size" value={formatBytes(sizeBytes)} icon={<Layers size={16} aria-hidden="true" />} />
          <StatTile label="Mean duration" value={formatSeconds(durationMean)} sub={durationP95 !== undefined ? `cumulative p95 ${formatSeconds(durationP95)}` : undefined} icon={<Timer size={16} aria-hidden="true" />} />
        </div>
        <div className="grid-container grid-cols-4">
          <StatTile label="State capture p95" value={formatSeconds(captureP95)} icon={<Database size={16} aria-hidden="true" />} />
          <StatTile label="Local barrier p95" value={formatSeconds(localBarrierP95)} icon={<Activity size={16} aria-hidden="true" />} />
          <StatTile label="Pipeline stall p95" value={formatSeconds(stallP95)} icon={<AlertTriangle size={16} aria-hidden="true" />} />
          <StatTile label="Aligned resume wait p95" value={formatSeconds(alignedWaitP95)} sub="Observed only by cluster shuffle" icon={<RefreshCw size={16} aria-hidden="true" />} />
        </div>
        {precommitP95 !== undefined && (
          <div className="grid-container grid-cols-4">
            <StatTile label="Sink pre-commit p95" value={formatSeconds(precommitP95)} icon={<Database size={16} aria-hidden="true" />} />
          </div>
        )}
        <div className="grid-container grid-cols-2">
          <div className="glass-card chart-card">
            <h3>Checkpoint size</h3>
            <LineChart series={[{ name: 'size', points: gaugeSeries(M.checkpointSizeBytes) }]} valueFormat={formatBytes} height={160} />
          </div>
          <div className="glass-card chart-card">
            <h3>Checkpoint epoch</h3>
            <LineChart series={[{ name: 'epoch', points: gaugeSeries(M.checkpointEpoch), color: '#1baf7a' }]} valueFormat={formatCompact} height={160} />
          </div>
        </div>

        <div className="glass-card table-card">
          <div className="card-header">
            <span>SHOW CHECKPOINT STATUS</span>
            <span>One current row; this endpoint is not checkpoint history.</span>
          </div>
          <div className="table-scroll">
            <table className="meta-table">
              <caption className="sr-only">Current checkpoint status</caption>
              <thead>
                <tr>
                  <th scope="col">Checkpoint ID</th>
                  <th scope="col">Epoch</th>
                  <th scope="col">Sources</th>
                  <th scope="col">Sinks</th>
                  <th scope="col">Completed this runtime</th>
                  <th scope="col">Timestamp</th>
                </tr>
              </thead>
              <tbody>
                {latest ? (
                  <tr>
                    <td>{latest.checkpoint_id}</td>
                    <td>{latest.epoch}</td>
                    <td>{latest.sources || 'None'}</td>
                    <td>{latest.sinks || 'None'}</td>
                    <td>{latest.completed_this_runtime}</td>
                    <td>{timestamp(latest.timestamp_ms)}</td>
                  </tr>
                ) : (
                  <tr><td colSpan={6} className="empty-table-cell">No status row returned.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section aria-labelledby="managed-state-title" className="section-stack">
        <h2 id="managed-state-title">Managed state accounting</h2>
        <div className="grid-container grid-cols-3">
          <StatTile label="Live accounted state" value={formatBytes(liveStateTotal)} sub="Sum of phase=live samples" icon={<Layers size={16} aria-hidden="true" />} />
          <StatTile label="Materialized-view storage" value={formatBytes(mvBytes)} icon={<Database size={16} aria-hidden="true" />} />
          <StatTile label="Operators reporting" value={formatCompact(liveOperatorState.length)} icon={<Activity size={16} aria-hidden="true" />} />
        </div>
        <div className="glass-card state-accounting-card">
          {liveOperatorState.length > 0 ? liveOperatorState.map((operator) => (
            <div key={operator.label} className="state-accounting-row">
              <div><code>{operator.label}</code><span>{formatBytes(operator.value)}</span></div>
              <div className="state-accounting-track"><span style={{ width: `${(operator.value / maxOperatorState) * 100}%` }} /></div>
            </div>
          )) : <div className="empty-state">No <code>managed_state_accounted_bytes&#123;phase=&quot;live&quot;&#125;</code> samples are currently exposed.</div>}
        </div>
        <div className="notice notice-info" role="note">
          <AlertCircle size={16} aria-hidden="true" />
          <span>This metric is operator-reported retained-state charge and a lower bound between reconciliation points. It excludes hash buckets, nested/shared payloads, allocator overhead and process RSS. LaminarDB 0.30 has no state-tier or state-memory-budget metrics.</span>
        </div>
      </section>

      <div className="notice notice-info" role="note">
        <AlertCircle size={16} aria-hidden="true" />
        <span><code>RESTORE FROM CHECKPOINT</code> is parsed but returns unsupported. Recovery is automatic at startup. Checkpoint config fields are <code>url</code>, <code>interval</code>, <code>timeout</code>, <code>storage</code> and <code>max_node_data_bytes</code>; checkpoint config changes require restart.</span>
      </div>
    </div>
  );
}
