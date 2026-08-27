import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle, AlertTriangle, CheckCircle, CircleStop, Play, Radio,
  RefreshCw, RotateCcw, Trash2, Zap,
} from 'lucide-react';
import { ApiError, api } from '../api';
import type { MaterializedViewInfo, StreamInfo, WireU64 } from '../api';
import {
  dataFrameRowKeys,
  isClusterSubscriptionDataFrame,
  normalizeU64Input,
  parseSubscriptionFrame,
} from '../subscription';
import type { ClusterSubscriptionDataFrame, SubscriptionProgressFrame } from '../subscription';

const MAX_CAPTURED_ROWS = 1_000;
const MAX_SEEN_ROW_KEYS = 100_000;

const SNIPPETS: { label: string; sql: string }[] = [
  { label: 'SHOW SOURCES', sql: 'SHOW SOURCES' },
  { label: 'SHOW SINKS', sql: 'SHOW SINKS' },
  { label: 'SHOW STREAMS', sql: 'SHOW STREAMS' },
  { label: 'SHOW MATERIALIZED VIEWS', sql: 'SHOW MATERIALIZED VIEWS' },
  { label: 'SHOW TABLES', sql: 'SHOW TABLES' },
  { label: 'SHOW QUERIES', sql: 'SHOW QUERIES' },
  { label: 'SHOW CHECKPOINT STATUS', sql: 'SHOW CHECKPOINT STATUS' },
  { label: 'CHECKPOINT', sql: 'CHECKPOINT' },
];

interface WorksheetTabProps {
  onCatalogChanged?: () => void;
}

interface CapturedRow {
  key: string;
  value: Record<string, unknown>;
  cluster?: {
    partition: WireU64;
    partitionSequence: WireU64;
    committedEpoch: WireU64;
    rowOffset: WireU64;
  };
}

type SubscriptionStatus =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'interrupted'
  | 'gap'
  | 'error';

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isDdlStatement(sql: string): boolean {
  return /^(?:CREATE|DROP|ALTER)\b/i.test(sql.trim());
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function RowsTable({ rows, caption }: { rows: Record<string, unknown>[]; caption: string }) {
  const columns = useMemo(
    () => Array.from(new Set(rows.flatMap((row) => Object.keys(row)))),
    [rows],
  );
  return (
    <table className="meta-table">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>{columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {columns.map((column) => (
              <td key={column} className={typeof row[column] === 'number' || typeof row[column] === 'boolean' ? 'numeric-cell' : undefined}>
                {displayValue(row[column])}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SubscriptionRowsTable({ rows, caption }: { rows: CapturedRow[]; caption: string }) {
  const columns = useMemo(
    () => Array.from(new Set(rows.flatMap((row) => Object.keys(row.value)))),
    [rows],
  );
  const hasClusterMetadata = rows.some((row) => row.cluster !== undefined);
  return (
    <table className="meta-table">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          {columns.map((column) => <th key={column} scope="col">{column}</th>)}
          {hasClusterMetadata && <>
            <th scope="col">Partition</th>
            <th scope="col">Partition sequence</th>
            <th scope="col">Committed epoch</th>
            <th scope="col">Row offset</th>
          </>}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            {columns.map((column) => (
              <td key={column} className={typeof row.value[column] === 'number' || typeof row.value[column] === 'boolean' ? 'numeric-cell' : undefined}>
                {displayValue(row.value[column])}
              </td>
            ))}
            {hasClusterMetadata && <>
              <td className="numeric-cell">{row.cluster?.partition ?? '—'}</td>
              <td className="numeric-cell">{row.cluster?.partitionSequence ?? '—'}</td>
              <td className="numeric-cell">{row.cluster?.committedEpoch ?? '—'}</td>
              <td className="numeric-cell">{row.cluster?.rowOffset ?? '—'}</td>
            </>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function WorksheetTab({ onCatalogChanged }: WorksheetTabProps) {
  const [sqlText, setSqlText] = useState('SHOW SOURCES');
  const [sqlLoading, setSqlLoading] = useState(false);
  const [sqlResult, setSqlResult] = useState<Record<string, unknown>[] | null>(null);
  const [sqlMessage, setSqlMessage] = useState('');
  const [sqlTruncated, setSqlTruncated] = useState(false);
  const [sqlError, setSqlError] = useState('');

  const [streams, setStreams] = useState<StreamInfo[]>([]);
  const [materializedViews, setMaterializedViews] = useState<MaterializedViewInfo[]>([]);
  const [target, setTarget] = useState('');
  const [asOfInput, setAsOfInput] = useState('');
  const [targetError, setTargetError] = useState('');
  const [runtimeMode, setRuntimeMode] = useState<'checking' | 'single' | 'cluster' | 'unknown'>('checking');

  const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionStatus>('idle');
  const [subscriptionMessage, setSubscriptionMessage] = useState('');
  const [capturedRows, setCapturedRows] = useState<CapturedRow[]>([]);
  const [receivedRows, setReceivedRows] = useState(0n);
  const [replayDuplicates, setReplayDuplicates] = useState(0n);
  const [progress, setProgress] = useState<SubscriptionProgressFrame | null>(null);
  const [streamGeneration, setStreamGeneration] = useState('');
  const [observedPartitions, setObservedPartitions] = useState<string[]>([]);
  const [latestDataEpoch, setLatestDataEpoch] = useState<WireU64 | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const intentionallyClosedRef = useRef(new WeakSet<WebSocket>());
  const terminalSocketsRef = useRef(new WeakSet<WebSocket>());
  const expectedSequenceRef = useRef(0n);
  const seenRowsRef = useRef(new Set<string>());
  const streamGenerationRef = useRef('');
  const observedPartitionsRef = useRef(new Set<string>());

  const targets = useMemo(
    () => [
      ...streams.map((stream) => ({ name: stream.name, kind: 'stream' as const })),
      ...materializedViews.map((view) => ({ name: view.name, kind: 'materialized view' as const })),
    ].sort((left, right) => left.name.localeCompare(right.name)),
    [materializedViews, streams],
  );
  const selectedTarget = targets.find((item) => item.name === target);

  const refreshTargets = useCallback(async () => {
    setTargetError('');
    const [streamResult, mvResult, clusterResult] = await Promise.allSettled([
      api.listStreams(),
      api.listMvs(),
      api.getClusterStatus(),
    ]);
    if (streamResult.status === 'fulfilled') setStreams(streamResult.value);
    if (mvResult.status === 'fulfilled') setMaterializedViews(mvResult.value);

    const targetFailures = [streamResult, mvResult]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (targetFailures.length) {
      setTargetError(`${targetFailures.length} subscription target request${targetFailures.length === 1 ? '' : 's'} failed.`);
    }

    if (clusterResult.status === 'fulfilled') {
      setRuntimeMode('cluster');
    } else if (clusterResult.reason instanceof ApiError && clusterResult.reason.status === 404) {
      setRuntimeMode('single');
    } else {
      setRuntimeMode('unknown');
      setTargetError((current) => [current, errorText(clusterResult.reason, 'Could not determine the server runtime mode.')].filter(Boolean).join(' '));
    }

    const availableNames = [
      ...(streamResult.status === 'fulfilled' ? streamResult.value.map((item) => item.name) : []),
      ...(mvResult.status === 'fulfilled' ? mvResult.value.map((item) => item.name) : []),
    ];
    setTarget((current) => availableNames.includes(current) ? current : availableNames[0] || '');
  }, []);

  useEffect(() => {
    void refreshTargets();
  }, [refreshTargets]);

  const closeSocket = useCallback((intentional: boolean) => {
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket && intentional) intentionallyClosedRef.current.add(socket);
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  }, []);

  const stopSubscription = useCallback(() => {
    closeSocket(true);
    setSubscriptionStatus('idle');
    setSubscriptionMessage('');
  }, [closeSocket]);

  useEffect(() => () => closeSocket(true), [closeSocket]);

  const executeSql = async () => {
    if (!sqlText.trim()) return;
    setSqlLoading(true);
    setSqlResult(null);
    setSqlMessage('');
    setSqlError('');
    setSqlTruncated(false);
    try {
      const result = await api.executeSql(sqlText);
      setSqlTruncated(Boolean(result.truncated));
      if (result.data) {
        setSqlResult(result.data);
      } else if (result.rows_affected !== undefined) {
        setSqlMessage(`${result.rows_affected} row${result.rows_affected === '1' ? '' : 's'} affected.`);
      } else {
        setSqlMessage(`${result.result_type}${result.object_name ? ` ${result.object_name}` : ''} — OK`);
      }
      if (isDdlStatement(sqlText)) {
        onCatalogChanged?.();
        await refreshTargets();
      }
    } catch (error) {
      setSqlError(errorText(error, 'SQL execution failed.'));
    } finally {
      setSqlLoading(false);
    }
  };

  const openSubscription = useCallback((epoch: WireU64 | undefined, preserveCapture: boolean) => {
    closeSocket(true);
    expectedSequenceRef.current = 0n;
    setSubscriptionMessage('');
    setSubscriptionStatus('connecting');
    if (!preserveCapture) {
      seenRowsRef.current.clear();
      streamGenerationRef.current = '';
      observedPartitionsRef.current.clear();
      setCapturedRows([]);
      setReceivedRows(0n);
      setReplayDuplicates(0n);
      setProgress(null);
      setStreamGeneration('');
      setObservedPartitions([]);
      setLatestDataEpoch(null);
    }

    let url: string;
    try {
      url = api.getSubscriptionUrl(target, epoch);
    } catch (error) {
      setSubscriptionStatus('error');
      setSubscriptionMessage(errorText(error, 'Could not build the subscription URL.'));
      return;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      setSubscriptionStatus('error');
      setSubscriptionMessage(errorText(error, 'The browser could not open the subscription socket.'));
      return;
    }
    socketRef.current = socket;

    socket.onopen = () => {
      if (socketRef.current !== socket) return;
      setSubscriptionStatus('live');
      setSubscriptionMessage(
        runtimeMode === 'cluster'
          ? (epoch === undefined
              ? 'Attached at the current committed tail. Rows become visible after later whole-cluster checkpoint commits.'
              : `Replaying the durable committed suffix strictly after epoch ${epoch}, then following later checkpoint commits.`)
          : (epoch === undefined
              ? 'Attached at the live tail. Rows sequenced after attachment will be shown.'
              : `Replaying entries strictly after retained barrier epoch ${epoch}, then following live output.`),
      );
    };

    socket.onmessage = (event) => {
      if (socketRef.current !== socket) return;
      try {
        if (typeof event.data !== 'string') throw new Error('LaminarDB sent a non-text WebSocket frame.');
        const frame = parseSubscriptionFrame(event.data);
        if (frame.subscription_id !== target) {
          throw new Error(`Frame target '${frame.subscription_id}' does not match '${target}'.`);
        }
        const sequence = BigInt(frame.sequence);
        if (sequence !== expectedSequenceRef.current) {
          throw new Error(`Frame sequence gap: expected ${expectedSequenceRef.current}, received ${sequence}.`);
        }
        expectedSequenceRef.current += 1n;

        const generation = frame.type === 'data' || frame.type === 'progress'
          ? frame.stream_generation
          : undefined;
        if (runtimeMode === 'cluster' && (frame.type === 'data' || frame.type === 'progress') && generation === undefined) {
          throw new Error('Cluster subscription data/progress frame omitted stream_generation.');
        }
        if (generation !== undefined) {
          if (streamGenerationRef.current && streamGenerationRef.current !== generation) {
            throw new Error('Subscription stream generation changed within the capture.');
          }
          if (!streamGenerationRef.current) {
            streamGenerationRef.current = generation;
            setStreamGeneration(generation);
          }
        }

        if (frame.type === 'data') {
          const keys = dataFrameRowKeys(frame);
          const clusterFrame: ClusterSubscriptionDataFrame | null = isClusterSubscriptionDataFrame(frame)
            ? frame
            : null;
          if (clusterFrame) {
            if (!observedPartitionsRef.current.has(clusterFrame.partition)) {
              observedPartitionsRef.current.add(clusterFrame.partition);
              setObservedPartitions(Array.from(observedPartitionsRef.current).sort((left, right) => {
                const leftValue = BigInt(left);
                const rightValue = BigInt(right);
                return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
              }));
            }
            setLatestDataEpoch(clusterFrame.committed_epoch);
          }
          setReceivedRows((count) => count + BigInt(frame.data.length));
          const fresh: CapturedRow[] = [];
          let duplicates = 0;
          frame.data.forEach((row, index) => {
            const key = keys[index];
            if (seenRowsRef.current.has(key)) duplicates += 1;
            else {
              seenRowsRef.current.add(key);
              if (seenRowsRef.current.size > MAX_SEEN_ROW_KEYS) {
                const oldest = seenRowsRef.current.values().next().value;
                if (oldest !== undefined) seenRowsRef.current.delete(oldest);
              }
              fresh.push({
                key,
                value: row,
                cluster: clusterFrame ? {
                  partition: clusterFrame.partition,
                  partitionSequence: clusterFrame.partition_sequence,
                  committedEpoch: clusterFrame.committed_epoch,
                  rowOffset: (BigInt(clusterFrame.row_offset) + BigInt(index)).toString(),
                } : undefined,
              });
            }
          });
          if (duplicates > 0) setReplayDuplicates((count) => count + BigInt(duplicates));
          if (fresh.length > 0) {
            setCapturedRows((current) => {
              const combined = [...current, ...fresh];
              return combined.slice(-MAX_CAPTURED_ROWS);
            });
          }
          return;
        }

        if (frame.type === 'progress') {
          setProgress(frame);
          return;
        }

        terminalSocketsRef.current.add(socket);
        if (frame.type === 'gap') {
          setSubscriptionStatus('gap');
          setSubscriptionMessage(runtimeMode === 'cluster'
            ? `${frame.message}. Delivery stopped; resume from the last durably recorded whole-cluster progress epoch.`
            : `${frame.message}. Delivery is incomplete; choose an explicit resume point.`);
        } else {
          setSubscriptionStatus('error');
          setSubscriptionMessage(`${frame.code}: ${frame.message}`);
        }
        socket.close();
      } catch (error) {
        terminalSocketsRef.current.add(socket);
        setSubscriptionStatus('error');
        setSubscriptionMessage(`Protocol error: ${errorText(error, 'invalid WebSocket frame')}`);
        socket.close();
      }
    };

    socket.onerror = () => {
      // Browser WebSocket APIs deliberately hide HTTP upgrade status/body.
      // onclose below presents the actionable set of engine-side causes.
    };

    socket.onclose = () => {
      const isCurrent = socketRef.current === socket;
      if (isCurrent) socketRef.current = null;
      if (!isCurrent || intentionallyClosedRef.current.has(socket) || terminalSocketsRef.current.has(socket)) return;
      setSubscriptionStatus('interrupted');
      setSubscriptionMessage(
        runtimeMode === 'cluster'
          ? 'Connection closed without a terminal server frame. The browser cannot expose the upgrade response; check auth, keyed-aggregate admission, checkpoint history/retention, backend availability, readiness, and server logs.'
          : 'Connection closed without a terminal server frame. The browser cannot expose the upgrade status; check auth, target existence, replay retention, readiness, and server logs.',
      );
    };
  }, [closeSocket, runtimeMode, target]);

  const startSubscription = () => {
    if (!target || runtimeMode === 'checking' || runtimeMode === 'unknown') return;
    if (runtimeMode === 'cluster' && selectedTarget?.kind !== 'stream') return;
    try {
      const epoch = normalizeU64Input(asOfInput);
      openSubscription(epoch, false);
    } catch (error) {
      setSubscriptionStatus('error');
      setSubscriptionMessage(errorText(error, 'Invalid AS OF epoch.'));
    }
  };

  const resumeAfterProgress = () => {
    if (!progress) return;
    setAsOfInput(progress.epoch);
    openSubscription(progress.epoch, true);
  };

  const reconnectAtTail = () => {
    setAsOfInput('');
    openSubscription(undefined, true);
  };

  const clearCapture = () => {
    seenRowsRef.current.clear();
    setCapturedRows([]);
    setReceivedRows(0n);
    setReplayDuplicates(0n);
  };

  const activeSubscription = subscriptionStatus === 'connecting' || subscriptionStatus === 'live';
  const canSubscribe = Boolean(target)
    && (runtimeMode === 'single' || (runtimeMode === 'cluster' && selectedTarget?.kind === 'stream'));

  return (
    <div className="tab-page" aria-labelledby="worksheet-title">
      <header className="tab-heading">
        <div>
          <h1 id="worksheet-title">SQL worksheet</h1>
          <p>Execute one HTTP SQL statement, or subscribe to an existing stream/materialized view over WebSocket.</p>
        </div>
      </header>

      <section className="worksheet-container" aria-labelledby="sql-editor-title">
        <div className="section-heading-row">
          <div>
            <h2 id="sql-editor-title">HTTP SQL</h2>
            <p>Results are capped at 1,000 rows and a five-second collection window.</p>
          </div>
        </div>

        <div className="snippet-row" aria-label="SQL snippets">
          {SNIPPETS.map((snippet) => (
            <button
              key={snippet.label}
              className="btn btn-secondary snippet-button"
              onClick={() => setSqlText(snippet.sql)}
              type="button"
            >
              {snippet.label}
            </button>
          ))}
        </div>

        <div className="sql-editor-container">
          <div className="editor-header">
            <label htmlFor="sql-editor">Statement</label>
            <span>Ctrl/⌘ + Enter to execute</span>
          </div>
          <textarea
            id="sql-editor"
            className="sql-editor"
            value={sqlText}
            onChange={(event) => setSqlText(event.target.value)}
            placeholder="CREATE STREAM … or SELECT … or SHOW SOURCES"
            spellCheck={false}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void executeSql();
              }
            }}
          />
        </div>

        <div className="editor-actions">
          <button className="btn btn-primary" onClick={() => void executeSql()} disabled={sqlLoading || !sqlText.trim()} type="button">
            {sqlLoading ? <RefreshCw size={14} className="animate-spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
            Execute statement
          </button>
        </div>

        {sqlError && <div className="notice notice-error" role="alert"><AlertCircle size={16} aria-hidden="true" /><span>{sqlError}</span></div>}
        {sqlMessage && <div className="notice notice-success" role="status"><CheckCircle size={16} aria-hidden="true" /><span>{sqlMessage}</span></div>}
        {sqlTruncated && (
          <div className="notice notice-warning" role="status">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>The response is a prefix. Use LIMIT/predicates, or subscribe to an existing named target below; HTTP does not accept SUBSCRIBE.</span>
          </div>
        )}

        <div className="results-pane" aria-live="polite" aria-busy={sqlLoading}>
          <div className="results-header">
            <span>SQL result</span>
            {sqlResult && <span>{sqlResult.length} row{sqlResult.length === 1 ? '' : 's'}{sqlTruncated ? ' · truncated' : ''}</span>}
          </div>
          <div className="results-table-container">
            {sqlLoading ? (
              <div className="empty-state"><RefreshCw size={24} className="animate-spin" aria-hidden="true" /><span>Executing statement…</span></div>
            ) : sqlResult && sqlResult.length > 0 ? (
              <RowsTable rows={sqlResult} caption="SQL query result" />
            ) : sqlResult ? (
              <div className="empty-state">Query returned no rows.</div>
            ) : (
              <div className="empty-state"><Zap size={28} aria-hidden="true" /><span>Ready to execute a statement.</span></div>
            )}
          </div>
        </div>
      </section>

      <section className="worksheet-container" aria-labelledby="subscription-title">
        <div className="section-heading-row">
          <div>
            <h2 id="subscription-title">Live subscription</h2>
            <p>Targets are existing named streams or materialized views. Sources and arbitrary SQL are not valid targets.</p>
          </div>
          <button className="btn btn-secondary" type="button" onClick={() => void refreshTargets()}>
            <RefreshCw size={14} aria-hidden="true" /> Refresh targets
          </button>
        </div>

        {runtimeMode === 'cluster' && (
          <div className="notice notice-info" role="status">
            <CheckCircle size={16} aria-hidden="true" />
            <span>Cluster subscriptions deliver checkpoint-committed output from any gateway. The initial release admits only named, non-windowed managed keyed aggregate streams; other stream shapes and materialized views fail closed.</span>
          </div>
        )}
        {runtimeMode === 'unknown' && (
          <div className="notice notice-error" role="alert"><AlertCircle size={16} aria-hidden="true" /><span>{targetError || 'Runtime mode could not be verified.'}</span></div>
        )}
        {runtimeMode !== 'unknown' && targetError && (
          <div className="notice notice-warning" role="status"><AlertTriangle size={16} aria-hidden="true" /><span>{targetError}</span></div>
        )}

        <div className="subscription-form">
          <div className="field-group">
            <label htmlFor="subscription-target">Target</label>
            <select id="subscription-target" className="input-field" value={target} onChange={(event) => setTarget(event.target.value)} disabled={activeSubscription}>
              <option value="">Select a stream or materialized view</option>
              {targets.map((item) => {
                const unavailable = runtimeMode === 'cluster' && item.kind === 'materialized view';
                return (
                  <option key={`${item.kind}:${item.name}`} value={item.name} disabled={unavailable}>
                    {item.name} · {item.kind}{unavailable ? ' · unavailable in cluster' : ''}
                  </option>
                );
              })}
            </select>
          </div>
          <div className="field-group">
            <label htmlFor="subscription-epoch">AS OF epoch <span className="optional-label">optional</span></label>
            <input
              id="subscription-epoch"
              className="input-field"
              inputMode="numeric"
              pattern="[0-9]*"
              value={asOfInput}
              onChange={(event) => setAsOfInput(event.target.value)}
              placeholder="Live tail when empty"
              disabled={activeSubscription}
              aria-describedby="subscription-epoch-help"
            />
            <span id="subscription-epoch-help" className="field-help">
              {runtimeMode === 'cluster'
                ? 'Replays from every partition’s exclusive frontier after a retained committed epoch. History is durable in verified checkpoint segments, but byte-bounded and may be pruned.'
                : 'Replays strictly after a retained committed barrier; local history is in memory and is not durable across restart.'}
            </span>
          </div>
        </div>

        <div className="editor-actions">
          {activeSubscription ? (
            <button className="btn btn-danger" type="button" onClick={stopSubscription}><CircleStop size={14} aria-hidden="true" /> Stop subscription</button>
          ) : (
            <button className="btn btn-primary" type="button" onClick={startSubscription} disabled={!canSubscribe}>
              <Radio size={14} aria-hidden="true" /> {asOfInput.trim() ? 'Replay and follow' : 'Attach live tail'}
            </button>
          )}
          {(subscriptionStatus === 'interrupted' || subscriptionStatus === 'gap') && progress && (
            <button className="btn btn-secondary" type="button" onClick={resumeAfterProgress}>
              <RotateCcw size={14} aria-hidden="true" /> Resume after epoch {progress.epoch}
            </button>
          )}
          {subscriptionStatus === 'interrupted' && !progress && (
            <button className="btn btn-secondary" type="button" onClick={reconnectAtTail} title="This can miss rows emitted while disconnected">
              <RotateCcw size={14} aria-hidden="true" /> Reattach at live tail
            </button>
          )}
        </div>

        {subscriptionMessage && (
          <div
            className={`notice ${subscriptionStatus === 'error' || subscriptionStatus === 'gap' || subscriptionStatus === 'interrupted' ? 'notice-error' : 'notice-info'}`}
            role={subscriptionStatus === 'error' || subscriptionStatus === 'gap' ? 'alert' : 'status'}
          >
            {subscriptionStatus === 'error' || subscriptionStatus === 'gap' || subscriptionStatus === 'interrupted'
              ? <AlertCircle size={16} aria-hidden="true" />
              : <Radio size={16} aria-hidden="true" />}
            <span>{subscriptionMessage}</span>
          </div>
        )}

        <div className="results-pane" aria-live="polite">
          <div className="results-header subscription-result-header">
            <span>
              Subscription capture
              {subscriptionStatus !== 'idle' && <span className={`status-pill status-${subscriptionStatus}`}>{subscriptionStatus}</span>}
            </span>
            <div className="result-metadata">
              <span>{receivedRows.toString()} received</span>
              <span>{capturedRows.length} retained locally</span>
              {replayDuplicates > 0n && <span>{replayDuplicates.toString()} replay duplicate{replayDuplicates === 1n ? '' : 's'} suppressed</span>}
              {progress && <span>committed epoch {progress.epoch} · checkpoint {progress.checkpoint_id}</span>}
              {latestDataEpoch && <span>latest data epoch {latestDataEpoch}</span>}
              {observedPartitions.length > 0 && <span>{observedPartitions.length} partition{observedPartitions.length === 1 ? '' : 's'} observed</span>}
              {streamGeneration && <span title={streamGeneration}>generation {streamGeneration.slice(0, 12)}…</span>}
              <button className="icon-button" type="button" onClick={clearCapture} aria-label="Clear captured subscription rows" title="Clear captured rows">
                <Trash2 size={15} aria-hidden="true" />
              </button>
            </div>
          </div>
          <div className="results-table-container">
            {capturedRows.length > 0
              ? <SubscriptionRowsTable rows={capturedRows} caption={`Captured rows from ${target}`} />
              : <div className="empty-state"><Radio size={28} aria-hidden="true" /><span>No subscription rows captured.</span></div>}
          </div>
        </div>

        <p className="protocol-note">
          The server sends protocol pings and the browser answers automatically. The console never sends application text or binary messages because LaminarDB 0.30 treats them as <code>unsupported_client_message</code> and closes the session. Cluster ordering is contiguous only within a partition; the gateway’s interleaving is not a global, arrival, event-time, or SQL order.
        </p>
      </section>
    </div>
  );
}
