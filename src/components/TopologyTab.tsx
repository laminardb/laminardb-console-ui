import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle, CheckCircle, GitMerge, History, Info, ListChecks, Network, RefreshCw, Search,
  ShieldAlert, Upload,
} from 'lucide-react';
import { ApiError, api, isOperationUuid, newOperationId } from '../api';
import type {
  AssignmentSnapshot, ClusterTopologyStatus, ClusterTopologyValidation, LegacyTopologyBaseline,
  NodeInfo, TopologyAdmissionStatus, WireU64,
} from '../api';
import { M, fetchMetricsSnapshot, latestSnapshot, value } from '../metrics';
import { splitSqlStatements, topologyStatementProblems } from '../sqlStatements';
import { redactSqlSecrets } from '../sqlDisplay';
import {
  forgetOperation, subscribeTrackedOperations, trackOperation, trackedOperations,
} from '../topologyOperations';
import type { TrackedOperation } from '../topologyOperations';
import { Meter, StatTile } from './charts';
import ConfirmDialog from './ConfirmDialog';
import { TopologyOperationCard } from './TopologyOperation';

type Mode = 'loading' | 'cluster' | 'single' | 'error';

interface PendingRequest {
  operationId: string;
  parent: WireU64;
  fingerprint: string;
  statements: string[];
}

const CATALOG_LABELS: Record<ClusterTopologyStatus['catalog']['state'], string> = {
  uninitialized: 'Uninitialized',
  legacy_sealed: 'Legacy (unadopted)',
  versioned: 'Versioned',
};

const TRANSITION_LABELS: Record<string, string> = {
  preserve: 'Preserve',
  add_future_only: 'Add (future only)',
  remove: 'Remove',
};

const INITIALIZATION_LABELS: Record<string, string> = {
  preserve_exact_cut: 'Keep state and progress at the cut',
  future_only_at_cut: 'Only input after the cut',
  empty_managed_state_at_cut: 'New empty managed state at the cut',
  resolve_source_positions_once: 'Resolve source positions once at the cut',
  retire_at_cut: 'Retire at the cut',
};

const REQUIREMENT_LABELS: Record<string, string> = {
  participant_plan_agreement: 'Every owner process certifies the same plan',
  reconciled_checkpoint_cut: 'One reconciled old-topology checkpoint cut',
  durable_initialization_and_progress: 'Durable source positions, state mapping and output frontiers',
  observed_actor_retirement: 'Superseded actors observed retired',
  atomic_target_commit: 'Atomic target catalog commit',
  installed_target_release: 'Owner-complete installation and Release',
};

/** Network failures and 503/504 leave the admission outcome uncertain. */
function outcomeUncertain(error: unknown): boolean {
  if (error instanceof ApiError) return error.status === 503 || error.status === 504;
  return error instanceof TypeError;
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.code && !error.message.includes(error.code) ? `[${error.code}] ${error.message}` : error.message;
  return error instanceof Error ? error.message : fallback;
}

function shortSha(sha: string): string {
  return sha.length > 12 ? `${sha.slice(0, 12)}…` : sha;
}

export default function TopologyTab() {
  const [mode, setMode] = useState<Mode>('loading');
  const [status, setStatus] = useState<ClusterTopologyStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [assignment, setAssignment] = useState<AssignmentSnapshot | null>(null);
  const [ownedVnodes, setOwnedVnodes] = useState<number | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [tracked, setTracked] = useState<TrackedOperation[]>(() => trackedOperations());

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const [topology, nodeList, vnodes] = await Promise.allSettled([
      api.getClusterTopology(),
      api.getClusterNodes(),
      api.getClusterVnodes(),
      fetchMetricsSnapshot(),
    ]);
    if (topology.status === 'fulfilled') {
      setStatus(topology.value);
      setMode('cluster');
      setStatusError('');
    } else if (topology.reason instanceof ApiError && topology.reason.status === 404) {
      setStatus(null);
      setMode('single');
      setStatusError('');
    } else {
      setStatusError(errorText(topology.reason, 'Could not read cluster topology.'));
      setMode((current) => current === 'loading' ? 'error' : current);
    }
    if (nodeList.status === 'fulfilled') setNodes(nodeList.value);
    if (vnodes.status === 'fulfilled') setAssignment(vnodes.value);
    setOwnedVnodes(value(latestSnapshot(), M.placementOwnedVnodes));
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  useEffect(() => subscribeTrackedOperations(() => setTracked(trackedOperations())), []);

  if (mode === 'single') {
    return (
      <div className="tab-page" aria-labelledby="topology-title">
        <div className="tab-heading">
          <div>
            <h1 id="topology-title">Cluster topology</h1>
            <p>Versioned topology migrations, legacy adoption, and ownership changes.</p>
          </div>
        </div>
        <div className="glass-card empty-state" style={{ flexDirection: 'column' }}>
          <Network size={40} aria-hidden="true" style={{ opacity: 0.35 }} />
          <strong>This server runs in single-node mode.</strong>
          <span style={{ maxWidth: 620 }}>
            <code>/api/v1/cluster/topology</code> answers 404 outside <code>server.mode = "cluster"</code>. Single-node topology DDL stays offline: suspend the pipeline, run the DDL from the catalog or worksheet, then resume. A checkpointed runtime rejects live DDL with [LDB-6043].
          </span>
        </div>
      </div>
    );
  }

  const committed = status?.committed_version ?? null;
  const localActive = status?.locally_active_version ?? null;
  const liveMigration = status?.live_migration ?? null;
  const journal = status?.journal;
  const journalFull = journal ? journal.retained >= journal.capacity : false;
  const draining = nodes.filter((node) => node.state === 'Draining');
  const vnodeCount = assignment ? Object.keys(assignment.vnodes).length : undefined;
  const ownerCount = assignment ? new Set(Object.values(assignment.vnodes)).size : undefined;

  return (
    <div className="tab-page" aria-labelledby="topology-title">
      <div className="tab-heading">
        <div>
          <h1 id="topology-title">Cluster topology</h1>
          <p>Atomic, checkpoint-cut migrations of sources, streams and sinks in a running cluster. Activation evidence below is reported by the node this console is connected to.</p>
        </div>
        <button className="btn btn-secondary" type="button" onClick={() => void refresh()} disabled={refreshing}>
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} aria-hidden="true" />
          <span>Refresh</span>
        </button>
      </div>

      {statusError && (
        <div className="notice notice-error" role="alert">
          <AlertCircle size={16} aria-hidden="true" />
          <span>Topology status unavailable: {statusError}{status ? ' Showing the last successful status.' : ''}</span>
        </div>
      )}

      {liveMigration !== null && (
        <div className="notice notice-warning" role="status">
          <ShieldAlert size={16} aria-hidden="true" />
          <span>
            Topology v{liveMigration} is committed but not yet Active with its own committed checkpoint. The complete vnode owner map is frozen: do not scale in or out until this clears. Only same-slot replacement of a failed process is admitted.
          </span>
        </div>
      )}

      {status && (
        <div className="grid-container grid-cols-4">
          <StatTile
            label="Catalog"
            value={committed ? `v${committed}` : CATALOG_LABELS[status.catalog.state]}
            sub={status.catalog.state === 'versioned'
              ? status.catalog.committed
                ? `Last change ${shortSha(status.catalog.committed.operation_id)}`
                : 'Adopted baseline (topology 1)'
              : status.catalog.state === 'legacy_sealed'
                ? 'Adoption required before runtime DDL'
                : 'No catalog inventory sealed yet'}
            tone={status.catalog.state === 'legacy_sealed' ? 'warning' : 'default'}
            icon={<GitMerge size={16} style={{ color: 'hsl(var(--primary))' }} aria-hidden="true" />}
          />
          <StatTile
            label="This node runs"
            value={localActive ? `v${localActive}` : 'Not active'}
            sub={localActive && committed
              ? localActive === committed ? 'Matches the committed catalog' : `Committed catalog is v${committed}`
              : 'Requires Running, live authority and released intake'}
            tone={localActive && committed && localActive !== committed ? 'warning' : 'default'}
            icon={<CheckCircle size={16} style={{ color: localActive && localActive === committed ? 'hsl(var(--status-success))' : 'hsl(var(--text-muted))' }} aria-hidden="true" />}
          />
          <StatTile
            label="Live migration"
            value={liveMigration ? `v${liveMigration}` : 'None'}
            sub={liveMigration ? 'Owner map frozen until settled' : 'Rescaling is not blocked by a migration'}
            tone={liveMigration ? 'warning' : 'default'}
            icon={<ShieldAlert size={16} style={{ color: liveMigration ? 'hsl(var(--status-warning))' : 'hsl(var(--text-muted))' }} aria-hidden="true" />}
          />
          <div className="glass-card">
            <Meter
              label="Request journal"
              value={journal?.retained ?? 0}
              max={journal?.capacity ?? 0}
              format={(count) => String(count)}
              over={journalFull}
            />
            <p className="protocol-note" style={{ marginTop: 8 }}>
              {journalFull
                ? 'Full: new requests are rejected; retries of retained identities still work. The journal does not compact yet.'
                : 'Every admitted identity is retained so retries return the original outcome.'}
            </p>
          </div>
        </div>
      )}

      {status?.catalog.state === 'legacy_sealed' && (
        <AdoptionPanel status={status} onAdopted={() => void refresh()} />
      )}

      {status?.catalog.state === 'uninitialized' && (
        <div className="notice notice-info" role="note">
          <Info size={16} aria-hidden="true" />
          <span>No catalog inventory has been sealed yet. Topology versions start once the initial catalog is sealed (and, for clusters created before 0.32, explicitly adopted).</span>
        </div>
      )}

      {status?.catalog.state === 'versioned' && committed && (
        <MigrationComposer
          parent={committed}
          journalFull={journalFull}
          onSubmitted={() => void refresh()}
        />
      )}

      <TrackedOperations tracked={tracked} localActiveVersion={localActive} enabled={mode === 'cluster'} />

      <div className="glass-card section-stack">
        <div className="card-header">
          <h2 style={{ fontSize: 15, margin: 0 }}>Ownership and rescaling</h2>
          <Network size={16} aria-hidden="true" style={{ color: 'hsl(var(--text-muted))' }} />
        </div>
        <dl className="kv-grid">
          <dt>This process owns</dt>
          <dd>{ownedVnodes === undefined ? 'Not reported (placement_owned_vnodes)' : `${ownedVnodes} vnode${ownedVnodes === 1 ? '' : 's'}`}</dd>
          <dt>Assignment</dt>
          <dd>{assignment ? `v${assignment.version} · ${vnodeCount} vnodes across ${ownerCount} owner${ownerCount === 1 ? '' : 's'}${assignment.draining ? ' · drain phase in progress' : ''}` : 'Not loaded'}</dd>
          <dt>Draining nodes</dt>
          <dd>{draining.length === 0 ? 'None' : draining.map((node) => `${node.name} (${node.id})`).join(', ')}</dd>
        </dl>
        <ul className="guidance-list">
          <li>There is no rescale API. <strong>Scale out</strong> by starting another node with a new stable <code>node_id</code>; the leader adds it after the rebalance debounce and a handoff checkpoint.</li>
          <li><strong>Scale in</strong> by sending SIGTERM. The node reports <code>Draining</code> and waits up to <code>server.drain_timeout</code> (default <code>checkpoint.timeout</code> + 30 s) for its vnodes to move; on timeout it exits fenced and survivors recover from the last committed checkpoint.</li>
          <li>The vnode count (<code>server.key_groups</code>) is fixed per deployment. Before removing a node permanently, confirm the assignment no longer names it.</li>
          <li>Upgrade every node before rescaling a migrated deployment: older binaries reject a changed owner map after a migration.</li>
        </ul>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function AdoptionPanel({ status, onAdopted }: { status: ClusterTopologyStatus; onAdopted: () => void }) {
  const manifest = status.catalog.state === 'legacy_sealed' ? status.catalog.manifest : null;
  const [deploymentId, setDeploymentId] = useState('');
  const [upgradeComplete, setUpgradeComplete] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [baseline, setBaseline] = useState<LegacyTopologyBaseline | null>(null);
  // Reuse one identity for every retry of the same adoption inputs.
  const pending = useRef<{ operationId: string; fingerprint: string } | null>(null);

  if (!manifest) return null;
  const normalizedDeployment = deploymentId.trim().toLowerCase();
  const deploymentValid = isOperationUuid(normalizedDeployment);

  const adopt = async () => {
    setConfirming(false);
    setBusy(true);
    setError('');
    const fingerprint = JSON.stringify([normalizedDeployment, manifest.sha256]);
    if (!pending.current || pending.current.fingerprint !== fingerprint) {
      pending.current = { operationId: newOperationId(), fingerprint };
    }
    try {
      const result = await api.adoptClusterTopology({
        operation_id: pending.current.operationId,
        expected_manifest: manifest,
        expected_deployment_id: normalizedDeployment,
        coordinated_upgrade_complete: upgradeComplete,
      });
      pending.current = null;
      setBaseline(result);
      onAdopted();
    } catch (cause) {
      if (!outcomeUncertain(cause)) pending.current = null;
      setError(`${errorText(cause, 'Adoption failed.')}${outcomeUncertain(cause) ? ' The outcome is uncertain; retrying reuses the same operation identity.' : ''}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="glass-card section-stack">
      <div className="card-header">
        <div>
          <h2 style={{ fontSize: 15, margin: 0 }}>Adopt the legacy catalog</h2>
          <p className="protocol-note">This catalog was sealed before versioned topology existed. Adoption turns the exact existing inventory into topology 1 without rewriting it. Runtime DDL and migrations are refused until it is adopted.</p>
        </div>
        <Upload size={16} aria-hidden="true" style={{ color: 'hsl(var(--text-muted))' }} />
      </div>
      <dl className="kv-grid">
        <dt>Sealed manifest</dt>
        <dd><code title={manifest.sha256}>{shortSha(manifest.sha256)}</code> · {manifest.entry_count} entries · {manifest.encoded_len} bytes · format v{manifest.version}</dd>
      </dl>
      <div className="field-group">
        <label htmlFor="adopt-deployment-id">Deployment ID</label>
        <input
          id="adopt-deployment-id"
          className="input-field"
          value={deploymentId}
          onChange={(event) => setDeploymentId(event.target.value)}
          placeholder="Checkpoint-store deployment UUID"
          autoComplete="off"
          spellCheck={false}
          aria-describedby="adopt-deployment-help"
          aria-invalid={deploymentId.trim() !== '' && !deploymentValid}
        />
        <span id="adopt-deployment-help" className="field-help">
          No HTTP route exposes the deployment UUID before adoption; read it from the checkpoint store’s deployment record. It must be the canonical lowercase UUID.
        </span>
      </div>
      <label className="checkbox-row">
        <input type="checkbox" checked={upgradeComplete} onChange={(event) => setUpgradeComplete(event.target.checked)} />
        <span>Every node in the cluster already runs the 0.32 binary (coordinated upgrade complete).</span>
      </label>
      {error && (
        <div className="notice notice-error" role="alert">
          <AlertCircle size={15} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
      {baseline && (
        <div className="notice notice-success" role="status">
          <CheckCircle size={15} aria-hidden="true" />
          <span>Adopted as topology v{baseline.topology_version} (operation <code>{baseline.operation_id}</code>, authority sequence {baseline.authority_sequence}).</span>
        </div>
      )}
      <div>
        <button className="btn btn-primary" type="button" disabled={!deploymentValid || !upgradeComplete || busy} onClick={() => setConfirming(true)}>
          {busy ? <RefreshCw size={14} className="animate-spin" aria-hidden="true" /> : <Upload size={14} aria-hidden="true" />}
          <span>{busy ? 'Adopting…' : 'Adopt as topology 1'}</span>
        </button>
      </div>
      <ConfirmDialog
        open={confirming}
        title="Adopt the legacy catalog?"
        description={<>This durably records the sealed manifest <code>{shortSha(manifest.sha256)}</code> as topology 1 for deployment <code>{normalizedDeployment}</code>. It cannot be undone. Do this only after every node runs the new binary.</>}
        confirmLabel="Adopt catalog"
        danger
        busy={busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void adopt()}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function MigrationComposer({ parent, journalFull, onSubmitted }: { parent: WireU64; journalFull: boolean; onSubmitted: () => void }) {
  const [script, setScript] = useState('');
  const [validation, setValidation] = useState<{ fingerprint: string; result: ClusterTopologyValidation } | null>(null);
  const [validating, setValidating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // Reused verbatim for every retry of an unchanged payload whose outcome is uncertain.
  const [pending, setPending] = useState<PendingRequest | null>(null);

  const statements = useMemo(() => splitSqlStatements(script), [script]);
  const problems = useMemo(() => script.trim() ? topologyStatementProblems(statements) : [], [script, statements]);
  const fingerprint = JSON.stringify([parent, statements]);
  const validationCurrent = validation?.fingerprint === fingerprint ? validation.result : null;
  const retryable = pending?.fingerprint === fingerprint;

  const validate = async () => {
    setValidating(true);
    setError('');
    setNotice('');
    try {
      const result = await api.validateClusterTopology(parent, statements);
      setValidation({ fingerprint, result });
    } catch (cause) {
      setValidation(null);
      setError(errorText(cause, 'Validation failed.'));
    } finally {
      setValidating(false);
    }
  };

  const submit = async () => {
    setConfirming(false);
    setSubmitting(true);
    setError('');
    setNotice('');
    const request = pending && pending.fingerprint === fingerprint
      ? pending
      : { operationId: newOperationId(), parent, fingerprint, statements };
    setPending(request);
    try {
      const receipt: TopologyAdmissionStatus = await api.submitClusterTopology({
        operation_id: request.operationId,
        expected_parent_version: request.parent,
        statements: request.statements,
      });
      trackOperation({ operation_id: receipt.operation_id, origin: 'request', statements: request.statements });
      setPending(null);
      setScript('');
      setValidation(null);
      setNotice(`Admitted as ${receipt.operation_id}. Progress is tracked below.`);
      onSubmitted();
    } catch (cause) {
      if (outcomeUncertain(cause)) {
        // The request may have been admitted. Track the identity so its
        // durable status is visible, and keep it for an identical retry.
        trackOperation({ operation_id: request.operationId, origin: 'request', statements: request.statements });
        setError(`${errorText(cause, 'Submission outcome unknown.')} The outcome is uncertain. The operation is tracked below; if it stays unknown, retry — the same identity and payload are reused.`);
      } else {
        setPending(null);
        setError(errorText(cause, 'Submission failed.'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="glass-card section-stack">
      <div className="card-header">
        <div>
          <h2 style={{ fontSize: 15, margin: 0 }}>Change topology</h2>
          <p className="protocol-note">
            One atomic request may CREATE, CREATE OR REPLACE or DROP sources, streams and sinks (1–64 statements, no CASCADE). Compatible replacements keep their state; reset an incompatible object with an ordered DROP then CREATE, dependants first. New or reset state processes only input after the cut. Materialized views and tables are not migratable.
          </p>
        </div>
        <GitMerge size={16} aria-hidden="true" style={{ color: 'hsl(var(--text-muted))' }} />
      </div>
      <div className="field-group">
        <label htmlFor="topology-script">Statements (parent topology v{parent})</label>
        <textarea
          id="topology-script"
          className="input-field sql-input"
          rows={7}
          value={script}
          onChange={(event) => setScript(event.target.value)}
          placeholder={'CREATE STREAM hot_devices AS\n  SELECT device, COUNT(*) AS n FROM readings GROUP BY device;\nCREATE SINK hot_devices_out FROM hot_devices INTO KAFKA (...) FORMAT JSON;'}
          spellCheck={false}
          aria-describedby="topology-script-help"
        />
        <span id="topology-script-help" className="field-help">
          Separate statements with semicolons. Each becomes one entry of the request, verbatim; the exact text is bound into the operation’s plan hash.
        </span>
      </div>
      {statements.length > 0 && (
        <p className="protocol-note">{statements.length} statement{statements.length === 1 ? '' : 's'} parsed.</p>
      )}
      {problems.length > 0 && (
        <div className="notice notice-warning" role="status">
          <AlertCircle size={15} aria-hidden="true" />
          <span>{problems.join(' ')}</span>
        </div>
      )}
      {journalFull && (
        <div className="notice notice-warning" role="status">
          <AlertCircle size={15} aria-hidden="true" />
          <span>The request journal is full, so new identities are rejected. Only retries of retained operations can succeed.</span>
        </div>
      )}
      {error && (
        <div className="notice notice-error" role="alert">
          <AlertCircle size={15} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="notice notice-success" role="status">
          <CheckCircle size={15} aria-hidden="true" />
          <span>{notice}</span>
        </div>
      )}
      <div className="button-row">
        <button className="btn btn-secondary" type="button" disabled={statements.length === 0 || problems.length > 0 || validating} onClick={() => void validate()}>
          {validating ? <RefreshCw size={14} className="animate-spin" aria-hidden="true" /> : <ListChecks size={14} aria-hidden="true" />}
          <span>{validating ? 'Validating…' : 'Validate on this node'}</span>
        </button>
        <button className="btn btn-primary" type="button" disabled={statements.length === 0 || problems.length > 0 || submitting} onClick={() => setConfirming(true)}>
          {submitting ? <RefreshCw size={14} className="animate-spin" aria-hidden="true" /> : <GitMerge size={14} aria-hidden="true" />}
          <span>{submitting ? 'Submitting…' : retryable ? 'Retry submission' : 'Submit migration'}</span>
        </button>
      </div>

      {validationCurrent && <ValidationReport validation={validationCurrent} />}

      <ConfirmDialog
        open={confirming}
        title="Submit this topology migration?"
        description={(
          <>
            The cluster pauses processing at a checkpoint cut, every owner process certifies and installs the new graph, then intake resumes. Once the request reaches <strong>Committed</strong> it can no longer abort. {statements.length} statement{statements.length === 1 ? '' : 's'} will be applied atomically against parent v{parent}.
            {!validationCurrent && ' This exact payload has not been validated.'}
          </>
        )}
        confirmLabel="Submit migration"
        danger
        busy={submitting}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void submit()}
      />
    </div>
  );
}

function ValidationReport({ validation }: { validation: ClusterTopologyValidation }) {
  return (
    <div className="section-stack validation-report">
      <div className="notice notice-success" role="status">
        <CheckCircle size={15} aria-hidden="true" />
        <span>
          This node compiled a compatible candidate: v{validation.parent_version} → v{validation.target_version} ({validation.target_manifest.entry_count} catalog entries). Scope <code>{validation.scope}</code> certifies only this process’s local plan; every owner must still agree during admission. Nothing was written.
        </span>
      </div>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Planned object transitions">
        <table className="meta-table">
          <caption className="sr-only">Planned object transitions</caption>
          <thead>
            <tr>
              <th scope="col">Object</th>
              <th scope="col">Kind</th>
              <th scope="col">Transition</th>
              <th scope="col">Initialization</th>
              <th scope="col">Managed state</th>
              <th scope="col">Depends on</th>
            </tr>
          </thead>
          <tbody>
            {validation.objects.map((object) => (
              <tr key={`${object.name}-${object.catalog_generation}`}>
                <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                  {object.name}
                  <span className="protocol-note"> gen {object.catalog_generation}</span>
                </td>
                <td>{object.kind.replace(/_/g, ' ')}</td>
                <td>
                  <span className={`badge ${object.transition === 'preserve' ? 'badge-purple' : object.transition === 'remove' ? 'badge-amber' : 'badge-emerald'}`}>
                    {TRANSITION_LABELS[object.transition] ?? object.transition}
                  </span>
                </td>
                <td>{INITIALIZATION_LABELS[object.initialization] ?? object.initialization}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{object.managed_state_contract ?? '—'}</td>
                <td style={{ fontSize: 12 }}>{object.dependencies.length ? object.dependencies.join(', ') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <h3 className="subheading">Still required before activation</h3>
        <ul className="guidance-list">
          {validation.required_before_activation.map((requirement) => (
            <li key={requirement}>{REQUIREMENT_LABELS[requirement] ?? requirement}</li>
          ))}
          {validation.requires_processing_pause && <li>A processing pause at the checkpoint cut.</li>}
        </ul>
      </div>
      <details className="statement-details">
        <summary>Validated statements and identities</summary>
        <dl className="kv-grid">
          <dt>Compatibility</dt><dd><code>{validation.compatibility_sha256}</code></dd>
          <dt>Environment</dt><dd><code>{validation.environment_sha256}</code></dd>
          <dt>Deployment</dt><dd><code>{validation.deployment_id}</code></dd>
        </dl>
        <ol>
          {validation.statements.map((statement, index) => <li key={index}><code>{redactSqlSecrets(statement)}</code></li>)}
        </ol>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------

function TrackedOperations({ tracked, localActiveVersion, enabled }: { tracked: TrackedOperation[]; localActiveVersion: WireU64 | null; enabled: boolean }) {
  const [lookup, setLookup] = useState('');
  const normalized = lookup.trim().toLowerCase();
  const valid = isOperationUuid(normalized);

  return (
    <div className="section-stack">
      <div className="section-heading-row">
        <div>
          <h2><History size={15} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 6 }} />Operations</h2>
          <p>Operations submitted from this browser session, SQL DDL receipts, and looked-up identities. Each is read from the durable journal.</p>
        </div>
        <form
          className="lookup-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid) return;
            trackOperation({ operation_id: normalized, origin: 'lookup' });
            setLookup('');
          }}
        >
          <label htmlFor="operation-lookup" className="sr-only">Operation ID</label>
          <input
            id="operation-lookup"
            className="input-field"
            placeholder="Track an operation ID…"
            value={lookup}
            onChange={(event) => setLookup(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={lookup.trim() !== '' && !valid}
          />
          <button className="btn btn-secondary" type="submit" disabled={!valid || !enabled}>
            <Search size={14} aria-hidden="true" />
            <span>Track</span>
          </button>
        </form>
      </div>
      {tracked.length === 0 ? (
        <div className="glass-card empty-state">No topology operations tracked in this session.</div>
      ) : (
        tracked.map((operation) => (
          <TopologyOperationCard
            key={operation.operation_id}
            operationId={operation.operation_id}
            statements={operation.statements}
            localActiveVersion={localActiveVersion}
            onForget={() => forgetOperation(operation.operation_id)}
          />
        ))
      )}
    </div>
  );
}
