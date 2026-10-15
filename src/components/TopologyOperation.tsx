import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle, Copy, RefreshCw, X } from 'lucide-react';
import { ApiError, TOPOLOGY_PHASES, api } from '../api';
import { redactSqlSecrets } from '../sqlDisplay';
import type { TopologyAdmissionPhase, TopologyAdmissionStatus, WireU64 } from '../api';
import {
  ABORT_REASONS, PHASE_DESCRIPTIONS, PHASE_LABELS, isTerminalPhase,
} from '../topologyOperations';

const POLL_INTERVAL_MS = 2_000;

/** Linear phase stepper; `aborted` replaces the remaining steps. */
export function PhaseStepper({ state }: { state: TopologyAdmissionPhase }) {
  const currentIndex = state.phase === 'aborted' ? -1 : TOPOLOGY_PHASES.indexOf(state.phase);
  return (
    <ol className="phase-stepper" aria-label="Topology migration phases">
      {TOPOLOGY_PHASES.map((phase, index) => {
        const status = state.phase === 'aborted'
          ? 'pending'
          : index < currentIndex || state.phase === 'active'
            ? 'done'
            : index === currentIndex ? 'current' : 'pending';
        return (
          <li key={phase} className={`phase-step phase-${status}`} aria-current={status === 'current' ? 'step' : undefined}>
            <span className="phase-dot" aria-hidden="true" />
            <span>{PHASE_LABELS[phase]}</span>
          </li>
        );
      })}
      {state.phase === 'aborted' && (
        <li className="phase-step phase-aborted" aria-current="step">
          <span className="phase-dot" aria-hidden="true" />
          <span>Aborted</span>
        </li>
      )}
    </ol>
  );
}

interface OperationPollState {
  status: TopologyAdmissionStatus | null;
  error: string;
  notFound: boolean;
  polling: boolean;
  refresh: () => void;
}

/**
 * Poll GET /cluster/topology/operations/{id} until Active or Aborted. Transient
 * 503/504 responses keep polling: the durable status, not the submit response,
 * is the source of truth.
 */
function useTopologyOperation(operationId: string, initial?: TopologyAdmissionStatus | null): OperationPollState {
  const [status, setStatus] = useState<TopologyAdmissionStatus | null>(initial ?? null);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [polling, setPolling] = useState(false);
  const [generation, setGeneration] = useState(0);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      setPolling(true);
      try {
        const next = await api.getClusterTopologyOperation(operationId);
        if (cancelled) return;
        setStatus(next);
        setError('');
        setNotFound(false);
        if (!isTerminalPhase(next.state)) timer.current = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
      } catch (cause) {
        if (cancelled) return;
        if (cause instanceof ApiError && cause.status === 404 && /unknown topology operation/i.test(cause.message)) {
          setNotFound(true);
          setError('');
        } else {
          setError(cause instanceof Error ? cause.message : 'Could not read the operation.');
          timer.current = window.setTimeout(() => void poll(), POLL_INTERVAL_MS * 2);
        }
      } finally {
        if (!cancelled) setPolling(false);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer.current);
    };
  }, [operationId, generation]);

  const refresh = useCallback(() => setGeneration((value) => value + 1), []);
  return { status, error, notFound, polling, refresh };
}

interface OperationCardProps {
  operationId: string;
  initial?: TopologyAdmissionStatus | null;
  statements?: string[];
  /** This process's `locally_active_version`, when the caller has it. */
  localActiveVersion?: WireU64 | null;
  onForget?: () => void;
  onTerminal?: (status: TopologyAdmissionStatus) => void;
}

export function TopologyOperationCard({
  operationId, initial, statements, localActiveVersion, onForget, onTerminal,
}: OperationCardProps) {
  const { status, error, notFound, polling, refresh } = useTopologyOperation(operationId, initial);
  const [copied, setCopied] = useState(false);
  const notified = useRef(false);

  useEffect(() => {
    if (status && isTerminalPhase(status.state) && !notified.current) {
      notified.current = true;
      onTerminal?.(status);
    }
  }, [onTerminal, status]);

  const target = status?.commit?.topology_version;
  const localActive = target !== undefined && localActiveVersion !== undefined && localActiveVersion !== null
    && BigInt(localActiveVersion) >= BigInt(target);

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(operationId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied; the ID stays selectable.
    }
  };

  return (
    <div className="glass-card topology-operation" aria-live="polite">
      <div className="card-header">
        <div className="topology-operation-title">
          <span className="eyebrow">Topology operation</span>
          <code className="operation-id">{operationId}</code>
        </div>
        <div className="topology-operation-actions">
          {status && (
            <span className={`badge ${status.state.phase === 'active' ? 'badge-emerald' : status.state.phase === 'aborted' ? 'badge-amber' : 'badge-blue'}`}>
              {PHASE_LABELS[status.state.phase]}
            </span>
          )}
          <button type="button" className="icon-button" onClick={() => void copyId()} aria-label="Copy operation ID" title={copied ? 'Copied' : 'Copy operation ID'}>
            {copied ? <CheckCircle size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          </button>
          <button type="button" className="icon-button" onClick={refresh} aria-label="Refresh operation status" disabled={polling}>
            <RefreshCw size={14} className={polling ? 'animate-spin' : ''} aria-hidden="true" />
          </button>
          {onForget && (
            <button type="button" className="icon-button" onClick={onForget} aria-label="Stop tracking this operation">
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {notFound && (
        <div className="notice notice-warning" role="status">
          <AlertCircle size={15} aria-hidden="true" />
          <span>The cluster journal has no request with this identity. If a submission timed out before admission, resubmit the same payload with this same operation ID.</span>
        </div>
      )}
      {error && (
        <div className="notice notice-error" role="status">
          <AlertCircle size={15} aria-hidden="true" />
          <span>{error} — retrying.</span>
        </div>
      )}

      {status && (
        <>
          <PhaseStepper state={status.state} />
          <p className="phase-description">
            {PHASE_DESCRIPTIONS[status.state.phase]}
            {status.state.phase === 'aborted' && ` ${ABORT_REASONS[status.state.reason] ?? status.state.reason}`}
          </p>
          <dl className="kv-grid">
            <dt>Status sequence</dt><dd>{status.status_sequence}</dd>
            <dt>Admitted at sequence</dt><dd>{status.admitted_sequence}</dd>
            <dt>Plan</dt><dd><code title={status.plan.sha256}>{status.plan.sha256.slice(0, 16)}…</code> · {status.plan.encoded_len} bytes</dd>
            {status.certificates > 0 && <><dt>Preparation certificates</dt><dd>{status.certificates}</dd></>}
            {status.completed_cut_participants > 0 && <><dt>Cut participants complete</dt><dd>{status.completed_cut_participants}</dd></>}
            {status.commit && (
              <>
                <dt>Target topology</dt>
                <dd>v{status.commit.parent_version} → v{status.commit.topology_version} ({status.commit.manifest.entry_count} catalog entries)</dd>
              </>
            )}
            {status.activation && (
              <>
                <dt>Installations</dt>
                <dd>{status.activation.installations} of {status.activation.processes} processes{status.activation.released_sequence ? ' · Release committed' : ''}</dd>
              </>
            )}
            {target !== undefined && localActiveVersion !== undefined && (
              <>
                <dt>This node</dt>
                <dd>{localActive
                  ? `running topology v${localActiveVersion}`
                  : localActiveVersion === null
                    ? 'no locally active topology yet'
                    : `still running v${localActiveVersion}`}</dd>
              </>
            )}
          </dl>
          {statements && statements.length > 0 && (
            <details className="statement-details">
              <summary>{statements.length} statement{statements.length === 1 ? '' : 's'}</summary>
              <ol>
                {statements.map((statement, index) => <li key={index}><code>{redactSqlSecrets(statement)}</code></li>)}
              </ol>
            </details>
          )}
        </>
      )}
      {!status && !notFound && !error && <p className="protocol-note">Reading durable status…</p>}
    </div>
  );
}
