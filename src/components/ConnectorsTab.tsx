import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AlertCircle, Database, GitBranch, Info, Layers, Plug, Radio, RefreshCw, Server, ShieldAlert, Zap,
} from 'lucide-react';
import { api } from '../api';
import type { ConnectorsResponse } from '../api';
import {
  CDC_CONNECTORS, MODE_KEYS, TARGET_KEYS, isChangeFeedSource, parseConnectorDdl,
} from '../connectorDdl';
import type { ConnectorDdl } from '../connectorDdl';
import {
  M, fetchMetricsSnapshot, formatBytes, formatCompact, formatRate, formatSeconds, hasFamilyPrefix,
  latestSnapshot, previousSnapshot, rate, rateSeries, samples, value,
} from '../metrics';
import type { MetricsSnapshot } from '../metrics';
import { StatTile } from './charts';

interface RelationConnector {
  name: string;
  direction: 'source' | 'sink';
  ddl: ConnectorDdl | null;
  error?: string;
}

/** Bounded so a large catalog does not fan out into hundreds of SHOW CREATE calls. */
const MAX_DDL_LOOKUPS = 60;

function formatLsn(value: number | undefined): string {
  if (value === undefined || value < 0 || !Number.isSafeInteger(value)) return '—';
  const high = Math.floor(value / 2 ** 32);
  const low = value % 2 ** 32;
  return `${high.toString(16).toUpperCase()}/${low.toString(16).toUpperCase()}`;
}

function ageText(unixSeconds: number | undefined, at: number | undefined): string {
  if (unixSeconds === undefined || unixSeconds <= 0 || at === undefined) return 'never';
  return `${formatSeconds(Math.max(0, at / 1000 - unixSeconds))} ago`;
}

function sum(...values: (number | undefined)[]): number | undefined {
  const present = values.filter((item): item is number => item !== undefined);
  return present.length ? present.reduce((total, item) => total + item, 0) : undefined;
}

function Group({ title, icon, note, children }: { title: string; icon: ReactNode; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="section-stack" aria-label={title}>
      <h2 className="group-title">{icon}{title}</h2>
      {note && <p className="protocol-note">{note}</p>}
      <div className="grid-container grid-cols-4">{children}</div>
    </section>
  );
}

export default function ConnectorsTab() {
  const [snap, setSnap] = useState<MetricsSnapshot | null>(null);
  const [prev, setPrev] = useState<MetricsSnapshot | null>(null);
  const [relations, setRelations] = useState<RelationConnector[]>([]);
  const [connectors, setConnectors] = useState<ConnectorsResponse | null>(null);
  const [relationsTruncated, setRelationsTruncated] = useState(false);
  const [relationsLoading, setRelationsLoading] = useState(false);
  const [relationError, setRelationError] = useState('');
  const [scrapeError, setScrapeError] = useState('');

  const refreshMetrics = useCallback(async () => {
    const result = await fetchMetricsSnapshot();
    setScrapeError(result ? '' : 'The /metrics scrape failed; connector cards keep their last successful values.');
    setSnap(latestSnapshot());
    setPrev(previousSnapshot());
  }, []);

  const refreshRelations = useCallback(async () => {
    setRelationsLoading(true);
    const [sources, sinks, catalog] = await Promise.allSettled([api.listSources(), api.listSinks(), api.listConnectors()]);
    if (catalog.status === 'fulfilled') setConnectors(catalog.value);
    const wanted: { name: string; direction: 'source' | 'sink' }[] = [
      ...(sources.status === 'fulfilled' ? sources.value.map((item) => ({ name: item.name, direction: 'source' as const })) : []),
      ...(sinks.status === 'fulfilled' ? sinks.value.map((item) => ({ name: item.name, direction: 'sink' as const })) : []),
    ];
    setRelationsTruncated(wanted.length > MAX_DDL_LOOKUPS);
    const looked = await Promise.all(wanted.slice(0, MAX_DDL_LOOKUPS).map(async (relation): Promise<RelationConnector> => {
      try {
        const result = await api.executeSql(`SHOW CREATE ${relation.direction.toUpperCase()} ${relation.name}`);
        const statement = result.data?.[0]?.create_statement;
        return {
          ...relation,
          ddl: typeof statement === 'string' ? parseConnectorDdl(statement, relation.direction) : null,
        };
      } catch (error) {
        return { ...relation, ddl: null, error: error instanceof Error ? error.message : 'SHOW CREATE failed' };
      }
    }));
    setRelations(looked);
    setRelationError(sources.status === 'rejected' || sinks.status === 'rejected'
      ? 'Some catalog lists failed to load; relation classification may be incomplete.'
      : '');
    setRelationsLoading(false);
  }, []);

  useEffect(() => {
    void refreshMetrics();
    void refreshRelations();
    const metricsInterval = window.setInterval(() => void refreshMetrics(), 5_000);
    const relationInterval = window.setInterval(() => void refreshRelations(), 60_000);
    return () => {
      window.clearInterval(metricsInterval);
      window.clearInterval(relationInterval);
    };
  }, [refreshMetrics, refreshRelations]);

  /** Fill omitted mode options with the connector's advertised default. */
  const modeDefaults = useMemo(() => {
    const defaults = new Map<string, Record<string, string>>();
    for (const list of [connectors?.sources ?? [], connectors?.sinks ?? []]) {
      for (const connector of list) {
        const entry = defaults.get(connector.name) ?? {};
        for (const key of connector.config_keys) {
          if ((MODE_KEYS as readonly string[]).includes(key.key) && key.default) entry[key.key] = key.default;
        }
        defaults.set(connector.name, entry);
      }
    }
    return defaults;
  }, [connectors]);

  const has = (prefix: string) => hasFamilyPrefix(snap, prefix);
  const v = (name: string) => value(snap, name);
  const r = (name: string) => rate(prev, snap, name);

  const cdcRelations = relations.filter((relation) => relation.ddl && isChangeFeedSource(relation.ddl));
  const kafkaLag = samples(snap, M.kafkaSourceReaderLag);
  const lagAvailable = samples(snap, M.kafkaSourceLagSampleAvailable);
  const lagSampledAt = samples(snap, M.kafkaSourceLagSampleTimestamp);
  const lastBatches = samples(snap, M.kafkaSourceLastBatchTimestamp);
  const partitionKey = (labels: Record<string, string>) => `${labels.source ?? ''}\u0000${labels.topic ?? ''}\u0000${labels.partition ?? ''}`;
  const lagRows = [...new Set([...kafkaLag, ...lagAvailable].map((sample) => partitionKey(sample.labels)))]
    .map((key) => {
      const [source, topic, partition] = key.split('\u0000');
      const find = (list: typeof kafkaLag) => list.find((sample) => partitionKey(sample.labels) === key)?.value;
      return { source, topic, partition, lag: find(kafkaLag), available: find(lagAvailable), sampledAt: find(lagSampledAt) };
    })
    .sort((left, right) => left.source.localeCompare(right.source) || left.topic.localeCompare(right.topic) || Number(left.partition) - Number(right.partition));

  const pgOps = sum(v(M.postgresCdcInserts), v(M.postgresCdcUpdates), v(M.postgresCdcDeletes));
  const mongoOps = sum(v(M.mongoCdcInserts), v(M.mongoCdcUpdates), v(M.mongoCdcReplaces), v(M.mongoCdcDeletes));
  const orphanedSlots = v(M.postgresCdcOrphanedSlots);
  const kafkaLatencyCount = v(M.kafkaSinkProduceLatencyCount);
  const kafkaMeanLatencyUs = kafkaLatencyCount && kafkaLatencyCount > 0 ? (v(M.kafkaSinkProduceLatencySumUs) ?? 0) / kafkaLatencyCount : undefined;
  const cacheHits = v(M.kafkaSourceSchemaCacheHits);
  const cacheMisses = v(M.kafkaSourceSchemaCacheMisses);
  const icebergFiles = v(M.icebergSinkDataFilesWritten);
  const icebergSmall = v(M.icebergSinkSmallFilesWritten);
  const schemaOutcomes = samples(snap, M.schemaResolutionTotal);
  const schemaActive = v(M.schemaResolutionActive);

  const anyConnectorFamily = ['laminardb_kafka_', 'laminardb_postgres_', 'laminardb_mongodb_', 'laminardb_iceberg_', 'laminardb_lakehouse_', 'laminardb_delta_', 'laminardb_nats_', 'laminardb_websocket_']
    .some((prefix) => has(prefix));

  return (
    <div className="tab-page" aria-labelledby="connectors-title">
      <div className="tab-heading">
        <div>
          <h1 id="connectors-title">Connectors &amp; CDC</h1>
          <p>Which connector each source and sink uses, change-data-capture progress, and connector health from <code>/metrics</code>.</p>
        </div>
        <button className="btn btn-secondary" type="button" onClick={() => { void refreshMetrics(); void refreshRelations(); }} disabled={relationsLoading}>
          <RefreshCw size={14} className={relationsLoading ? 'animate-spin' : ''} aria-hidden="true" />
          <span>Refresh</span>
        </button>
      </div>

      {scrapeError && <div className="notice notice-error" role="alert"><AlertCircle size={16} aria-hidden="true" /><span>{scrapeError}</span></div>}
      {relationError && <div className="notice notice-warning" role="status"><AlertCircle size={16} aria-hidden="true" /><span>{relationError}</span></div>}

      <div className="notice notice-info" role="note">
        <Info size={16} aria-hidden="true" />
        <span>
          Connector metric families are process-wide and carry no connector-name label (Kafka reader-lag series are the exception, labelled by <code>source</code>, <code>topic</code> and <code>partition</code>). With several connectors of the same type on one node, only the first instance’s counters are exported. A card appears only after its connector has registered metrics.
        </span>
      </div>

      {/* Relations by connector */}
      <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="card-header table-card-header">
          <span>Sources and sinks by connector</span>
          <span className="protocol-note">From stored DDL (SHOW CREATE); credential options are never shown</span>
        </div>
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Sources and sinks by connector">
          <table className="meta-table">
            <caption className="sr-only">Connector type and mode of each source and sink</caption>
            <thead>
              <tr>
                <th scope="col">Relation</th>
                <th scope="col">Direction</th>
                <th scope="col">Connector</th>
                <th scope="col">Target</th>
                <th scope="col">Mode</th>
                <th scope="col">Format</th>
              </tr>
            </thead>
            <tbody>
              {relations.length === 0 ? (
                <tr><td colSpan={6} className="empty-table-cell">{relationsLoading ? 'Reading stored DDL…' : 'No connector-backed sources or sinks.'}</td></tr>
              ) : relations.map((relation) => {
                const ddl = relation.ddl;
                const defaults = ddl ? modeDefaults.get(ddl.connector) ?? {} : {};
                const modes = ddl
                  ? MODE_KEYS
                    .map((key) => [key, ddl.options[key] ?? defaults[key]] as const)
                    .filter((entry): entry is readonly [typeof MODE_KEYS[number], string] => Boolean(entry[1]))
                  : [];
                const target = ddl ? TARGET_KEYS.map((key) => ddl.options[key]).filter(Boolean).join(' · ') : '';
                return (
                  <tr key={`${relation.direction}-${relation.name}`}>
                    <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{relation.name}</td>
                    <td>{relation.direction}</td>
                    <td>
                      {ddl ? (
                        <span className={`badge ${CDC_CONNECTORS.has(ddl.connector) || (ddl && isChangeFeedSource(ddl) && relation.direction === 'source') ? 'badge-emerald' : 'badge-blue'}`}>
                          {ddl.connector}
                        </span>
                      ) : <span className="protocol-note" title={relation.error}>{relation.error ? 'unavailable' : 'no connector'}</span>}
                    </td>
                    <td style={{ fontSize: 12 }}>{target || '—'}</td>
                    <td style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                      {modes.length ? modes.map(([key, mode]) => (
                        <span key={key} className="mode-chip" title={ddl?.options[key] === undefined ? 'connector default' : 'declared'}>
                          {key}={mode}{ddl?.options[key] === undefined ? '*' : ''}
                        </span>
                      )) : '—'}
                    </td>
                    <td style={{ fontSize: 12 }}>{ddl?.format ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {(relationsTruncated || relations.some((relation) => relation.ddl && Object.keys(modeDefaults.get(relation.ddl.connector) ?? {}).length > 0)) && (
          <p className="protocol-note" style={{ padding: '8px 20px' }}>
            {relationsTruncated ? `Only the first ${MAX_DDL_LOOKUPS} relations are classified. ` : ''}* marks a mode the DDL omitted, shown with the connector’s advertised default.
          </p>
        )}
      </div>

      {/* CDC */}
      <Group
        title="Change data capture"
        icon={<GitBranch size={15} aria-hidden="true" />}
        note={cdcRelations.length
          ? `${cdcRelations.length} change-feed source${cdcRelations.length === 1 ? '' : 's'}: ${cdcRelations.map((relation) => `${relation.name} (${relation.ddl?.connector})`).join(', ')}.`
          : 'No PostgreSQL CDC, MongoDB CDC or Delta change-data-feed sources are defined.'}
      >
        {has('laminardb_postgres_cdc_') ? (
          <>
            <StatTile
              label="Postgres snapshot"
              value={formatCompact(v(M.postgresCdcSnapshotRows))}
              sub="Rows copied by the resumable chunked snapshot"
              icon={<Database size={16} style={{ color: 'hsl(var(--primary))' }} aria-hidden="true" />}
            />
            <StatTile
              label="Postgres changes"
              value={formatRate(r(M.postgresCdcEvents))}
              sub={`${formatCompact(pgOps)} row changes · ${formatCompact(v(M.postgresCdcTransactions))} transactions`}
              trend={rateSeries(M.postgresCdcEvents)}
              icon={<Zap size={16} style={{ color: 'hsl(var(--status-success))' }} aria-hidden="true" />}
            />
            <StatTile
              label="Replication lag"
              value={formatBytes(v(M.postgresCdcReplicationLagBytes))}
              sub={`Confirmed flush LSN ${formatLsn(v(M.postgresCdcConfirmedFlushLsn))}`}
              icon={<Layers size={16} style={{ color: 'hsl(var(--text-muted))' }} aria-hidden="true" />}
            />
            <StatTile
              label="Orphaned slots"
              value={formatCompact(orphanedSlots)}
              sub={orphanedSlots && orphanedSlots > 0
                ? 'Inactive slots under the slot.name prefix retain WAL — drop them once unused'
                : 'No inactive slots from other claims'}
              tone={orphanedSlots && orphanedSlots > 0 ? 'critical' : 'default'}
              icon={<ShieldAlert size={16} style={{ color: orphanedSlots && orphanedSlots > 0 ? 'hsl(var(--status-error))' : 'hsl(var(--text-muted))' }} aria-hidden="true" />}
            />
          </>
        ) : null}
        {has('laminardb_mongodb_cdc_') ? (
          <>
            <StatTile
              label="MongoDB snapshot"
              value={v(M.mongoCdcSnapshotInProgress) === 1 ? 'Copying' : 'Streaming'}
              sub={`${formatCompact(v(M.mongoCdcSnapshotDocuments))} documents copied by the initial snapshot`}
              tone={v(M.mongoCdcSnapshotInProgress) === 1 ? 'warning' : 'default'}
              icon={<Database size={16} style={{ color: 'hsl(var(--primary))' }} aria-hidden="true" />}
            />
            <StatTile
              label="MongoDB changes"
              value={formatRate(r(M.mongoCdcEvents))}
              sub={`${formatCompact(mongoOps)} insert/update/replace/delete · ${formatCompact(v(M.mongoCdcLifecycleEvents))} lifecycle`}
              trend={rateSeries(M.mongoCdcEvents)}
              icon={<Zap size={16} style={{ color: 'hsl(var(--status-success))' }} aria-hidden="true" />}
            />
            <StatTile
              label="MongoDB stream health"
              value={formatCompact(v(M.mongoCdcErrors))}
              sub={`errors · ${formatCompact(v(M.mongoCdcReconnects))} reconnects · ${formatCompact(v(M.mongoCdcMetadataSkipped))} metadata events skipped`}
              tone={(v(M.mongoCdcErrors) ?? 0) > 0 ? 'warning' : 'default'}
              icon={<ShieldAlert size={16} style={{ color: 'hsl(var(--text-muted))' }} aria-hidden="true" />}
            />
          </>
        ) : null}
        {cdcRelations.some((relation) => relation.ddl?.connector === 'delta-lake') && (
          <StatTile
            label="Delta change feed"
            value={`${cdcRelations.filter((relation) => relation.ddl?.connector === 'delta-lake').length} source(s)`}
            sub="The Delta source registers no metrics; follow it through source watermarks and ingestion rate"
            icon={<Layers size={16} style={{ color: 'hsl(var(--text-muted))' }} aria-hidden="true" />}
          />
        )}
        {!has('laminardb_postgres_cdc_') && !has('laminardb_mongodb_cdc_') && !cdcRelations.some((relation) => relation.ddl?.connector === 'delta-lake') && (
          <div className="glass-card empty-state grid-span-all">No CDC metrics are registered on this node.</div>
        )}
      </Group>

      {/* Kafka */}
      {(has('laminardb_kafka_source_') || has('laminardb_kafka_sink_')) && (
        <Group title="Kafka" icon={<Radio size={15} aria-hidden="true" />}>
          {has('laminardb_kafka_source_') && (
            <>
              <StatTile
                label="Records polled"
                value={formatRate(r(M.kafkaSourceRecordsPolled))}
                sub={`${formatBytes(r(M.kafkaSourceBytesPolled))}/s · ${formatCompact(v(M.kafkaSourceRecordsPolled))} total`}
                trend={rateSeries(M.kafkaSourceRecordsPolled)}
                icon={<Zap size={16} style={{ color: 'hsl(var(--status-success))' }} aria-hidden="true" />}
              />
              <StatTile
                label="Source errors"
                value={formatCompact(v(M.kafkaSourceErrors))}
                sub={`${formatCompact(v(M.kafkaSourceCommitFailures))} commit failures · ${formatCompact(v(M.kafkaSourceRebalances))} rebalances`}
                tone={(v(M.kafkaSourceErrors) ?? 0) > 0 || (v(M.kafkaSourceCommitFailures) ?? 0) > 0 ? 'warning' : 'default'}
                icon={<ShieldAlert size={16} style={{ color: 'hsl(var(--text-muted))' }} aria-hidden="true" />}
              />
              <StatTile
                label="Writer schema cache"
                value={cacheHits !== undefined && cacheMisses !== undefined && cacheHits + cacheMisses > 0
                  ? `${((cacheHits / (cacheHits + cacheMisses)) * 100).toFixed(1)}% hit`
                  : '—'}
                sub={`${formatCompact(v(M.kafkaSourceSchemaUnresolvedRecords))} records awaiting schema · ${formatCompact(v(M.kafkaSourceSchemaFetchFailures))} fetch failures`}
                tone={(v(M.kafkaSourceSchemaFetchFailures) ?? 0) > 0 ? 'warning' : 'default'}
                icon={<Layers size={16} style={{ color: 'hsl(var(--text-muted))' }} aria-hidden="true" />}
              />
            </>
          )}
          {has('laminardb_kafka_sink_') && (
            <StatTile
              label="Records produced"
              value={formatRate(r(M.kafkaSinkRecordsWritten))}
              sub={`${formatCompact(v(M.kafkaSinkErrors))} errors · ${formatCompact(v(M.kafkaSinkDlqRecords))} DLQ · mean ${kafkaMeanLatencyUs === undefined ? '—' : formatSeconds(kafkaMeanLatencyUs / 1e6)} produce`}
              trend={rateSeries(M.kafkaSinkRecordsWritten)}
              tone={(v(M.kafkaSinkErrors) ?? 0) > 0 ? 'warning' : 'default'}
              icon={<Server size={16} style={{ color: 'hsl(var(--primary))' }} aria-hidden="true" />}
            />
          )}
        </Group>
      )}
      {lagRows.length > 0 && (
        <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="card-header table-card-header">
            <span>Kafka reader lag</span>
            <span className="protocol-note">Broker high watermark minus the next reader offset, sampled every 10 s. Not processing or recovery lag.</span>
          </div>
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Kafka reader lag">
            <table className="meta-table">
              <caption className="sr-only">Kafka reader lag by source, topic and partition</caption>
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">Topic</th>
                  <th scope="col">Partition</th>
                  <th scope="col">Lag (offsets)</th>
                  <th scope="col">Sampled</th>
                  <th scope="col">Last batch</th>
                </tr>
              </thead>
              <tbody>
                {lagRows.map((row) => {
                  const lastBatch = lastBatches.find((sample) => sample.labels.source === row.source)?.value;
                  return (
                    <tr key={`${row.source}-${row.topic}-${row.partition}`}>
                      <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{row.source || '—'}</td>
                      <td>{row.topic}</td>
                      <td style={{ fontFamily: 'var(--font-mono)' }}>{row.partition}</td>
                      <td style={{ fontFamily: 'var(--font-mono)' }}>
                        {row.available === 0 || row.lag === undefined ? <span className="protocol-note">sample unavailable</span> : formatCompact(row.lag)}
                      </td>
                      <td>{ageText(row.sampledAt, snap?.at)}</td>
                      <td>{ageText(lastBatch, snap?.at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Lakehouse */}
      {(has('laminardb_iceberg_') || has('laminardb_lakehouse_') || has('laminardb_delta_')) && (
        <Group title="Lakehouse" icon={<Layers size={15} aria-hidden="true" />}>
          {has('laminardb_iceberg_source_') && (
            <StatTile
              label="Iceberg source lag"
              value={`${formatCompact(v(M.icebergSourceSnapshotLag))} snapshots`}
              sub={`sequence lag ${formatCompact(v(M.icebergSourceSequenceLag))} · ${formatRate(r(M.icebergSourceReadRows))} rows read`}
              tone={(v(M.icebergSourceCredentialRefreshFailures) ?? 0) > 0 ? 'warning' : 'default'}
              icon={<Database size={16} style={{ color: 'hsl(var(--primary))' }} aria-hidden="true" />}
            />
          )}
          {has('laminardb_iceberg_sink_') && (
            <>
              <StatTile
                label="Iceberg commits"
                value={v(M.icebergSinkCommittedCheckpoint) === undefined ? '—' : `ckpt ${formatCompact(v(M.icebergSinkCommittedCheckpoint))}`}
                sub={`last success ${ageText(v(M.icebergSinkLastCommitTimestamp), snap?.at)} · ${formatCompact(v(M.icebergSinkCommitConflicts))} conflicts · ${formatCompact(v(M.icebergSinkCommitRetries))} retries`}
                icon={<GitBranch size={16} style={{ color: 'hsl(var(--primary))' }} aria-hidden="true" />}
              />
              <StatTile
                label="Iceberg uncertainty"
                value={formatCompact(v(M.icebergSinkUnknownOutcomes))}
                sub={`unknown publication outcomes · ${formatCompact(v(M.icebergSinkPendingArtifacts))} pending artifact paths · ${formatCompact(v(M.icebergSinkArtifactCleanupFailures))} cleanup failures`}
                tone={(v(M.icebergSinkArtifactCleanupFailures) ?? 0) > 0 ? 'warning' : 'default'}
                icon={<ShieldAlert size={16} style={{ color: 'hsl(var(--text-muted))' }} aria-hidden="true" />}
              />
              <StatTile
                label="Iceberg files"
                value={formatCompact(icebergFiles)}
                sub={icebergFiles && icebergSmall !== undefined ? `${((icebergSmall / icebergFiles) * 100).toFixed(0)}% below target size` : 'data files closed'}
                icon={<Layers size={16} style={{ color: 'hsl(var(--text-muted))' }} aria-hidden="true" />}
              />
            </>
          )}
          {(has('laminardb_lakehouse_sink_') || has('laminardb_delta_sink_')) && (
            <StatTile
              label="Delta / lakehouse sink"
              value={formatRate(r(M.lakehouseSinkRowsFlushed))}
              sub={`${formatCompact(v(M.lakehouseSinkCommits))} commits · ${formatCompact(v(M.lakehouseSinkEpochsRolledBack))} rolled back · Delta v${v(M.deltaSinkLastVersion) ?? '—'}`}
              tone={(v(M.lakehouseSinkErrors) ?? 0) > 0 ? 'warning' : 'default'}
              icon={<Server size={16} style={{ color: 'hsl(var(--primary))' }} aria-hidden="true" />}
            />
          )}
        </Group>
      )}

      {/* Database sinks */}
      {(has('laminardb_postgres_sink_') || has('laminardb_mongodb_sink_')) && (
        <Group title="Database sinks" icon={<Database size={15} aria-hidden="true" />}>
          {has('laminardb_postgres_sink_') && (
            <StatTile
              label="PostgreSQL sink"
              value={formatRate(r(M.postgresSinkRecordsWritten))}
              sub={`${formatCompact(v(M.postgresSinkErrors))} errors · ${formatCompact(v(M.postgresSinkChangelogDeletes))} changelog deletes`}
              tone={(v(M.postgresSinkErrors) ?? 0) > 0 ? 'warning' : 'default'}
              icon={<Server size={16} style={{ color: 'hsl(var(--primary))' }} aria-hidden="true" />}
            />
          )}
          {has('laminardb_mongodb_sink_') && (
            <StatTile
              label="MongoDB sink"
              value={formatRate(r(M.mongoSinkRecordsWritten))}
              sub={`${formatCompact(v(M.mongoSinkErrors))} errors`}
              tone={(v(M.mongoSinkErrors) ?? 0) > 0 ? 'warning' : 'default'}
              icon={<Server size={16} style={{ color: 'hsl(var(--primary))' }} aria-hidden="true" />}
            />
          )}
        </Group>
      )}

      {/* Admission and schema */}
      <Group title="Source admission & schema resolution" icon={<Plug size={15} aria-hidden="true" />}>
        <StatTile
          label="Source queue reserved"
          value={formatBytes(v(M.sourceQueueReservedBytes))}
          sub="Connector FIFO byte reservations, bounded by server.source_queue_max_bytes"
          icon={<Layers size={16} style={{ color: 'hsl(var(--primary))' }} aria-hidden="true" />}
        />
        <StatTile
          label="Schema resolutions"
          value={formatCompact(schemaActive)}
          sub={schemaOutcomes.length
            ? schemaOutcomes
              .filter((sample) => sample.value > 0)
              .map((sample) => `${sample.labels.direction ?? '?'} ${sample.labels.outcome ?? '?'}: ${formatCompact(sample.value)}`)
              .join(' · ') || 'none completed yet'
            : 'No resolution outcomes reported'}
          tone={schemaOutcomes.some((sample) => sample.labels.outcome === 'failure' && sample.value > 0) ? 'warning' : 'default'}
          icon={<Info size={16} style={{ color: 'hsl(var(--text-muted))' }} aria-hidden="true" />}
        />
      </Group>

      {!anyConnectorFamily && snap && (
        <p className="protocol-note">No connector metric families are registered on this node yet. Generator, files and OTel sources do not export connector-specific families.</p>
      )}
    </div>
  );
}
