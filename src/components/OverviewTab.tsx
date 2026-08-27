import { useCallback, useEffect, useState } from 'react';
import {
  Activity, AlertCircle, CheckCircle, Cpu, Layers, Pause, PlayCircle, Radio,
  RefreshCw, Server, ShieldAlert, X, Zap
} from 'lucide-react';
import { ApiError, api } from '../api';
import type {
  AssignmentSnapshot, CheckpointStatusRow, ClusterStatusResponse, LeaderResponse, NodeInfo,
} from '../api';
import {
  M, fetchMetricsSnapshot, formatBytes, formatCompact, formatRate, formatSeconds,
  histogramMean, latestSnapshot, previousSnapshot, rate, rateSeries, value,
} from '../metrics';
import type { MetricsSnapshot } from '../metrics';
import { StatTile } from './charts';
import ConfirmDialog from './ConfirmDialog';

// Node colors for the vnode heatmap.
const getNodeColor = (nodeId: string, allNodeIds: string[]) => {
  const colors = [
    'rgba(139, 92, 246, 0.8)', 'rgba(59, 130, 246, 0.8)', 'rgba(16, 185, 129, 0.8)',
    'rgba(245, 158, 11, 0.8)', 'rgba(236, 72, 153, 0.8)', 'rgba(6, 182, 212, 0.8)',
    'rgba(239, 68, 68, 0.8)', 'rgba(14, 165, 233, 0.8)', 'rgba(249, 115, 22, 0.8)',
    'rgba(34, 197, 94, 0.8)', 'rgba(168, 85, 247, 0.8)', 'rgba(234, 179, 8, 0.8)',
  ];
  const index = allNodeIds.indexOf(nodeId);
  if (index === -1) {
    const hash = Array.from(nodeId).reduce((value, character) => value + character.charCodeAt(0), 0);
    return colors[hash % colors.length];
  }
  return colors[index % colors.length];
};

const compareU64 = (left: string, right: string) => {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
};

const formatWireBytes = (bytes: string) => {
  const value = BigInt(bytes);
  if (value === 0n) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let unit = 0;
  let divisor = 1n;
  while (unit < units.length - 1 && value >= divisor * 1024n) {
    divisor *= 1024n;
    unit += 1;
  }
  const tenths = (value * 10n) / divisor;
  return unit === 0 ? `${value} B` : `${tenths / 10n}.${tenths % 10n} ${units[unit]}`;
};

const formatWireCount = (value: string | undefined) => value === undefined
  ? '—'
  : BigInt(value).toLocaleString();

const formatUptime = (seconds: number) => {
  if (seconds <= 0) return '';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
};

const nodeStateBadge = (state: NodeInfo['state']) => {
  switch (state) {
    case 'Active': return 'badge-emerald';
    case 'Suspected': return 'badge-amber';
    case 'Draining': return 'badge-amber';
    default: return 'badge-purple';
  }
};

interface ActionBanner {
  tone: 'success' | 'error' | 'warning';
  title: string;
  lines: string[];
}

export default function OverviewTab() {
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [vnodes, setVnodes] = useState<AssignmentSnapshot | null>(null);
  const [leaderInfo, setLeaderInfo] = useState<LeaderResponse | null>(null);
  const [clusterStatus, setClusterStatus] = useState<ClusterStatusResponse | null>(null);
  const [checkpoints, setCheckpoints] = useState<CheckpointStatusRow[]>([]);
  const [clusterError, setClusterError] = useState('');
  const [metricsError, setMetricsError] = useState('');
  const [pipelineState, setPipelineState] = useState<string>('');
  const [pipelineLastError, setPipelineLastError] = useState<string>('');
  const [pipelineActionLoading, setPipelineActionLoading] = useState(false);
  const [checkpointLoading, setCheckpointLoading] = useState(false);
  const [reloadLoading, setReloadLoading] = useState(false);
  const [confirmPipelineSuspend, setConfirmPipelineSuspend] = useState(false);
  const [banner, setBanner] = useState<ActionBanner | null>(null);
  const [snap, setSnap] = useState<MetricsSnapshot | null>(null);
  const [prevSnap, setPrevSnap] = useState<MetricsSnapshot | null>(null);
  const [, setTick] = useState(0);

  const fetchAll = useCallback(async () => {
    const [nodesList, vnodesMap, leaderObj, clusterStat, checkpointsList, pipelineStat] = await Promise.allSettled([
      api.getClusterNodes(),
      api.getClusterVnodes(),
      api.getClusterLeader(),
      api.getClusterStatus(),
      api.getClusterCheckpoints(),
      api.getPipelineStatus(),
    ]);

    const clusterMode = clusterStat.status === 'fulfilled';
    if (clusterMode) {
      setClusterStatus(clusterStat.value);
      if (nodesList.status === 'fulfilled') setNodes(nodesList.value);
      if (vnodesMap.status === 'fulfilled') setVnodes(vnodesMap.value);
      if (leaderObj.status === 'fulfilled') setLeaderInfo(leaderObj.value);
    } else if (clusterStat.reason instanceof ApiError && clusterStat.reason.status === 404) {
      setClusterStatus(null);
      setNodes([]);
      setVnodes(null);
      setLeaderInfo(null);
    }
    if (checkpointsList.status === 'fulfilled') setCheckpoints(checkpointsList.value);
    if (pipelineStat.status === 'fulfilled') {
      setPipelineState(pipelineStat.value.pipeline_state);
      setPipelineLastError(pipelineStat.value.last_error || '');
      const clusterFailures = clusterMode
        ? [nodesList, vnodesMap, leaderObj].filter((result) => result.status === 'rejected') as PromiseRejectedResult[]
        : [];
      setClusterError(clusterFailures.length > 0
        ? clusterFailures.map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason)).join('; ')
        : '');
    } else {
      setClusterError(pipelineStat.reason instanceof Error ? pipelineStat.reason.message : 'Error polling pipeline status.');
    }

    const metricsSnapshot = await fetchMetricsSnapshot();
    setMetricsError(metricsSnapshot ? '' : 'The /metrics scrape failed; metric cards retain their last successful values.');
    setSnap(latestSnapshot());
    setPrevSnap(previousSnapshot());
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    void fetchAll();
    const interval = setInterval(() => void fetchAll(), 5000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const triggerCheckpoint = async () => {
    setCheckpointLoading(true);
    try {
      const res = await api.triggerCheckpoint();
      setBanner({
        tone: res.success ? 'success' : 'error',
        title: res.success ? 'Checkpoint completed' : 'Checkpoint failed',
        lines: res.success
          ? [`Checkpoint #${res.checkpoint_id} · epoch ${res.epoch} · took ${res.duration_ms} ms`]
          : [res.error || 'Unknown error', ...(res.failure_disposition ? [`disposition: ${res.failure_disposition}`] : [])],
      });
      void fetchAll();
    } catch (error) {
      setBanner({ tone: 'error', title: 'Checkpoint trigger failed', lines: [error instanceof Error ? error.message : 'Unknown error'] });
    } finally {
      setCheckpointLoading(false);
    }
  };

  const reloadConfiguration = async () => {
    setReloadLoading(true);
    try {
      const res = await api.reloadConfig();
      const lines: string[] = [];
      for (const op of res.applied) lines.push(`applied: ${op.action} ${op.object_type} ${op.name}`);
      for (const f of res.failed) lines.push(`failed: ${f.action} ${f.object_type} ${f.name} — ${f.error}`);
      for (const w of res.warnings) lines.push(`warning: ${w}`);
      if (lines.length === 0) lines.push('No changes detected in the config file.');
      setBanner({
        tone: res.failed.length > 0 ? 'warning' : 'success',
        title: res.failed.length > 0 ? 'Config reload partially applied' : 'Config reloaded',
        lines,
      });
      void fetchAll();
    } catch (error) {
      setBanner({ tone: 'error', title: 'Config reload failed', lines: [error instanceof Error ? error.message : 'Unknown error'] });
    } finally {
      setReloadLoading(false);
    }
  };

  // The default route attempts peer fan-out, but peer results are deliberately
  // fire-and-forget in the engine and are not part of the HTTP response.
  const togglePipeline = async () => {
    const running = pipelineState === 'Running' || pipelineState === 'Starting';
    if (running && !confirmPipelineSuspend) {
      setConfirmPipelineSuspend(true);
      return;
    }
    setConfirmPipelineSuspend(false);
    setPipelineActionLoading(true);
    try {
      const res = running ? await api.stopPipeline() : await api.startPipeline();
      setBanner({
        tone: 'success',
        title: running ? 'Local pipeline suspended' : 'Local pipeline resumed',
        lines: isClusterMode
          ? [res.message, 'Peer fan-out is fire-and-forget; this response does not prove that every cluster node applied the operation.']
          : [res.message],
      });
      void fetchAll();
    } catch (error) {
      setBanner({ tone: 'error', title: `Failed to ${running ? 'suspend' : 'start'} pipeline`, lines: [error instanceof Error ? error.message : 'Unknown error'] });
    } finally {
      setPipelineActionLoading(false);
    }
  };

  // Members: merge leader into the peer list while preserving exact u64 IDs.
  const clusterMembers: NodeInfo[] = (() => {
    const byId = new Map<string, NodeInfo>();
    nodes.forEach((n) => byId.set(n.id, n));
    const leader = leaderInfo?.leader;
    if (leader && !byId.has(leader.id)) byId.set(leader.id, leader);
    return Array.from(byId.values()).sort((a, b) => compareU64(a.id, b.id));
  })();
  const leaderId = leaderInfo?.leader?.id;
  const isPipelineRunning = pipelineState === 'Running' || pipelineState === 'Starting';
  const isClusterMode = clusterStatus?.mode === 'cluster';

  // Real telemetry from /metrics — no fabricated values. Process CPU/memory
  // gauges only exist on Linux builds; the tiles render only when present.
  const uptimeSeconds = value(snap, M.uptimeSeconds) ?? 0;
  const ingestRate = rate(prevSnap, snap, M.eventsIngested);
  const emitRate = rate(prevSnap, snap, M.eventsEmitted);
  const cycleRate = rate(prevSnap, snap, M.cyclesTotal);
  const backpressureRate = rate(prevSnap, snap, M.cyclesBackpressured);
  const eventsIngested = value(snap, M.eventsIngested);
  const eventsEmitted = value(snap, M.eventsEmitted);
  const wsConnections = value(snap, M.wsConnections);
  const watermark = value(snap, M.pipelineWatermark);
  // Lag relative to the scrape time of the snapshot (not render time).
  const watermarkLagSec = snap && watermark && watermark > 0 ? Math.max(0, (snap.at - watermark) / 1000) : undefined;
  const cpuRate = rate(prevSnap, snap, M.processCpuSeconds);
  const rssBytes = value(snap, M.processResidentMemory);

  // Fault & recovery counters
  const faults = value(snap, M.pipelineFaults);
  const restarts = value(snap, M.pipelineRestarts);
  const recoveries = value(snap, M.coordinatedRecoveries);
  const recoveryFailures = value(snap, M.coordinatedRecoveryFailures);
  const framesLost = value(snap, M.shuffleDeliveryLossIncidents);
  const blastRadius = value(snap, M.placementBlastRadius);

  // Checkpoint summary
  const ckptEpoch = value(snap, M.checkpointEpoch);
  const ckptCompleted = value(snap, M.checkpointsCompleted);
  const ckptFailed = value(snap, M.checkpointsFailed);
  const ckptSize = value(snap, M.checkpointSizeBytes);
  const ckptMeanDuration = histogramMean(snap, M.checkpointDuration);
  const latestCkpt = checkpoints.length > 0 ? checkpoints[0] : null;
  const subscriptionOutput = clusterStatus?.subscription_output ?? null;
  const subscriptionCorrectnessFailures = subscriptionOutput
    ? [
        subscriptionOutput.segment_write_failures,
        subscriptionOutput.manifest_failures,
        subscriptionOutput.integrity_failures,
        subscriptionOutput.stale_writer_rejections,
        subscriptionOutput.sequence_gaps,
      ].reduce((total, count) => total + BigInt(count), 0n)
    : null;

  return (
    <div className="tab-page" aria-labelledby="overview-title">
      <ConfirmDialog
        open={confirmPipelineSuspend}
        title="Suspend the pipeline?"
        description={isClusterMode
          ? <>The local node is stopped first, then LaminarDB attempts a fire-and-forget request to each known peer. The HTTP result cannot confirm cluster-wide convergence.</>
          : <>Stream and materialized-view processing stops until you resume the pipeline.</>}
        confirmLabel="Suspend pipeline"
        danger
        busy={pipelineActionLoading}
        onCancel={() => setConfirmPipelineSuspend(false)}
        onConfirm={() => void togglePipeline()}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <h1 id="overview-title" style={{ fontSize: 26, fontWeight: 800, margin: 0 }}>
              {isClusterMode ? 'Cluster Overview' : 'Instance Overview'}
            </h1>
            {uptimeSeconds > 0 && (
              <span style={{ fontSize: 12, fontWeight: 500, color: 'hsl(var(--text-muted))', fontFamily: 'var(--font-mono)' }}>
                Uptime: {formatUptime(uptimeSeconds)}
              </span>
            )}
            {clusterStatus && (
              <span className="badge badge-blue" style={{ fontSize: 11 }}>
                {clusterStatus.mode} · {clusterStatus.node_id}
              </span>
            )}
            {pipelineState && (
              <span className={`badge ${isPipelineRunning ? 'badge-emerald' : pipelineState === 'Faulted' ? 'badge-amber' : 'badge-amber'}`} style={{ fontSize: 11 }}>
                <span className={`pulse-dot ${isPipelineRunning ? 'success' : pipelineState === 'Faulted' ? 'error' : 'warning'}`} style={{ marginRight: 4 }} />
                Pipeline: {pipelineState}
              </span>
            )}
          </div>
          <p style={{ color: 'hsl(var(--text-secondary))', fontSize: 13, marginTop: 4 }}>
            Health, topology, vnode assignments, checkpoints and live engine telemetry.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {pipelineState && (
            <button
              className={`btn ${isPipelineRunning ? 'btn-danger' : 'btn-primary'}`}
              type="button"
              onClick={() => void togglePipeline()}
              disabled={pipelineActionLoading}
              title={isPipelineRunning
                ? 'Suspend pipeline processing (cluster peer fan-out is not acknowledged)'
                : 'Start streaming pipeline processing'}
            >
              {pipelineActionLoading
                ? <RefreshCw size={14} className="animate-spin" />
                : (isPipelineRunning ? <Pause size={14} /> : <PlayCircle size={14} />)}
              <span>{isPipelineRunning ? 'Suspend pipeline' : pipelineState === 'Faulted' ? 'Restart pipeline' : 'Start pipeline'}</span>
            </button>
          )}
          <button className="btn btn-secondary" type="button" disabled={reloadLoading} onClick={() => void reloadConfiguration()} title="Hot-reload supported catalog sections from the server config file">
            <RefreshCw size={14} className={reloadLoading ? 'animate-spin' : ''} aria-hidden="true" />
            <span>{reloadLoading ? 'Reloading…' : 'Reload config'}</span>
          </button>
          <button className="btn btn-primary" type="button" disabled={checkpointLoading} onClick={() => void triggerCheckpoint()} title="Trigger a checkpoint now (aligned barrier)">
            {checkpointLoading ? <RefreshCw size={14} className="animate-spin" aria-hidden="true" /> : <Zap size={14} aria-hidden="true" />}
            <span>{checkpointLoading ? 'Checkpointing…' : 'Trigger checkpoint'}</span>
          </button>
        </div>
      </div>

      {banner && (
        <div
          className="glass-card"
          role={banner.tone === 'error' ? 'alert' : 'status'}
          style={{
            borderColor: banner.tone === 'success' ? 'hsl(var(--status-success))' : banner.tone === 'warning' ? 'hsl(var(--status-warning))' : 'hsl(var(--status-error))',
            background: banner.tone === 'success' ? 'rgba(16,185,129,0.05)' : banner.tone === 'warning' ? 'rgba(234,179,8,0.06)' : 'rgba(239,68,68,0.05)',
            padding: 12,
            display: 'flex',
            gap: 10,
            alignItems: 'flex-start',
          }}
        >
          {banner.tone === 'success' ? <CheckCircle size={16} style={{ color: 'hsl(var(--status-success))', marginTop: 2 }} /> : <AlertCircle size={16} style={{ color: banner.tone === 'warning' ? 'hsl(var(--status-warning))' : 'hsl(var(--status-error))', marginTop: 2 }} />}
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{banner.title}</div>
            {banner.lines.map((l, i) => (
              <div key={i} style={{ fontSize: 12, color: 'hsl(var(--text-secondary))', fontFamily: 'var(--font-mono)' }}>{l}</div>
            ))}
          </div>
          <button className="icon-button" type="button" onClick={() => setBanner(null)} aria-label="Dismiss notification">
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}

      {clusterError && (
        <div className="glass-card" role="alert" style={{ borderColor: 'hsl(var(--status-error))', background: 'rgba(239, 68, 68, 0.05)', color: 'hsl(var(--status-error))', display: 'flex', alignItems: 'center', gap: 8, padding: 12 }}>
          <AlertCircle size={16} />
          <span>Error polling cluster info: {clusterError}</span>
        </div>
      )}

      {metricsError && (
        <div className="notice notice-warning" role="status">
          <AlertCircle size={16} aria-hidden="true" />
          <span>{metricsError}</span>
        </div>
      )}

      {pipelineState === 'Faulted' && pipelineLastError && (
        <div className="glass-card" role="alert" style={{ borderColor: 'hsl(var(--status-error))', background: 'rgba(239, 68, 68, 0.05)', padding: 12, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <ShieldAlert size={16} style={{ color: 'hsl(var(--status-error))', marginTop: 2 }} />
          <div>
            <div style={{ fontWeight: 600, fontSize: 13, color: 'hsl(var(--status-error))' }}>Pipeline faulted</div>
            <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'hsl(var(--text-secondary))' }}>{pipelineLastError}</div>
          </div>
        </div>
      )}

      {/* Topology cards */}
      <div className="grid-container grid-cols-3">
        <div className="glass-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', color: 'hsl(var(--text-muted))', letterSpacing: '0.5px' }}>Leader Node</span>
            <Radio size={16} style={{ color: '#8b5cf6' }} />
          </div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>
            {leaderInfo?.leader ? leaderInfo.leader.name : isClusterMode ? 'Unknown' : 'Not applicable'}
          </div>
          <div style={{ fontSize: 12, color: 'hsl(var(--text-secondary))', marginTop: 4 }}>
            {leaderInfo?.leader ? `RPC: ${leaderInfo.leader.rpc_address}` : isClusterMode ? 'No active leader currently reported' : 'Single-node server — no cluster leader'}
          </div>
        </div>

        <div className="glass-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', color: 'hsl(var(--text-muted))', letterSpacing: '0.5px' }}>Cluster Size</span>
            <Activity size={16} style={{ color: '#10b981' }} />
          </div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>
            {isClusterMode ? `${clusterMembers.length} ${clusterMembers.length === 1 ? 'node' : 'nodes'}` : 'Single node'}
          </div>
          <div style={{ fontSize: 12, color: 'hsl(var(--text-secondary))', marginTop: 4 }}>
            {isClusterMode ? <>
              {clusterMembers.filter(n => n.state === 'Active').length} active
              {clusterMembers.some(n => n.state === 'Suspected') && `, ${clusterMembers.filter(n => n.state === 'Suspected').length} suspected`}
              {clusterMembers.some(n => n.state === 'Draining') && `, ${clusterMembers.filter(n => n.state === 'Draining').length} draining`}
              {clusterMembers.some(n => n.state === 'Joining') && `, ${clusterMembers.filter(n => n.state === 'Joining').length} joining`}
              {clusterMembers.some(n => n.state === 'Left') && `, ${clusterMembers.filter(n => n.state === 'Left').length} left`}
            </> : 'server.mode = "single"'}
          </div>
        </div>

        <div className="glass-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', color: 'hsl(var(--text-muted))', letterSpacing: '0.5px' }}>VNode Assignments</span>
            <Cpu size={16} style={{ color: '#3b82f6' }} />
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
            {vnodes ? Object.keys(vnodes.vnodes).length : isClusterMode ? '0' : 'Not exposed'}
            {vnodes?.draining && (
              <span className="badge badge-amber" style={{ fontSize: 10 }}>
                <span className="pulse-dot warning" style={{ marginRight: 4 }} />
                Rebalancing (drain phase)
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'hsl(var(--text-secondary))', marginTop: 4 }}>
            {vnodes
              ? `Assignment ${vnodes.version} · partition ABI ${vnodes.partitioning_abi_version} · ${vnodes.participants.length} participants`
              : isClusterMode ? 'No durable assignment loaded' : 'The cluster assignment endpoint is unavailable in single-node mode'}
          </div>
        </div>
      </div>

      {isClusterMode && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>Committed Subscription Output</span>
          <div className="grid-container grid-cols-4">
            <StatTile
              label="Gateway readers"
              value={formatWireCount(subscriptionOutput?.active_readers)}
              sub={subscriptionOutput
                ? `${formatWireCount(subscriptionOutput.open_failures)} failed opens since process start`
                : 'Subscription metrics are not attached'}
              tone={subscriptionOutput && BigInt(subscriptionOutput.open_failures) > 0n ? 'warning' : 'default'}
              icon={<Radio size={16} style={{ color: 'hsl(var(--primary))' }} />}
            />
            <StatTile
              label="Pending output"
              value={subscriptionOutput ? formatWireBytes(subscriptionOutput.pending_bytes) : '—'}
              sub="Awaiting checkpoint disposition on this process"
              icon={<Layers size={16} style={{ color: 'hsl(var(--primary))' }} />}
            />
            <StatTile
              label="Retained history"
              value={subscriptionOutput ? formatWireBytes(subscriptionOutput.retained_bytes) : '—'}
              sub={subscriptionOutput && BigInt(subscriptionOutput.orphan_bytes) > 0n
                ? `${formatWireBytes(subscriptionOutput.orphan_bytes)} grace-held orphan output`
                : 'No grace-held orphan output reported'}
              tone={subscriptionOutput && BigInt(subscriptionOutput.orphan_bytes) > 0n ? 'warning' : 'default'}
              icon={<Server size={16} style={{ color: 'hsl(var(--text-muted))' }} />}
            />
            <StatTile
              label="Integrity signals"
              value={subscriptionCorrectnessFailures === null ? '—' : subscriptionCorrectnessFailures.toLocaleString()}
              sub={subscriptionOutput
                ? `${formatWireCount(subscriptionOutput.lag_disconnects)} bounded-lag disconnects`
                : 'No process-local subscription health snapshot'}
              tone={subscriptionCorrectnessFailures && subscriptionCorrectnessFailures > 0n ? 'critical' : 'default'}
              icon={<ShieldAlert size={16} style={{ color: subscriptionCorrectnessFailures && subscriptionCorrectnessFailures > 0n ? 'hsl(var(--status-error))' : 'hsl(var(--text-muted))' }} />}
            />
          </div>
          <p className="protocol-note">
            These totals are process-local and bounded-cardinality. They do not identify streams, partitions, subscribers, or prove cluster-wide health.
          </p>
        </div>
      )}

      {/* Live engine telemetry (all values scraped from /metrics) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>Engine Telemetry</span>
        <div className="grid-container grid-cols-4">
          <StatTile
            label="Ingestion rate"
            value={formatRate(ingestRate)}
            sub={`Total: ${formatCompact(eventsIngested)} events`}
            icon={<Zap size={16} style={{ color: 'hsl(var(--status-success))' }} />}
            trend={rateSeries(M.eventsIngested)}
          />
          <StatTile
            label="Emission rate"
            value={formatRate(emitRate)}
            sub={`Total: ${formatCompact(eventsEmitted)} events`}
            icon={<Activity size={16} style={{ color: 'hsl(var(--primary))' }} />}
            trend={rateSeries(M.eventsEmitted)}
          />
          <StatTile
            label="Processing cycles"
            value={formatRate(cycleRate)}
            sub={backpressureRate !== undefined && backpressureRate > 0 ? `${formatRate(backpressureRate)} backpressured` : 'No backpressure'}
            tone={backpressureRate !== undefined && backpressureRate > 0 ? 'warning' : 'default'}
            icon={<RefreshCw size={16} style={{ color: 'hsl(var(--primary))' }} />}
            trend={rateSeries(M.cyclesTotal)}
          />
          <StatTile
            label="Watermark lag"
            value={watermarkLagSec === undefined ? '—' : formatSeconds(watermarkLagSec)}
            sub={wsConnections !== undefined ? `${wsConnections} live WS subscriber${wsConnections === 1 ? '' : 's'}` : undefined}
            icon={<Layers size={16} style={{ color: 'hsl(var(--primary))' }} />}
          />
        </div>
        {(cpuRate !== undefined || rssBytes !== undefined) && (
          <div className="grid-container grid-cols-4">
            {cpuRate !== undefined && (
              <StatTile
                label="CPU"
                value={`${(cpuRate * 100).toFixed(1)}%`}
                sub="Process CPU (from /metrics)"
                icon={<Cpu size={16} style={{ color: 'hsl(var(--primary))' }} />}
              />
            )}
            {rssBytes !== undefined && (
              <StatTile
                label="Memory (RSS)"
                value={formatBytes(rssBytes)}
                sub="Process resident set size"
                icon={<Layers size={16} style={{ color: 'hsl(var(--primary))' }} />}
              />
            )}
          </div>
        )}
      </div>

      {/* Fault & recovery */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>Fault & Recovery</span>
        <div className="grid-container grid-cols-4">
          <StatTile
            label="Pipeline faults"
            value={formatCompact(faults)}
            sub={`${formatCompact(restarts)} auto-restarts from checkpoint`}
            tone={faults && faults > 0 ? 'warning' : 'default'}
            icon={<ShieldAlert size={16} style={{ color: faults && faults > 0 ? '#b45309' : 'hsl(var(--text-muted))' }} />}
          />
          <StatTile
            label="Coordinated recoveries"
            value={formatCompact(recoveries)}
            sub={recoveryFailures && recoveryFailures > 0 ? `${formatCompact(recoveryFailures)} abandoned` : 'No abandoned rounds'}
            tone={recoveryFailures && recoveryFailures > 0 ? 'critical' : 'default'}
            icon={<RefreshCw size={16} style={{ color: 'hsl(var(--text-muted))' }} />}
          />
          <StatTile
            label="Shuffle loss incidents"
            value={formatCompact(framesLost)}
            sub="Each incident fences an epoch and forces replay"
            tone={framesLost && framesLost > 0 ? 'critical' : 'default'}
            icon={<Server size={16} style={{ color: 'hsl(var(--text-muted))' }} />}
          />
          <StatTile
            label="Blast radius"
            value={blastRadius === undefined ? '—' : `${(blastRadius * 100).toFixed(0)}%`}
            sub="Largest failure domain's vnode share"
            icon={<Cpu size={16} style={{ color: 'hsl(var(--text-muted))' }} />}
          />
        </div>
      </div>

      {/* Node details table */}
      {isClusterMode && <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-translucent)', fontWeight: 600, fontSize: 14 }}>
          Cluster Members
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="meta-table">
            <caption className="sr-only">Current LaminarDB cluster membership</caption>
            <thead>
              <tr>
                <th scope="col">Node ID</th>
                <th scope="col">Name</th>
                <th scope="col">State</th>
                <th scope="col">gRPC Address</th>
                <th scope="col">Failure Domain</th>
                <th scope="col">Capacity</th>
                <th scope="col">Version</th>
                <th scope="col">Last Heartbeat</th>
              </tr>
            </thead>
            <tbody>
              {clusterMembers.length === 0 ? (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', color: 'hsl(var(--text-muted))', padding: 20 }}>
                    No cluster members are currently reported.
                  </td>
                </tr>
              ) : (
                clusterMembers.map((node) => (
                  <tr key={node.id}>
                    <td style={{ fontWeight: 600, fontFamily: 'var(--font-mono)', fontSize: 12 }}>{node.id}</td>
                    <td>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        {node.name}
                        {node.id === leaderId && (
                          <span className="badge badge-purple" style={{ fontSize: '9px', padding: '1px 5px' }}>Leader</span>
                        )}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${nodeStateBadge(node.state)}`}>
                        <span className={`pulse-dot ${node.state === 'Active' ? 'success' : node.state === 'Left' ? 'error' : 'warning'}`} style={{ marginRight: 4 }} />
                        {node.state}
                      </span>
                    </td>
                    <td style={{ fontFamily: 'var(--font-mono)' }}>{node.rpc_address}</td>
                    <td style={{ fontSize: 12 }}>{node.metadata?.failure_domain || '—'}</td>
                    <td style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>
                      {node.metadata.cores} cores
                      {BigInt(node.metadata.memory_bytes) > 0n && ` / ${formatWireBytes(node.metadata.memory_bytes)}`}
                    </td>
                    <td style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>{node.metadata?.version || '—'}</td>
                    <td style={{ color: 'hsl(var(--text-muted))' }}>
                      {new Date(node.last_heartbeat_ms).toLocaleTimeString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>}

      {/* Vnode assignments heatmap */}
      {(() => {
        if (!vnodes || Object.keys(vnodes.vnodes).length === 0) return null;

        const vnodeIndices = Object.keys(vnodes.vnodes)
          .map(Number)
          .filter(Number.isSafeInteger)
          .sort((left, right) => left - right);
        const expectedVnodeCount = (vnodeIndices.at(-1) ?? -1) + 1;
        const vnodeCount = vnodeIndices.length;
        const missingIndices = Math.max(0, expectedVnodeCount - vnodeCount);
        const ownerOf = (vidx: number): string | undefined => vnodes.vnodes[String(vidx)];

        const allNodeIds = Array.from(new Set([
          ...clusterMembers.map(n => n.id),
          ...Object.values(vnodes.vnodes),
        ])).sort(compareU64);

        const counts: Record<string, number> = {};
        allNodeIds.forEach(id => { counts[id] = 0; });
        for (const owner of Object.values(vnodes.vnodes)) {
          counts[owner] = (counts[owner] || 0) + 1;
        }

        const activeNodeIds = clusterMembers.map(n => n.id);
        const assignedCounts = activeNodeIds.map(id => counts[id] || 0);

        let balanceStatus = 'Balanced';
        let balanceColor = 'hsl(var(--status-success))';

        if (vnodes.draining) {
          balanceStatus = 'Rebalancing — drain phase';
          balanceColor = 'hsl(var(--status-warning))';
        } else if (missingIndices > 0) {
          balanceStatus = `${missingIndices} missing vnode map entr${missingIndices === 1 ? 'y' : 'ies'}`;
          balanceColor = 'hsl(var(--status-error))';
        } else if (assignedCounts.length > 1) {
          const maxVal = Math.max(...assignedCounts);
          const minVal = Math.min(...assignedCounts);
          const diff = maxVal - minVal;
          if (diff <= 1) {
            balanceStatus = 'Even owner counts';
          } else {
            balanceStatus = `Owner-count spread: ${diff}`;
            balanceColor = 'hsl(var(--status-warning))';
          }
        } else if (assignedCounts.length === 1) {
          balanceStatus = 'Single-node cluster';
          balanceColor = 'hsl(199 89% 48%)';
        } else {
          balanceStatus = 'No Active Nodes';
          balanceColor = 'hsl(var(--status-error))';
        }

        return (
          <div className="glass-card" style={{ padding: 20 }}>
            <div className="grid-container grid-cols-2" style={{ gap: 24 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>VNode Assignment Map</span>
                  <span style={{ fontSize: 11, color: 'hsl(var(--text-muted))' }}>
                    v{vnodes.version} &bull; Updated: {new Date(vnodes.updated_at_ms).toLocaleTimeString()}
                  </span>
                </div>

                <div style={{ maxWidth: '380px', width: '100%' }}>
                  <div
                    className="heatmap-grid"
                    style={{ maxWidth: '380px', margin: 0 }}
                    role="img"
                    aria-label={`${vnodeCount} vnode assignments across ${allNodeIds.length} owners${missingIndices ? `, ${missingIndices} missing map entries` : ''}`}
                  >
                    {Array.from({ length: expectedVnodeCount }).map((_, vidx) => {
                      const ownerNodeId = ownerOf(vidx);
                      const cellColor = ownerNodeId !== undefined ? getNodeColor(ownerNodeId, allNodeIds) : 'hsl(var(--bg-base))';
                      const nodeObj = clusterMembers.find(n => n.id === ownerNodeId);
                      const ownerName = nodeObj ? nodeObj.name : `Node ${ownerNodeId}`;
                      return (
                        <div
                          key={`vnode-${vidx}`}
                          className="heatmap-cell"
                          style={{ backgroundColor: cellColor, height: 'auto' }}
                          title={`VNode ${vidx} owned by ${ownerNodeId !== undefined ? `${ownerName} (ID: ${ownerNodeId})` : 'Unassigned'}`}
                          aria-hidden="true"
                        />
                      );
                    })}
                  </div>
                </div>

                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 4 }}>
                  {allNodeIds.map(nodeId => {
                    const node = clusterMembers.find(n => n.id === nodeId);
                    const name = node ? node.name : `Node ${nodeId}`;
                    return (
                      <div key={`legend-${nodeId}`} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                        <span style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: getNodeColor(nodeId, allNodeIds), display: 'inline-block' }} />
                        <span style={{ color: 'hsl(var(--text-secondary))' }}>{name}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>Partition Balance</span>

                <div style={{ display: 'flex', gap: 12 }}>
                  <div className="glass-card" style={{ flex: 1, padding: '10px 12px', background: 'rgba(15, 23, 42, 0.01)' }}>
                    <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: 'hsl(var(--text-muted))', letterSpacing: '0.5px', marginBottom: 4 }}>
                      Balance Status
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: balanceColor, display: 'inline-block' }} />
                      <span style={{ fontSize: 13, fontWeight: 600, color: balanceColor }}>{balanceStatus}</span>
                    </div>
                  </div>

                  <div className="glass-card" style={{ flex: 1, padding: '10px 12px', background: 'rgba(15, 23, 42, 0.01)' }}>
                    <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: 'hsl(var(--text-muted))', letterSpacing: '0.5px', marginBottom: 4 }}>
                      Keyspace Coverage
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'hsl(var(--text-primary))' }}>
                      {expectedVnodeCount === 0 ? '0' : (((expectedVnodeCount - missingIndices) / expectedVnodeCount) * 100).toFixed(0)}% represented
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 4 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: 'hsl(var(--text-muted))', letterSpacing: '0.5px' }}>
                    Node Allocation Breakdown
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: '180px', overflowY: 'auto', paddingRight: 4 }}>
                    {allNodeIds.map(nodeId => {
                      const node = clusterMembers.find(n => n.id === nodeId);
                      const name = node ? node.name : `Node ${nodeId}`;
                      const count = counts[nodeId] || 0;
                      const pct = ((count / vnodeCount) * 100).toFixed(1);
                      const nodeColor = getNodeColor(nodeId, allNodeIds);
                      const isInactive = node && node.state !== 'Active';

                      return (
                        <div key={`breakdown-${nodeId}`} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500, color: isInactive ? 'hsl(var(--text-muted))' : 'hsl(var(--text-primary))' }}>
                              <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: nodeColor, display: 'inline-block' }} />
                              {name} {isInactive && <span style={{ fontSize: 10, color: 'hsl(var(--status-warning))' }}>({node.state})</span>}
                            </span>
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'hsl(var(--text-secondary))' }}>
                              {count} VNodes ({pct}%)
                            </span>
                          </div>
                          <div style={{ width: '100%', height: 4, backgroundColor: 'rgba(15, 23, 42, 0.08)', borderRadius: 2, overflow: 'hidden' }}>
                            <div style={{ width: `${pct}%`, height: '100%', backgroundColor: nodeColor, borderRadius: 2 }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Checkpoint summary */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>Checkpointing</span>
        <div className="grid-container grid-cols-4">
          <StatTile
            label="Current epoch"
            value={formatCompact(ckptEpoch)}
            sub={latestCkpt ? `Checkpoint #${latestCkpt.checkpoint_id}` : undefined}
            icon={<Zap size={16} style={{ color: 'hsl(var(--primary))' }} />}
          />
          <StatTile
            label="Completed"
            value={formatCompact(ckptCompleted)}
            sub={ckptFailed !== undefined && ckptFailed > 0 ? `${formatCompact(ckptFailed)} failed` : 'No failures'}
            tone={ckptFailed !== undefined && ckptFailed > 0 ? 'warning' : 'default'}
            icon={<CheckCircle size={16} style={{ color: 'hsl(var(--status-success))' }} />}
          />
          <StatTile
            label="Last size"
            value={formatBytes(ckptSize)}
            icon={<Layers size={16} style={{ color: 'hsl(var(--text-muted))' }} />}
          />
          <StatTile
            label="Mean duration"
            value={formatSeconds(ckptMeanDuration)}
            sub="Cumulative since start"
            icon={<Activity size={16} style={{ color: 'hsl(var(--text-muted))' }} />}
          />
        </div>

        <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--border-translucent)', fontWeight: 600, fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Latest Durable Checkpoint</span>
            <span style={{ fontSize: 11, color: 'hsl(var(--text-muted))', fontWeight: 400 }}>
              Current SHOW CHECKPOINT STATUS row (not a history endpoint)
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="meta-table">
              <caption className="sr-only">Latest checkpoint status</caption>
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
                {checkpoints.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ textAlign: 'center', color: 'hsl(var(--text-muted))', padding: 20 }}>
                      No checkpoint recorded yet. Checkpoints run automatically on the configured interval.
                    </td>
                  </tr>
                ) : (
                  checkpoints.map((cp, idx) => (
                    <tr key={idx}>
                      <td style={{ fontWeight: 600 }}>{cp.checkpoint_id ?? 'N/A'}</td>
                      <td style={{ fontFamily: 'var(--font-mono)' }}>{cp.epoch ?? 'N/A'}</td>
                      <td>{cp.sources || 'None'}</td>
                      <td>{cp.sinks || 'None'}</td>
                      <td>{cp.completed_this_runtime}</td>
                      <td style={{ color: 'hsl(var(--text-muted))' }}>
                        {cp.timestamp_ms !== '0' ? new Date(Number(cp.timestamp_ms)).toLocaleString() : 'Not recorded'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
