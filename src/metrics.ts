// Prometheus text-format parser + derived-metric helpers for the LaminarDB
// /metrics endpoint.
//
// Metric names are grounded in crates/laminar-db/src/engine_metrics.rs,
// crates/laminar-server/src/metrics.rs and the connector *metrics.rs files.
// Every series carries the `laminardb_` namespace prefix plus constant
// `instance` and `pipeline` labels.

import { api } from './api';

export interface MetricSample {
  labels: Record<string, string>;
  value: number;
}

export type MetricType = 'counter' | 'gauge' | 'histogram' | 'summary' | 'untyped';

export interface MetricFamily {
  name: string;
  type: MetricType;
  help: string;
  samples: MetricSample[];
  /** For histograms: bucket samples (le label), plus _sum/_count. */
  buckets: MetricSample[];
  sum?: number;
  count?: number;
}

export interface MetricsSnapshot {
  at: number; // ms epoch when scraped
  families: Map<string, MetricFamily>;
}

// ---------------------------------------------------------------------------
// Parsing

function parseLabels(block: string): Record<string, string> {
  const labels: Record<string, string> = {};
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    labels[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  }
  return labels;
}

export function parsePrometheusText(text: string): MetricsSnapshot {
  const families = new Map<string, MetricFamily>();
  const typeByName = new Map<string, MetricType>();
  const helpByName = new Map<string, string>();

  const ensureFamily = (name: string): MetricFamily => {
    let fam = families.get(name);
    if (!fam) {
      fam = {
        name,
        type: typeByName.get(name) ?? 'untyped',
        help: helpByName.get(name) ?? '',
        samples: [],
        buckets: [],
      };
      families.set(name, fam);
    }
    return fam;
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('# TYPE ')) {
      const parts = line.slice(7).split(/\s+/);
      if (parts.length >= 2) {
        typeByName.set(parts[0], parts[1] as MetricType);
        const fam = families.get(parts[0]);
        if (fam) fam.type = parts[1] as MetricType;
      }
      continue;
    }
    if (line.startsWith('# HELP ')) {
      const rest = line.slice(7);
      const sp = rest.indexOf(' ');
      if (sp > 0) {
        helpByName.set(rest.slice(0, sp), rest.slice(sp + 1));
        const fam = families.get(rest.slice(0, sp));
        if (fam) fam.help = rest.slice(sp + 1);
      }
      continue;
    }
    if (line.startsWith('#')) continue;

    // Sample line: name{labels} value [timestamp]
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+([^\s]+)/);
    if (!m) continue;
    const [, sampleName, labelBlock, valueStr] = m;
    const value = Number(valueStr);
    // NaN and infinities are valid Prometheus tokens but cannot produce a
    // meaningful chart/rate in the console. Keep the family discoverable via
    // TYPE/HELP and omit only the unusable sample.
    if (!Number.isFinite(value)) continue;

    const labels = labelBlock ? parseLabels(labelBlock) : {};

    // Histogram/summary internal series roll up under the declared family name.
    let base = sampleName;
    let kind: 'sample' | 'bucket' | 'sum' | 'count' = 'sample';
    for (const suffix of ['_bucket', '_sum', '_count'] as const) {
      if (sampleName.endsWith(suffix)) {
        const candidate = sampleName.slice(0, -suffix.length);
        const t = typeByName.get(candidate);
        if (t === 'histogram' || t === 'summary') {
          base = candidate;
          kind = suffix === '_bucket' ? 'bucket' : suffix === '_sum' ? 'sum' : 'count';
          break;
        }
      }
    }

    const fam = ensureFamily(base);
    if (kind === 'bucket') {
      fam.buckets.push({ labels, value });
    } else if (kind === 'sum') {
      fam.sum = (fam.sum ?? 0) + value;
    } else if (kind === 'count') {
      fam.count = (fam.count ?? 0) + value;
    } else {
      fam.samples.push({ labels, value });
    }
  }

  return { at: Date.now(), families };
}

// ---------------------------------------------------------------------------
// Value helpers

/** Sum of all samples of a family (single-sample gauges/counters just return the value). */
export function value(snap: MetricsSnapshot | null, name: string): number | undefined {
  const fam = snap?.families.get(name);
  if (!fam || fam.samples.length === 0) return undefined;
  return fam.samples.reduce((acc, s) => acc + s.value, 0);
}

/** Sum only samples whose labels include every requested key/value pair. */
export function valueMatching(
  snap: MetricsSnapshot | null,
  name: string,
  matchingLabels: Record<string, string>,
): number | undefined {
  const samples = snap?.families.get(name)?.samples.filter(
    (sample) => Object.entries(matchingLabels).every(([key, expected]) => sample.labels[key] === expected),
  );
  if (!samples?.length) return undefined;
  return samples.reduce((total, sample) => total + sample.value, 0);
}

/** Per-label breakdown, e.g. labeledValues(snap, 'laminardb_operator_state_bytes', 'operator'). */
export function labeledValues(
  snap: MetricsSnapshot | null,
  name: string,
  labelKey: string,
  matchingLabels: Record<string, string> = {},
): { label: string; value: number }[] {
  const fam = snap?.families.get(name);
  if (!fam) return [];
  const byLabel = new Map<string, number>();
  for (const s of fam.samples) {
    if (Object.entries(matchingLabels).some(([key, expected]) => s.labels[key] !== expected)) continue;
    const l = s.labels[labelKey];
    if (l === undefined) continue;
    byLabel.set(l, (byLabel.get(l) ?? 0) + s.value);
  }
  return Array.from(byLabel, ([label, v]) => ({ label, value: v })).sort((a, b) => b.value - a.value);
}

/** Every finite sample of a family with its full label set (constant labels included). */
export function samples(snap: MetricsSnapshot | null, name: string): MetricSample[] {
  return snap?.families.get(name)?.samples ?? [];
}

/** Whether any family with this prefix appears in the scrape (connector instantiated). */
export function hasFamilyPrefix(snap: MetricsSnapshot | null, prefix: string): boolean {
  if (!snap) return false;
  for (const name of snap.families.keys()) {
    if (name.startsWith(prefix)) return true;
  }
  return false;
}

/** Counter rate per second between two snapshots. Clamped at 0 across restarts. */
export function rate(
  prev: MetricsSnapshot | null,
  curr: MetricsSnapshot | null,
  name: string
): number | undefined {
  if (!prev || !curr) return undefined;
  const a = value(prev, name);
  const b = value(curr, name);
  if (a === undefined || b === undefined) return undefined;
  const dt = (curr.at - prev.at) / 1000;
  if (dt <= 0) return undefined;
  return Math.max(0, (b - a) / dt);
}

interface Bucket {
  le: number;
  count: number;
}

function cumulativeBuckets(fam: MetricFamily | undefined): Bucket[] {
  if (!fam) return [];
  const byLe = new Map<number, number>();
  for (const b of fam.buckets) {
    const le = b.labels.le === '+Inf' ? Number.POSITIVE_INFINITY : Number(b.labels.le);
    if (Number.isNaN(le)) continue;
    byLe.set(le, (byLe.get(le) ?? 0) + b.value);
  }
  return Array.from(byLe, ([le, count]) => ({ le, count })).sort((a, b) => a.le - b.le);
}

/**
 * Approximate quantile from Prometheus cumulative histogram buckets with
 * linear interpolation (same approach as PromQL histogram_quantile). When
 * `prev` is given, the quantile covers only the window between snapshots.
 */
export function histogramQuantile(
  snap: MetricsSnapshot | null,
  name: string,
  q: number,
  prev?: MetricsSnapshot | null
): number | undefined {
  const currB = cumulativeBuckets(snap?.families.get(name));
  if (currB.length === 0) return undefined;

  let buckets = currB;
  if (prev) {
    const prevB = cumulativeBuckets(prev.families.get(name));
    const prevByLe = new Map(prevB.map((b) => [b.le, b.count]));
    buckets = currB.map((b) => ({ le: b.le, count: Math.max(0, b.count - (prevByLe.get(b.le) ?? 0)) }));
  }

  const total = buckets[buckets.length - 1]?.count ?? 0;
  if (total <= 0) return undefined;

  const target = q * total;
  let prevCount = 0;
  let prevLe = 0;
  for (const b of buckets) {
    if (b.count >= target) {
      if (!Number.isFinite(b.le)) return prevLe; // +Inf bucket: report lower bound
      const bucketCount = b.count - prevCount;
      if (bucketCount <= 0) return b.le;
      return prevLe + ((b.le - prevLe) * (target - prevCount)) / bucketCount;
    }
    prevCount = b.count;
    prevLe = Number.isFinite(b.le) ? b.le : prevLe;
  }
  return prevLe;
}

/** Mean of a histogram over the window between snapshots (or cumulative). */
export function histogramMean(
  snap: MetricsSnapshot | null,
  name: string,
  prev?: MetricsSnapshot | null
): number | undefined {
  const fam = snap?.families.get(name);
  if (!fam || fam.sum === undefined || fam.count === undefined) return undefined;
  let sum = fam.sum;
  let count = fam.count;
  if (prev) {
    const pf = prev.families.get(name);
    if (pf && pf.sum !== undefined && pf.count !== undefined) {
      sum -= pf.sum;
      count -= pf.count;
    }
  }
  if (count <= 0) return undefined;
  return sum / count;
}

// ---------------------------------------------------------------------------
// Shared polling history (module-level so chart history survives tab switches)

const HISTORY_CAPACITY = 240; // 20 min at 5s cadence

const history: MetricsSnapshot[] = [];
let lastFetchAt = 0;
let inFlight: Promise<MetricsSnapshot | null> | null = null;

/**
 * Fetch a fresh snapshot and append it to the shared history. Coalesces
 * concurrent callers and enforces a minimum spacing so multiple mounted
 * panels don't double-scrape.
 */
export async function fetchMetricsSnapshot(minIntervalMs = 2000): Promise<MetricsSnapshot | null> {
  const now = Date.now();
  if (inFlight) return inFlight;
  if (now - lastFetchAt < minIntervalMs && history.length > 0) {
    return history[history.length - 1];
  }
  inFlight = (async () => {
    try {
      const text = await api.getMetricsRaw();
      const snap = parsePrometheusText(text);
      lastFetchAt = Date.now();
      history.push(snap);
      if (history.length > HISTORY_CAPACITY) history.splice(0, history.length - HISTORY_CAPACITY);
      return snap;
    } catch {
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function metricsHistory(): MetricsSnapshot[] {
  return history;
}

export function latestSnapshot(): MetricsSnapshot | null {
  return history.length ? history[history.length - 1] : null;
}

export function previousSnapshot(): MetricsSnapshot | null {
  return history.length > 1 ? history[history.length - 2] : null;
}

export interface TimePoint {
  t: number;
  v: number;
}

/** Gauge value over the polling history. */
export function gaugeSeries(name: string, matchingLabels?: Record<string, string>): TimePoint[] {
  const pts: TimePoint[] = [];
  for (const snap of history) {
    const v = matchingLabels ? valueMatching(snap, name, matchingLabels) : value(snap, name);
    if (v !== undefined) pts.push({ t: snap.at, v });
  }
  return pts;
}

/** Counter rate (per second) over the polling history. */
export function rateSeries(name: string): TimePoint[] {
  const pts: TimePoint[] = [];
  for (let i = 1; i < history.length; i++) {
    const r = rate(history[i - 1], history[i], name);
    if (r !== undefined) pts.push({ t: history[i].at, v: r });
  }
  return pts;
}

/** Windowed histogram quantile over the polling history. */
export function quantileSeries(name: string, q: number): TimePoint[] {
  const pts: TimePoint[] = [];
  for (let i = 1; i < history.length; i++) {
    const v = histogramQuantile(history[i], name, q, history[i - 1]);
    if (v !== undefined) pts.push({ t: history[i].at, v });
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Metric name constants (verified against engine_metrics.rs / metrics.rs)

export const M = {
  // Server
  uptimeSeconds: 'laminardb_uptime_seconds',
  wsConnections: 'laminardb_ws_connections',
  reloadTotal: 'laminardb_reload_total',
  // Engine
  eventsIngested: 'laminardb_events_ingested_total',
  eventsEmitted: 'laminardb_events_emitted_total',
  eventsDropped: 'laminardb_events_dropped_total',
  cyclesTotal: 'laminardb_cycles_total',
  batchesTotal: 'laminardb_batches_total',
  queriesCompiled: 'laminardb_queries_compiled_total',
  queriesCachedPlan: 'laminardb_queries_cached_plan_total',
  cyclesBackpressured: 'laminardb_cycles_backpressured_total',
  cycleDuration: 'laminardb_cycle_duration_seconds',
  cycleExecuteDuration: 'laminardb_cycle_execute_duration_seconds',
  cycleOutputStoreDuration: 'laminardb_cycle_output_store_duration_seconds',
  cycleSinkEnqueueDuration: 'laminardb_cycle_sink_enqueue_duration_seconds',
  operatorProcessDuration: 'laminardb_operator_process_duration_seconds',
  windowLateDropped: 'laminardb_window_late_dropped_total',
  eventsNullTimestamp: 'laminardb_events_null_timestamp_total',
  // Materialized views
  mvUpdates: 'laminardb_mv_updates_total',
  mvBytesStored: 'laminardb_mv_bytes_stored',
  // Operator-reported managed state (labels: operator, phase)
  managedStateAccountedBytes: 'laminardb_managed_state_accounted_bytes',
  // Watermarks & buffering
  pipelineWatermark: 'laminardb_pipeline_watermark',
  sourceWatermarkMs: 'laminardb_source_watermark_ms',
  sourceIdle: 'laminardb_source_idle',
  streamWatermarkMs: 'laminardb_stream_watermark_ms',
  inputBufBytes: 'laminardb_input_buf_bytes',
  shedRecords: 'laminardb_shed_records_total',
  // Checkpointing
  checkpointsCompleted: 'laminardb_checkpoints_completed_total',
  checkpointsFailed: 'laminardb_checkpoints_failed_total',
  checkpointEpoch: 'laminardb_checkpoint_epoch',
  checkpointSizeBytes: 'laminardb_checkpoint_size_bytes',
  checkpointDuration: 'laminardb_checkpoint_duration_seconds',
  checkpointStateCapture: 'laminardb_checkpoint_state_capture_duration_seconds',
  checkpointStall: 'laminardb_checkpoint_pipeline_stall_duration_seconds',
  checkpointBarrierLocal: 'laminardb_checkpoint_barrier_local_duration_seconds',
  checkpointAlignedResumeWait: 'laminardb_checkpoint_aligned_resume_wait_seconds',
  sinkPrecommitDuration: 'laminardb_sink_precommit_duration_seconds',
  // Sink write path
  sinkWriteFailures: 'laminardb_sink_write_failures_total',
  sinkWriteTimeouts: 'laminardb_sink_write_timeouts_total',
  sinkTaskChannelClosed: 'laminardb_sink_task_channel_closed_total',
  sinkFilterRejectedRows: 'laminardb_sink_filter_rejected_rows_total',
  // Temporal filters and lookups
  temporalFilterBuffered: 'laminardb_temporal_filter_buffered',
  temporalFilterInserts: 'laminardb_temporal_filter_inserts_total',
  temporalFilterRetracts: 'laminardb_temporal_filter_retracts_total',
  temporalFilterDropped: 'laminardb_temporal_filter_dropped_total',
  lookupCacheHits: 'laminardb_lookup_cache_hits_total',
  lookupCacheMisses: 'laminardb_lookup_cache_misses_total',
  lookupSourceErrors: 'laminardb_lookup_source_errors_total',
  lookupInFlightRows: 'laminardb_lookup_in_flight_rows',
  // Cluster / recovery / placement
  placementVnodesPerDomain: 'laminardb_placement_vnodes_per_domain',
  placementBlastRadius: 'laminardb_placement_blast_radius_ratio',
  pipelineFaults: 'laminardb_pipeline_faults_total',
  pipelineCycleErrors: 'laminardb_pipeline_cycle_errors_total',
  pipelineRestarts: 'laminardb_pipeline_restarts_total',
  coordinatedRecoveries: 'laminardb_coordinated_recoveries_total',
  coordinatedRecoveryFailures: 'laminardb_coordinated_recovery_failures_total',
  shuffleDeliveryLossIncidents: 'laminardb_shuffle_delivery_loss_incidents_total',
  // Checkpoint-committed cluster subscriptions (no variable identity labels)
  clusterSubscriptionActiveReaders: 'laminardb_cluster_subscription_active_readers',
  clusterSubscriptionOpenTotal: 'laminardb_cluster_subscription_open_total',
  clusterSubscriptionOpenFailures: 'laminardb_cluster_subscription_open_failures_total',
  clusterSubscriptionFramesCommitted: 'laminardb_cluster_subscription_frames_committed_total',
  clusterSubscriptionRowsCommitted: 'laminardb_cluster_subscription_rows_committed_total',
  clusterSubscriptionBytesCommitted: 'laminardb_cluster_subscription_bytes_committed_total',
  clusterSubscriptionSegmentsWritten: 'laminardb_cluster_subscription_segments_written_total',
  clusterSubscriptionSegmentWriteFailures: 'laminardb_cluster_subscription_segment_write_failures_total',
  clusterSubscriptionManifestFailures: 'laminardb_cluster_subscription_manifest_failures_total',
  clusterSubscriptionIntegrityFailures: 'laminardb_cluster_subscription_integrity_failures_total',
  clusterSubscriptionStaleWriterRejections: 'laminardb_cluster_subscription_stale_writer_rejections_total',
  clusterSubscriptionSequenceGaps: 'laminardb_cluster_subscription_sequence_gaps_total',
  clusterSubscriptionReplayBytes: 'laminardb_cluster_subscription_replay_bytes_total',
  clusterSubscriptionReplayFrames: 'laminardb_cluster_subscription_replay_frames_total',
  clusterSubscriptionReplayPruned: 'laminardb_cluster_subscription_replay_pruned_total',
  clusterSubscriptionLagDisconnects: 'laminardb_cluster_subscription_gateway_lag_disconnects_total',
  clusterSubscriptionPendingBytes: 'laminardb_cluster_subscription_pending_bytes',
  clusterSubscriptionRetainedBytes: 'laminardb_cluster_subscription_retained_bytes',
  clusterSubscriptionOrphanBytes: 'laminardb_cluster_subscription_orphan_bytes',
  clusterSubscriptionCheckpointPrepare: 'laminardb_cluster_subscription_checkpoint_prepare_seconds',
  clusterSubscriptionCommitVisibility: 'laminardb_cluster_subscription_commit_visibility_seconds',
  clusterSubscriptionManifestRefresh: 'laminardb_cluster_subscription_gateway_manifest_refresh_seconds',
  // Ownership and bounded source admission (0.32)
  placementOwnedVnodes: 'laminardb_placement_owned_vnodes',
  sourceQueueReservedBytes: 'laminardb_source_queue_reserved_bytes',
  // Control-plane schema resolution. Registered with its own `laminar_` prefix
  // inside the `laminardb` registry, so the scraped name is double-prefixed.
  schemaResolutionSeconds: 'laminardb_laminar_schema_resolution_seconds',
  schemaResolutionTotal: 'laminardb_laminar_schema_resolution_total',
  schemaResolutionActive: 'laminardb_laminar_schema_resolution_active',
  // Kafka source (process-wide unless noted)
  kafkaSourceRecordsPolled: 'laminardb_kafka_source_records_polled_total',
  kafkaSourceBytesPolled: 'laminardb_kafka_source_bytes_polled_total',
  kafkaSourceErrors: 'laminardb_kafka_source_errors_total',
  kafkaSourceCommits: 'laminardb_kafka_source_commits_total',
  kafkaSourceCommitFailures: 'laminardb_kafka_source_commit_failures_total',
  kafkaSourceRebalances: 'laminardb_kafka_source_rebalances_total',
  kafkaSourceSchemaCacheHits: 'laminardb_kafka_source_schema_cache_hits_total',
  kafkaSourceSchemaCacheMisses: 'laminardb_kafka_source_schema_cache_misses_total',
  kafkaSourceSchemaFetchFailures: 'laminardb_kafka_source_schema_fetch_failures_total',
  kafkaSourceSchemaUnresolvedRecords: 'laminardb_kafka_source_schema_unresolved_records',
  // Per-source (`source` const label) and per-`topic`/`partition` progress.
  kafkaSourceReaderLag: 'laminardb_kafka_source_reader_lag_offsets',
  kafkaSourceLagSampleAvailable: 'laminardb_kafka_source_lag_sample_available',
  kafkaSourceLagSampleTimestamp: 'laminardb_kafka_source_lag_sample_timestamp_seconds',
  kafkaSourceLastBatchTimestamp: 'laminardb_kafka_source_last_batch_timestamp_seconds',
  // Kafka sink (no transactional families exist; exactly-once is not separately metered)
  kafkaSinkRecordsWritten: 'laminardb_kafka_sink_records_written_total',
  kafkaSinkBytesWritten: 'laminardb_kafka_sink_bytes_written_total',
  kafkaSinkErrors: 'laminardb_kafka_sink_errors_total',
  kafkaSinkDlqRecords: 'laminardb_kafka_sink_dlq_records_total',
  kafkaSinkSerializationErrors: 'laminardb_kafka_sink_serialization_errors_total',
  kafkaSinkProduceLatencySumUs: 'laminardb_kafka_sink_produce_latency_sum_us',
  kafkaSinkProduceLatencyCount: 'laminardb_kafka_sink_produce_latency_count',
  kafkaSinkProduceLatencyMaxUs: 'laminardb_kafka_sink_produce_latency_max_us',
  // PostgreSQL CDC
  postgresCdcEvents: 'laminardb_postgres_cdc_events_received_total',
  postgresCdcBytes: 'laminardb_postgres_cdc_bytes_received_total',
  postgresCdcInserts: 'laminardb_postgres_cdc_inserts_total',
  postgresCdcUpdates: 'laminardb_postgres_cdc_updates_total',
  postgresCdcDeletes: 'laminardb_postgres_cdc_deletes_total',
  postgresCdcTransactions: 'laminardb_postgres_cdc_transactions_total',
  postgresCdcSnapshotRows: 'laminardb_postgres_cdc_snapshot_rows_total',
  postgresCdcConfirmedFlushLsn: 'laminardb_postgres_cdc_confirmed_flush_lsn',
  postgresCdcReplicationLagBytes: 'laminardb_postgres_cdc_replication_lag_bytes',
  postgresCdcOrphanedSlots: 'laminardb_postgres_cdc_orphaned_slots',
  // PostgreSQL sink
  postgresSinkRecordsWritten: 'laminardb_postgres_sink_records_written_total',
  postgresSinkErrors: 'laminardb_postgres_sink_errors_total',
  postgresSinkChangelogDeletes: 'laminardb_postgres_sink_changelog_deletes_total',
  // MongoDB CDC / sink
  mongoCdcEvents: 'laminardb_mongodb_cdc_events_received_total',
  mongoCdcErrors: 'laminardb_mongodb_cdc_errors_total',
  mongoCdcInserts: 'laminardb_mongodb_cdc_inserts_total',
  mongoCdcUpdates: 'laminardb_mongodb_cdc_updates_total',
  mongoCdcReplaces: 'laminardb_mongodb_cdc_replaces_total',
  mongoCdcDeletes: 'laminardb_mongodb_cdc_deletes_total',
  mongoCdcLifecycleEvents: 'laminardb_mongodb_cdc_lifecycle_events_total',
  mongoCdcReconnects: 'laminardb_mongodb_cdc_reconnects_total',
  mongoCdcMetadataSkipped: 'laminardb_mongodb_cdc_metadata_events_skipped_total',
  mongoCdcSnapshotDocuments: 'laminardb_mongodb_cdc_snapshot_documents_total',
  mongoCdcSnapshotInProgress: 'laminardb_mongodb_cdc_snapshot_in_progress',
  mongoSinkRecordsWritten: 'laminardb_mongodb_sink_records_written_total',
  mongoSinkErrors: 'laminardb_mongodb_sink_errors_total',
  // Delta / lakehouse sinks
  lakehouseSinkRowsFlushed: 'laminardb_lakehouse_sink_rows_flushed_total',
  lakehouseSinkCommits: 'laminardb_lakehouse_sink_commits_total',
  lakehouseSinkErrors: 'laminardb_lakehouse_sink_errors_total',
  lakehouseSinkEpochsRolledBack: 'laminardb_lakehouse_sink_epochs_rolled_back_total',
  deltaSinkLastVersion: 'laminardb_delta_sink_last_version',
  // Iceberg source
  icebergSourceCurrentSnapshot: 'laminardb_iceberg_source_current_snapshot_id',
  icebergSourceProcessedSnapshot: 'laminardb_iceberg_source_processed_snapshot_id',
  icebergSourceSnapshotLag: 'laminardb_iceberg_source_snapshot_lag',
  icebergSourceSequenceLag: 'laminardb_iceberg_source_sequence_lag',
  icebergSourceReadRows: 'laminardb_iceberg_source_read_rows_total',
  icebergSourceReadStorageBytes: 'laminardb_iceberg_source_read_storage_bytes_total',
  icebergSourceDeleteRatio: 'laminardb_iceberg_source_delete_to_data_file_ratio',
  icebergSourceCredentialRefreshFailures: 'laminardb_iceberg_source_credential_refresh_failures_total',
  // Iceberg sink
  icebergSinkCommittedCheckpoint: 'laminardb_iceberg_sink_committed_checkpoint',
  icebergSinkLastCommitTimestamp: 'laminardb_iceberg_sink_last_successful_commit_timestamp_seconds',
  icebergSinkDataFilesWritten: 'laminardb_iceberg_sink_data_files_written_total',
  icebergSinkSmallFilesWritten: 'laminardb_iceberg_sink_small_files_written_total',
  icebergSinkCommitConflicts: 'laminardb_iceberg_sink_commit_conflicts_total',
  icebergSinkCommitRetries: 'laminardb_iceberg_sink_commit_retries_total',
  icebergSinkUnknownOutcomes: 'laminardb_iceberg_sink_unknown_outcomes_total',
  icebergSinkPendingArtifacts: 'laminardb_iceberg_sink_pending_artifact_paths',
  icebergSinkArtifactCleanupFailures: 'laminardb_iceberg_sink_artifact_cleanup_failures_total',
  icebergSinkCredentialRefreshFailures: 'laminardb_iceberg_sink_credential_refresh_failures_total',
  // Process (Linux-only prometheus process collector)
  processCpuSeconds: 'laminardb_process_cpu_seconds_total',
  processResidentMemory: 'laminardb_process_resident_memory_bytes',
} as const;

// ---------------------------------------------------------------------------
// Subsystem grouping for the metrics browser (first match wins)

const SUBSYSTEM_RULES: { test: RegExp; group: string }[] = [
  { test: /^laminardb_checkpoint|^laminardb_sink_precommit/, group: 'Checkpointing' },
  { test: /^laminardb_checkpoints_/, group: 'Checkpointing' },
  { test: /^laminardb_managed_state_/, group: 'Managed state' },
  { test: /^laminardb_mv_/, group: 'Materialized views' },
  { test: /^laminardb_cluster_subscription_/, group: 'Cluster subscriptions' },
  { test: /^laminardb_(placement_|coordinated_recover|shuffle_|pipeline_faults|pipeline_restarts|pipeline_cycle_errors)/, group: 'Cluster & recovery' },
  { test: /^laminardb_(pipeline_watermark|source_watermark|source_idle|stream_watermark|input_buf|shed_records|window_late|events_null_timestamp)/, group: 'Watermarks & buffering' },
  { test: /^laminardb_source_queue_/, group: 'Source admission' },
  { test: /^laminardb_laminar_schema_resolution_/, group: 'Schema resolution' },
  { test: /^laminardb_temporal_filter_/, group: 'Temporal filters' },
  { test: /^laminardb_lookup_/, group: 'Lookup joins' },
  { test: /^laminardb_sink_/, group: 'Sink write path' },
  { test: /^laminardb_kafka_/, group: 'Kafka connector' },
  { test: /^laminardb_nats_/, group: 'NATS connector' },
  { test: /^laminardb_postgres_cdc_/, group: 'Postgres CDC' },
  { test: /^laminardb_postgres_sink_/, group: 'Postgres sink' },
  { test: /^laminardb_mongodb_/, group: 'MongoDB connector' },
  { test: /^laminardb_iceberg_/, group: 'Iceberg connector' },
  { test: /^laminardb_(lakehouse_|delta_)/, group: 'Lakehouse sinks' },
  { test: /^laminardb_websocket_(source|sink)_/, group: 'WebSocket connector' },
  { test: /^laminardb_(events_|cycles_|batches_|queries_|cycle_|operator_process_)/, group: 'Engine' },
  { test: /^laminardb_(uptime|reload|ws_connections)/, group: 'Server' },
  { test: /^laminardb_process_/, group: 'Process' },
];

export function subsystemOf(name: string): string {
  for (const rule of SUBSYSTEM_RULES) {
    if (rule.test.test(name)) return rule.group;
  }
  return 'Other';
}

// ---------------------------------------------------------------------------
// Formatting helpers

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log2(Math.abs(bytes)) / 10)));
  const v = bytes / 2 ** (10 * i);
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

export function formatCompact(n: number | undefined): string {
  if (n === undefined) return '—';
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return n % 1 === 0 ? n.toLocaleString() : n.toFixed(1);
}

export function formatSeconds(s: number | undefined): string {
  if (s === undefined) return '—';
  if (s < 0.001) return `${(s * 1e6).toFixed(0)} µs`;
  if (s < 1) return `${(s * 1e3).toFixed(1)} ms`;
  if (s < 60) return `${s.toFixed(2)} s`;
  return `${(s / 60).toFixed(1)} min`;
}

export function formatRate(n: number | undefined): string {
  if (n === undefined) return '—';
  return `${formatCompact(Math.round(n * 10) / 10)}/s`;
}
