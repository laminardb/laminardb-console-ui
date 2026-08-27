import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity, AlertCircle, ArrowRight, Database, Info, Layers, PlusCircle, Radio,
  RefreshCw, Table2, Trash2, Zap
} from 'lucide-react';
import { api } from '../api';
import type {
  ConnectorInfo, ConnectorsResponse, MaterializedViewInfo, SinkInfo, SourceInfo, StreamInfo,
} from '../api';
import {
  buildRelationSql, EMIT_OPTIONS, PERIODIC_EMIT_VALUE, SINK_FORMATS, SOURCE_FORMATS,
  validateRelationName,
} from '../catalogMeta';
import ConfirmDialog from './ConfirmDialog';
import { isSensitiveOptionKey, redactSqlSecrets } from '../sqlDisplay';

interface TableRow {
  name: string;
  primary_key?: string;
  row_count?: string;
  connector?: string;
}

interface ColumnRow {
  column_name: string;
  data_type: string;
  nullable: string | boolean;
}

type ItemType = 'source' | 'sink' | 'stream' | 'mv' | 'table' | 'connector';

interface SelectedItem {
  type: ItemType;
  name: string;
  sql?: string;
  state?: string;
  watermarkColumn?: string;
  primaryKey?: string;
  rowCount?: string;
  connector?: string;
  connectorInfo?: ConnectorInfo;
}

// DROP keyword per relation type (connectors are not droppable).
const DROP_KEYWORDS: Record<string, string> = {
  source: 'SOURCE',
  sink: 'SINK',
  stream: 'STREAM',
  mv: 'MATERIALIZED VIEW',
  table: 'TABLE',
};

export default function CatalogTab() {
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [sinks, setSinks] = useState<SinkInfo[]>([]);
  const [streams, setStreams] = useState<StreamInfo[]>([]);
  const [mvs, setMvs] = useState<MaterializedViewInfo[]>([]);
  const [tables, setTables] = useState<TableRow[]>([]);
  const [connectors, setConnectors] = useState<ConnectorsResponse | null>(null);
  const [pipelineState, setPipelineState] = useState('');
  const [selectedItem, setSelectedItem] = useState<SelectedItem | null>(null);
  const [dropLoading, setDropLoading] = useState(false);
  const [pendingDrop, setPendingDrop] = useState<SelectedItem | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [dropError, setDropError] = useState('');

  // Detail enrichment (fetched on selection)
  const [detailDdl, setDetailDdl] = useState<string>('');
  const [detailColumns, setDetailColumns] = useState<ColumnRow[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  const fetchCatalog = useCallback(async () => {
    const [srcList, sinkList, streamList, mvList, connSchemas, tableRes, pipelineStat] = await Promise.allSettled([
      api.listSources(),
      api.listSinks(),
      api.listStreams(),
      api.listMvs(),
      api.listConnectors(),
      api.executeSql('SHOW TABLES'),
      api.getPipelineStatus(),
    ]);
    if (srcList.status === 'fulfilled') setSources(srcList.value);
    if (sinkList.status === 'fulfilled') setSinks(sinkList.value);
    if (streamList.status === 'fulfilled') setStreams(streamList.value);
    if (mvList.status === 'fulfilled') setMvs(mvList.value);
    if (connSchemas.status === 'fulfilled') setConnectors(connSchemas.value);
    if (tableRes.status === 'fulfilled') setTables((tableRes.value.data as TableRow[] | undefined) ?? []);
    if (pipelineStat.status === 'fulfilled') setPipelineState(pipelineStat.value.pipeline_state);
    const failures = [srcList, sinkList, streamList, mvList, connSchemas, tableRes, pipelineStat]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    setCatalogError(failures.length
      ? `${failures.length} catalog request${failures.length === 1 ? '' : 's'} failed. Refresh to retry; successful sections remain available.`
      : '');
  }, []);

  useEffect(() => {
    void fetchCatalog();
  }, [fetchCatalog]);

  // Enrich the selected item with SHOW CREATE / DESCRIBE output.
  useEffect(() => {
    let cancelled = false;
    setDetailDdl('');
    setDetailColumns([]);
    if (!selectedItem || selectedItem.type === 'connector') return;

    (async () => {
      setDetailLoading(true);
      try {
        // Stored DDL for sources and sinks; streams/MVs already carry sql.
        if (selectedItem.type === 'source' || selectedItem.type === 'sink') {
          try {
            const res = await api.executeSql(`SHOW CREATE ${selectedItem.type.toUpperCase()} ${selectedItem.name}`);
            const stmt = res.data?.[0]?.create_statement;
            if (!cancelled && typeof stmt === 'string') setDetailDdl(stmt);
          } catch { /* older servers may not support SHOW CREATE */ }
        }
        // DESCRIBE works for sources, tables and MVs (errors for sinks; and
        // for streams before the pipeline starts) — best effort.
        if (selectedItem.type !== 'sink') {
          try {
            const res = await api.executeSql(`DESCRIBE ${selectedItem.name}`);
            if (!cancelled && res.data) setDetailColumns(res.data as unknown as ColumnRow[]);
          } catch { /* ignore */ }
        }
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedItem]);

  const handleDropRelation = async () => {
    if (!pendingDrop) return;
    const item = pendingDrop;
    const keyword = DROP_KEYWORDS[item.type];
    if (!keyword) return;
    setDropLoading(true);
    setDropError('');
    try {
      await api.executeSql(`DROP ${keyword} IF EXISTS ${item.name};`);
      setPendingDrop(null);
      setSelectedItem(null);
      await fetchCatalog();
    } catch (error) {
      setPendingDrop(null);
      setDropError(`Failed to drop ${item.type} "${item.name}": ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setDropLoading(false);
    }
  };

  const [showWizard, setShowWizard] = useState(false);

  const sidebarSection = (
    title: string,
    icon: React.ReactNode,
    items: { name: string; badge?: string; onClick: () => void; active: boolean }[],
  ) => (
    <>
      <div className="sidebar-section-title">
        {icon}
        {title}
      </div>
      <ul className="sidebar-list">
        {items.length === 0 ? (
          <li className="sidebar-empty">Empty</li>
        ) : (
          items.map((it) => (
            <li key={it.name}>
              <button type="button" className={`sidebar-item ${it.active ? 'active' : ''}`} onClick={it.onClick} aria-pressed={it.active}>
                <span>{it.name}</span>
                {it.badge
                  ? <span className="badge badge-purple" style={{ fontSize: '9px', padding: '1px 5px' }}>{it.badge}</span>
                  : <ArrowRight size={12} className="arrow" style={{ opacity: 0.3 }} aria-hidden="true" />}
              </button>
            </li>
          ))
        )}
      </ul>
    </>
  );

  return (
    <div className="dashboard-grid">
      {/* Sidebar */}
      <div className="sidebar">
        <div className="glass-card" style={{ padding: 12, flex: 1, display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'hsl(var(--text-muted))', paddingLeft: 8, paddingBottom: 6 }}>
            Object Browser
          </span>
          <button
            className="btn btn-primary"
            style={{ margin: '8px 0', padding: '8px 12px', fontSize: '13px', width: '100%' }}
            onClick={() => setShowWizard(true)}
            type="button"
          >
            <PlusCircle size={14} />
            <span>Add Relation</span>
          </button>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {sidebarSection('Sources', <Database size={10} />, sources.map((s) => ({
              name: s.name,
              active: selectedItem?.type === 'source' && selectedItem.name === s.name,
              onClick: () => setSelectedItem({ type: 'source', name: s.name, watermarkColumn: s.watermark_column }),
            })))}
            {sidebarSection('Streams', <Zap size={10} />, streams.map((s) => ({
              name: s.name,
              active: selectedItem?.type === 'stream' && selectedItem.name === s.name,
              onClick: () => setSelectedItem({ type: 'stream', name: s.name, sql: s.sql }),
            })))}
            {sidebarSection('Materialized Views', <Layers size={10} />, mvs.map((m) => ({
              name: m.name,
              badge: m.state,
              active: selectedItem?.type === 'mv' && selectedItem.name === m.name,
              onClick: () => setSelectedItem({ type: 'mv', name: m.name, sql: m.sql, state: m.state }),
            })))}
            {sidebarSection('Sinks', <Radio size={10} />, sinks.map((s) => ({
              name: s.name,
              active: selectedItem?.type === 'sink' && selectedItem.name === s.name,
              onClick: () => setSelectedItem({ type: 'sink', name: s.name }),
            })))}
            {sidebarSection('Tables', <Table2 size={10} />, tables.map((t) => ({
              name: t.name,
              active: selectedItem?.type === 'table' && selectedItem.name === t.name,
              onClick: () => setSelectedItem({
                type: 'table',
                name: t.name,
                primaryKey: t.primary_key,
                rowCount: t.row_count,
                connector: t.connector,
              }),
            })))}
            {connectors && sidebarSection('Available Connectors', <Activity size={10} />, [...connectors.sources, ...connectors.sinks]
              .filter((c, idx, arr) => arr.findIndex((x) => x.name === c.name) === idx)
              .map((c) => ({
                name: c.name,
                active: selectedItem?.type === 'connector' && selectedItem.name === c.name,
                onClick: () => setSelectedItem({ type: 'connector', name: c.name, connectorInfo: c }),
              })))}
          </div>
        </div>
      </div>

      {/* Detail view */}
      <div className="content-pane">
        {catalogError && (
          <div className="notice notice-warning" role="status">
            <AlertCircle size={16} aria-hidden="true" />
            <span>{catalogError}</span>
            <button className="btn btn-secondary" type="button" onClick={() => void fetchCatalog()}>Retry</button>
          </div>
        )}
        {dropError && (
          <div className="notice notice-error" role="alert">
            <AlertCircle size={16} aria-hidden="true" />
            <span>{dropError}</span>
          </div>
        )}
        {selectedItem ? (
          <div className="glass-card" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ borderBottom: '1px solid var(--border-translucent)', paddingBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <div>
                <span className="badge badge-purple" style={{ textTransform: 'uppercase', marginBottom: 6 }}>
                  {selectedItem.type === 'mv' ? 'Materialized View' : selectedItem.type}
                </span>
                <h2 style={{ fontSize: 22, fontWeight: 700 }}>{selectedItem.name}</h2>
              </div>
              {selectedItem.type !== 'connector' && (
                <button
                  className="btn btn-danger"
                  onClick={() => {
                    setDropError('');
                    setPendingDrop(selectedItem);
                  }}
                  disabled={dropLoading}
                  type="button"
                  title={`Drop this ${selectedItem.type} (issues DROP ${DROP_KEYWORDS[selectedItem.type]} IF EXISTS)`}
                >
                  {dropLoading ? <RefreshCw size={14} className="animate-spin" /> : <Trash2 size={14} />}
                  <span>Drop {selectedItem.type === 'mv' ? 'View' : selectedItem.type.charAt(0).toUpperCase() + selectedItem.type.slice(1)}</span>
                </button>
              )}
            </div>

            {/* MV state / source watermark / table info badges */}
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 13 }}>
              {selectedItem.type === 'mv' && selectedItem.state && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: 'hsl(var(--text-secondary))' }}>State:</span>
                  <span className="badge badge-emerald">{selectedItem.state}</span>
                </span>
              )}
              {selectedItem.type === 'source' && selectedItem.watermarkColumn && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: 'hsl(var(--text-secondary))' }}>Watermark column:</span>
                  <span className="badge badge-blue">{selectedItem.watermarkColumn}</span>
                </span>
              )}
              {selectedItem.type === 'table' && (
                <>
                  {selectedItem.primaryKey && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ color: 'hsl(var(--text-secondary))' }}>Primary key:</span>
                      <span className="badge badge-blue">{selectedItem.primaryKey}</span>
                    </span>
                  )}
                  {selectedItem.rowCount !== undefined && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ color: 'hsl(var(--text-secondary))' }}>Rows:</span>
                      <span style={{ fontFamily: 'var(--font-mono)' }}>{BigInt(selectedItem.rowCount).toLocaleString()}</span>
                    </span>
                  )}
                  {selectedItem.connector && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ color: 'hsl(var(--text-secondary))' }}>Connector:</span>
                      <span className="badge badge-emerald">{selectedItem.connector}</span>
                    </span>
                  )}
                </>
              )}
            </div>

            {/* SQL Definition */}
            {(selectedItem.sql || detailDdl) && (
              <div>
                <h4 style={{ fontSize: 12, fontWeight: 600, color: 'hsl(var(--text-secondary))', marginBottom: 8 }}>SQL Definition</h4>
                <pre className="code-preview">{redactSqlSecrets(detailDdl || selectedItem.sql || '')}</pre>
              </div>
            )}

            {/* Column schema (DESCRIBE) */}
            {detailColumns.length > 0 && (
              <div>
                <h4 style={{ fontSize: 12, fontWeight: 600, color: 'hsl(var(--text-secondary))', marginBottom: 8 }}>Columns</h4>
                <table className="meta-table">
                  <caption className="sr-only">Columns in {selectedItem.name}</caption>
                  <thead>
                    <tr><th scope="col">Column</th><th scope="col">Type</th><th scope="col">Nullable</th></tr>
                  </thead>
                  <tbody>
                    {detailColumns.map((c, i) => (
                      <tr key={i}>
                        <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{String(c.column_name)}</td>
                        <td style={{ fontFamily: 'var(--font-mono)' }}>{String(c.data_type)}</td>
                        <td>{String(c.nullable)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {detailLoading && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'hsl(var(--text-muted))', fontSize: 12 }}>
                <RefreshCw size={13} className="animate-spin" /> Loading schema details…
              </div>
            )}

            {/* Connector metadata */}
            {selectedItem.type === 'connector' && selectedItem.connectorInfo && (() => {
              const info = selectedItem.connectorInfo;
              return (
                <div style={{ flex: 1, overflowY: 'auto' }}>
                  <p style={{ color: 'hsl(var(--text-secondary))', fontSize: 14, marginBottom: 10 }}>
                    {info.display_name} (v{info.version}) — {[info.is_source && 'source', info.is_sink && 'sink'].filter(Boolean).join(' + ')}
                  </p>
                  <div className="notice notice-info" role="note">
                    <Info size={15} aria-hidden="true" />
                    <span>This endpoint reports compiled availability and option metadata, not delivery guarantees or runtime admission. The server validates connector mode, checkpoint, and cluster requirements when the pipeline is admitted.</span>
                  </div>
                  <h4 style={{ fontSize: 12, fontWeight: 600, color: 'hsl(var(--text-secondary))', marginBottom: 8 }}>Supported Config Parameters</h4>
                  <table className="meta-table">
                    <caption className="sr-only">Configuration keys for {info.display_name}</caption>
                    <thead>
                      <tr><th scope="col">Option Key</th><th scope="col">Required</th><th scope="col">Default</th><th scope="col">Description</th></tr>
                    </thead>
                    <tbody>
                      {info.config_keys?.map((opt) => (
                        <tr key={opt.key}>
                          <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{opt.key}</td>
                          <td>
                            <span className={`badge ${opt.required ? 'badge-amber' : 'badge-purple'}`}>
                              {opt.required ? 'Yes' : 'Optional'}
                            </span>
                          </td>
                          <td style={{ fontFamily: 'var(--font-mono)', color: 'hsl(var(--text-muted))' }}>{isSensitiveOptionKey(opt.key) && opt.default ? '[hidden]' : opt.default ?? 'N/A'}</td>
                          <td>{opt.description}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })()}

            {selectedItem.type !== 'connector' && !selectedItem.sql && !detailDdl && detailColumns.length === 0 && !detailLoading && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'hsl(var(--text-muted))', fontSize: 13 }}>
                <Info size={14} />
                <span>No stored DDL or schema metadata available for this relation.</span>
              </div>
            )}
          </div>
        ) : (
          <div className="glass-card" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'hsl(var(--text-muted))' }}>
            <Database size={48} style={{ opacity: 0.3, marginBottom: 12 }} />
            <span>Select an item in the catalog sidebar to inspect its definition and parameters.</span>
          </div>
        )}
      </div>

      {showWizard && (
        <RelationWizard
          connectors={connectors}
          sources={sources}
          streams={streams}
          mvs={mvs}
          pipelineState={pipelineState}
          onClose={() => setShowWizard(false)}
          onCreated={() => {
            setShowWizard(false);
            fetchCatalog();
          }}
        />
      )}
      <ConfirmDialog
        open={pendingDrop !== null}
        title={`Drop ${pendingDrop?.type === 'mv' ? 'materialized view' : pendingDrop?.type ?? 'relation'}?`}
        description={pendingDrop ? (
          <>
            This permanently removes <code>{pendingDrop.name}</code>. The server will refuse if downstream dependants exist; use explicit <code>CASCADE</code> in the worksheet only after reviewing them.
          </>
        ) : null}
        confirmLabel={dropLoading ? 'Dropping…' : 'Drop relation'}
        danger
        busy={dropLoading}
        onCancel={() => setPendingDrop(null)}
        onConfirm={() => void handleDropRelation()}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add Relation wizard

interface WizardProps {
  connectors: ConnectorsResponse | null;
  sources: SourceInfo[];
  streams: StreamInfo[];
  mvs: MaterializedViewInfo[];
  pipelineState: string;
  onClose: () => void;
  onCreated: () => void;
}

function RelationWizard({ connectors, sources, streams, mvs, pipelineState, onClose, onCreated }: WizardProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [step, setStep] = useState(1);
  const [relationType, setRelationType] = useState<'source' | 'sink' | 'stream' | 'mv' | ''>('');
  const [name, setName] = useState('');
  const [connector, setConnector] = useState('');
  const [config, setConfig] = useState<Record<string, string>>({});
  const [format, setFormat] = useState('');
  const [sourceCols, setSourceCols] = useState('');
  const [watermarkCol, setWatermarkCol] = useState('');
  const [watermarkDelay, setWatermarkDelay] = useState('5');
  const [watermarkUnit, setWatermarkUnit] = useState('SECOND');
  const [sinkInput, setSinkInput] = useState('');
  const [selectSql, setSelectSql] = useState('');
  const [emitClause, setEmitClause] = useState('');
  const [emitEveryAmount, setEmitEveryAmount] = useState('10');
  const [emitEveryUnit, setEmitEveryUnit] = useState('SECOND');
  const [retainHistory, setRetainHistory] = useState('');
  const [generatedSql, setGeneratedSql] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  const isPipelineActive = Boolean(pipelineState) && pipelineState !== 'Created' && pipelineState !== 'Stopped';
  const connectorList: ConnectorInfo[] = relationType === 'source'
    ? connectors?.sources ?? []
    : relationType === 'sink'
      ? connectors?.sinks ?? []
      : [];
  const selectedConnector = connectorList.find((c) => c.name === connector);

  // The discovery endpoint exposes top-level required keys. Conditional and
  // mode-specific admission remains the server's responsibility.
  const validate = (): string | null => {
    const nameErr = validateRelationName(name);
    if (nameErr) return nameErr;

    if (relationType === 'source' || relationType === 'sink') {
      if (!connector) return 'Select a connector.';
      if (selectedConnector) {
        for (const key of selectedConnector.config_keys) {
          if (key.required && key.default === null && !(config[key.key] || '').trim()) {
            return `Required option '${key.key}' is not set.`;
          }
        }
      }
    }
    if (relationType === 'sink' && !sinkInput) return 'Select the upstream input relation.';
    if ((relationType === 'stream' || relationType === 'mv') && !selectSql.trim()) return 'Provide the SELECT query.';
    if (emitClause === PERIODIC_EMIT_VALUE && (!/^\d+$/.test(emitEveryAmount) || BigInt(emitEveryAmount) === 0n)) {
      return 'EMIT EVERY requires a positive whole-number interval.';
    }
    if (watermarkCol.trim() && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(watermarkCol.trim())) {
      return 'Watermark column must be a plain SQL identifier.';
    }
    if (watermarkCol.trim() && !/^\d+$/.test(watermarkDelay)) {
      return 'Watermark tolerance must be a non-negative whole number.';
    }
    return null;
  };

  const generateSql = () => {
    if (!relationType) return;
    setGeneratedSql(buildRelationSql({
      kind: relationType,
      name,
      connector,
      config,
      format,
      sourceColumns: sourceCols,
      watermarkColumn: watermarkCol,
      watermarkAmount: watermarkDelay,
      watermarkUnit,
      sinkInput,
      selectSql,
      emitClause,
      emitEveryAmount,
      emitEveryUnit,
      retainHistory,
    }));
  };

  const execute = async () => {
    setLoading(true);
    setError('');
    try {
      await api.executeSql(generatedSql);
      onCreated();
    } catch (executeError) {
      setError(executeError instanceof Error ? executeError.message : 'Failed to create relation.');
    } finally {
      setLoading(false);
    }
  };

  const typeCard = (t: 'source' | 'sink' | 'stream' | 'mv', icon: React.ReactNode, title: string, desc: string) => (
    <button
      type="button"
      className={`sidebar-item ${relationType === t ? 'active' : ''}`}
      style={{ padding: 16, borderRadius: 8, border: '1px solid var(--border-translucent)', cursor: 'pointer', textAlign: 'center', display: 'block' }}
      onClick={() => {
        setRelationType(t);
        setConnector('');
        setConfig({});
        setFormat('');
      }}
    >
      {icon}
      <div style={{ fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: 11, color: 'hsl(var(--text-muted))', marginTop: 4 }}>{desc}</div>
      aria-pressed={relationType === t}
    </button>
  );

  const configFields = (list: ConnectorInfo[]) => {
    const info = list.find((c) => c.name === connector);
    if (!info) return null;
    return (
      <div style={{ maxHeight: 230, overflowY: 'auto', border: '1px solid var(--border-translucent)', padding: 12, borderRadius: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'hsl(var(--text-muted))' }}>CONNECTOR OPTIONS</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
          {info.config_keys.map((opt) => (
            <div key={opt.key}>
              <label htmlFor={`connector-option-${opt.key}`} style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: 'hsl(var(--text-secondary))', marginBottom: 4 }}>
                {opt.key} {opt.required && !opt.default && <span style={{ color: 'hsl(var(--status-error))' }}>*</span>}
              </label>
              <input
                type={isSensitiveOptionKey(opt.key) ? 'password' : 'text'}
                id={`connector-option-${opt.key}`}
                className="input-field"
                style={{ fontSize: 12, padding: '6px 10px' }}
                placeholder={opt.default || opt.description}
                value={config[opt.key] || ''}
                onChange={(e) => setConfig({ ...config, [opt.key]: e.target.value })}
                autoComplete="off"
              />
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="modal-overlay" style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0, 0, 0, 0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }}>
      <div ref={dialogRef} className="glass-card relation-dialog" role="dialog" aria-modal="true" aria-labelledby="relation-dialog-title" style={{ maxWidth: 680, width: '100%', maxHeight: '90vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 20, padding: '24px 30px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-translucent)', paddingBottom: 12 }}>
          <h2 id="relation-dialog-title" style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Add Relation</h2>
          <button ref={closeButtonRef} type="button" className="icon-button" onClick={onClose} aria-label="Close add relation dialog">&times;</button>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          {['1. Type', '2. Configuration', '3. Review & Execute'].map((label, i) => (
            <div key={label} style={{ fontWeight: step === i + 1 ? 700 : 'normal', color: step === i + 1 ? '#8b5cf6' : 'hsl(var(--text-muted))', fontSize: 13 }}>{label}</div>
          ))}
        </div>

        {error && (
          <div className="glass-card" style={{ borderColor: 'hsl(var(--status-error))', background: 'rgba(239, 68, 68, 0.05)', color: 'hsl(var(--status-error))', padding: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
            <AlertCircle size={15} />
            <span style={{ fontSize: 13 }}>{error}</span>
          </div>
        )}

        {isPipelineActive && relationType && (
          <div className="glass-card" style={{ borderColor: 'hsl(var(--status-warning))', background: 'rgba(234, 179, 8, 0.06)', padding: 10, fontSize: 12, color: 'hsl(var(--text-secondary))', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <AlertCircle size={14} style={{ color: 'hsl(var(--status-warning))', marginTop: 1, flexShrink: 0 }} />
            <span>
              The pipeline is <strong>{pipelineState}</strong>. Connector-backed DDL is offline-only. Stream and materialized-view DDL has a limited live path only for an uncheckpointed standalone runtime with compatible topology ([LDB-6043]). Stop the pipeline before changing topology when those conditions are not known.
            </span>
          </div>
        )}

        {/* STEP 1 */}
        {step === 1 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label style={{ fontSize: 13, fontWeight: 600, color: 'hsl(var(--text-secondary))' }}>What kind of relation do you want to create?</label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {typeCard('source', <Database size={24} style={{ margin: '0 auto 8px', color: '#10b981' }} />, 'Source', 'Ingest external events (Kafka, CDC, files, WebSocket…)')}
              {typeCard('sink', <Radio size={24} style={{ margin: '0 auto 8px', color: '#fbbf24' }} />, 'Sink', 'Deliver a stream to an external system')}
              {typeCard('stream', <Zap size={24} style={{ margin: '0 auto 8px', color: '#3b82f6' }} />, 'Stream', 'Continuous SQL transformation over streams')}
              {typeCard('mv', <Layers size={24} style={{ margin: '0 auto 8px', color: '#8b5cf6' }} />, 'Materialized View', 'Incrementally-maintained queryable state')}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="btn btn-primary" type="button" disabled={!relationType} onClick={() => setStep(2)}>
                <span>Next</span>
              </button>
            </div>
          </div>
        )}

        {/* STEP 2 */}
        {step === 2 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label htmlFor="relation-name" style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'hsl(var(--text-secondary))', marginBottom: 6 }}>Relation Name</label>
              <input id="relation-name" type="text" className="input-field" placeholder="my_relation_name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
            </div>

            {(relationType === 'source' || relationType === 'sink') && (
              <>
                {relationType === 'sink' && (
                  <div>
                    <label htmlFor="sink-input" style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'hsl(var(--text-secondary))', marginBottom: 6 }}>Upstream Input (Stream, Source or MV)</label>
                    <select id="sink-input" className="input-field" value={sinkInput} onChange={(e) => setSinkInput(e.target.value)}>
                      <option value="">Select input relation…</option>
                      {streams.map((s) => <option key={`st-${s.name}`} value={s.name}>{s.name} (Stream)</option>)}
                      {sources.map((s) => <option key={`so-${s.name}`} value={s.name}>{s.name} (Source)</option>)}
                      {mvs.map((m) => <option key={`mv-${m.name}`} value={m.name}>{m.name} (MV)</option>)}
                    </select>
                  </div>
                )}

                <div>
                  <label htmlFor="relation-connector" style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'hsl(var(--text-secondary))', marginBottom: 6 }}>
                    {relationType === 'source' ? 'Ingestion Connector' : 'Egress Connector'}
                  </label>
                  <select
                    id="relation-connector"
                    className="input-field"
                    value={connector}
                    onChange={(e) => {
                      setConnector(e.target.value);
                      setConfig({});
                    }}
                  >
                    <option value="">Select a connector…</option>
                    {connectorList.map((c) => (
                      <option key={c.name} value={c.name}>{c.display_name || c.name}</option>
                    ))}
                  </select>
                  {connector && (
                    <div className="field-help">The server reports this connector as compiled. Runtime delivery and cluster admission still depend on its selected mode and server configuration.</div>
                  )}
                </div>

                {connector && configFields(connectorList)}

                <div>
                  <label htmlFor="relation-format" style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'hsl(var(--text-secondary))', marginBottom: 6 }}>
                    Format <span style={{ fontWeight: 400, color: 'hsl(var(--text-muted))' }}>(optional)</span>
                  </label>
                  <select id="relation-format" className="input-field" value={format} onChange={(e) => setFormat(e.target.value)}>
                    {(relationType === 'source' ? SOURCE_FORMATS : SINK_FORMATS).map((f) => (
                      <option key={f} value={f}>{f || 'No FORMAT clause'}</option>
                    ))}
                  </select>
                  {format === 'DEBEZIUM' && (
                    <div style={{ fontSize: 11, color: 'hsl(var(--text-muted))', marginTop: 4 }}>Debezium envelope is deserialize-only (sources).</div>
                  )}
                  {format === 'AVRO' && (
                    <div style={{ fontSize: 11, color: 'hsl(var(--text-muted))', marginTop: 4 }}>Avro requires a server build with the kafka feature (schema registry).</div>
                  )}
                </div>
              </>
            )}

            {relationType === 'source' && (
              <>
                <div>
                    <label htmlFor="source-columns" style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'hsl(var(--text-secondary))', marginBottom: 6 }}>
                    Columns <span style={{ fontWeight: 400, color: 'hsl(var(--text-muted))' }}>(optional — leave empty for schema discovery)</span>
                  </label>
                  <textarea
                    id="source-columns"
                    className="input-field"
                    style={{ fontFamily: 'var(--font-mono)', fontSize: 12, height: 80 }}
                    placeholder="id BIGINT, device_name VARCHAR, temperature DOUBLE, ts TIMESTAMP"
                    value={sourceCols}
                    onChange={(e) => setSourceCols(e.target.value)}
                  />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label htmlFor="watermark-column" style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'hsl(var(--text-secondary))', marginBottom: 6 }}>Watermark Column (Optional)</label>
                    <input id="watermark-column" type="text" className="input-field" placeholder="ts" value={watermarkCol} onChange={(e) => setWatermarkCol(e.target.value)} />
                  </div>
                  <div>
                    <label htmlFor="watermark-delay" style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'hsl(var(--text-secondary))', marginBottom: 6 }}>Out-of-Orderness Tolerance</label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input id="watermark-delay" type="number" min={0} step={1} className="input-field" placeholder="5" style={{ flex: '0 0 90px' }} value={watermarkDelay} onChange={(e) => setWatermarkDelay(e.target.value)} />
                      <select aria-label="Watermark interval unit" className="input-field" style={{ flex: 1 }} value={watermarkUnit} onChange={(e) => setWatermarkUnit(e.target.value)}>
                        <option value="MILLISECOND">MILLISECOND</option>
                        <option value="SECOND">SECOND</option>
                        <option value="MINUTE">MINUTE</option>
                        <option value="HOUR">HOUR</option>
                        <option value="DAY">DAY</option>
                      </select>
                    </div>
                  </div>
                </div>
              </>
            )}

            {(relationType === 'stream' || relationType === 'mv') && (
              <>
                <div>
                  <label htmlFor="streaming-select" style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'hsl(var(--text-secondary))', marginBottom: 6 }}>Streaming SELECT Query</label>
                  <textarea
                    id="streaming-select"
                    className="input-field"
                    style={{ fontFamily: 'var(--font-mono)', fontSize: 12, height: 150 }}
                    placeholder={relationType === 'stream'
                      ? 'SELECT device_name, COUNT(*) AS count FROM signals GROUP BY device_name'
                      : 'SELECT region, SUM(amount_usd) AS total_revenue FROM processed_payments GROUP BY region'}
                    value={selectSql}
                    onChange={(e) => setSelectSql(e.target.value)}
                  />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: relationType === 'stream' ? '1fr 1fr' : '1fr', gap: 12 }}>
                  <div>
                    <label htmlFor="emit-strategy" style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'hsl(var(--text-secondary))', marginBottom: 6 }}>Emit Strategy</label>
                    <select id="emit-strategy" className="input-field" value={emitClause} onChange={(e) => setEmitClause(e.target.value)}>
                      {EMIT_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                    {emitClause === PERIODIC_EMIT_VALUE && (
                      <div className="interval-inputs">
                        <label htmlFor="emit-every-amount" className="sr-only">Emit interval amount</label>
                        <input id="emit-every-amount" type="number" min={1} step={1} className="input-field" value={emitEveryAmount} onChange={(event) => setEmitEveryAmount(event.target.value)} />
                        <label htmlFor="emit-every-unit" className="sr-only">Emit interval unit</label>
                        <select id="emit-every-unit" className="input-field" value={emitEveryUnit} onChange={(event) => setEmitEveryUnit(event.target.value)}>
                          <option value="MILLISECOND">MILLISECOND</option>
                          <option value="SECOND">SECOND</option>
                          <option value="MINUTE">MINUTE</option>
                          <option value="HOUR">HOUR</option>
                          <option value="DAY">DAY</option>
                        </select>
                      </div>
                    )}
                  </div>
                  {relationType === 'stream' && (
                    <div>
                      <label htmlFor="retain-history" style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'hsl(var(--text-secondary))', marginBottom: 6 }}>
                        Retain History <span style={{ fontWeight: 400, color: 'hsl(var(--text-muted))' }}>(optional, e.g. 64mb)</span>
                      </label>
                      <input id="retain-history" type="text" className="input-field" placeholder="64mb" value={retainHistory} onChange={(e) => setRetainHistory(e.target.value)} aria-describedby="retain-history-help" />
                      <span id="retain-history-help" className="field-help">
                        Local history is in memory. Cluster history is checkpoint-backed and is admitted only for non-windowed managed keyed aggregate streams.
                      </span>
                    </div>
                  )}
                </div>
              </>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
              <button className="btn btn-secondary" type="button" onClick={() => { setStep(1); setError(''); }}>Back</button>
              <button
                className="btn btn-primary"
                type="button"
                onClick={() => {
                  const err = validate();
                  if (err) {
                    setError(err);
                    return;
                  }
                  setError('');
                  generateSql();
                  setStep(3);
                }}
              >
                <span>Generate SQL</span>
              </button>
            </div>
          </div>
        )}

        {/* STEP 3 */}
        {step === 3 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'hsl(var(--text-secondary))', marginBottom: 6 }}>Generated SQL DDL</label>
              <pre className="code-preview" style={{ maxHeight: 240, overflowY: 'auto' }}>{generatedSql}</pre>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
              <button className="btn btn-secondary" type="button" onClick={() => setStep(2)} disabled={loading}>Back</button>
              <button className="btn btn-primary" type="button" disabled={loading} onClick={() => void execute()}>
                {loading ? <RefreshCw size={14} className="animate-spin" /> : <PlusCircle size={14} />}
                <span>Create Relation</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
