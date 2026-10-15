/**
 * Session-local list of topology operations this console submitted or was
 * asked to track. The engine has no list endpoint; it retains every admitted
 * identity in a bounded journal and answers GET /operations/{id} for each.
 */
import { getConnectionConfig, isOperationUuid } from './api';
import type { TopologyAdmissionPhase } from './api';
import { redactSqlSecrets } from './sqlDisplay';

export interface TrackedOperation {
  operation_id: string;
  /** Where the identity came from: a console request, SQL DDL, or manual lookup. */
  origin: 'request' | 'sql' | 'lookup';
  added_at: number;
  statements?: string[];
}

const STORAGE_PREFIX = 'laminardb_topology_operations:';
const MAX_TRACKED = 64;
const listeners = new Set<() => void>();

function storageKey(): string {
  return `${STORAGE_PREFIX}${getConnectionConfig().baseUrl}`;
}

export function trackedOperations(): TrackedOperation[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(storageKey()) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is TrackedOperation =>
      typeof item === 'object' && item !== null
      && typeof (item as TrackedOperation).operation_id === 'string'
      && isOperationUuid((item as TrackedOperation).operation_id));
  } catch {
    return [];
  }
}

export function trackOperation(operation: Omit<TrackedOperation, 'added_at'>): void {
  const existing = trackedOperations().filter((item) => item.operation_id !== operation.operation_id);
  // Statements can carry connector credentials; only a redacted copy is kept.
  const statements = operation.statements?.map(redactSqlSecrets);
  const next = [{ ...operation, statements, added_at: Date.now() }, ...existing].slice(0, MAX_TRACKED);
  try {
    sessionStorage.setItem(storageKey(), JSON.stringify(next));
  } catch {
    // Storage may be unavailable; tracking is a convenience only.
  }
  listeners.forEach((listener) => listener());
}

export function forgetOperation(operationId: string): void {
  const next = trackedOperations().filter((item) => item.operation_id !== operationId);
  try {
    sessionStorage.setItem(storageKey(), JSON.stringify(next));
  } catch {
    // ignore
  }
  listeners.forEach((listener) => listener());
}

export function subscribeTrackedOperations(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isTerminalPhase(state: TopologyAdmissionPhase): boolean {
  return state.phase === 'active' || state.phase === 'aborted';
}

export const PHASE_LABELS: Record<TopologyAdmissionPhase['phase'], string> = {
  planned: 'Planned',
  preparing: 'Preparing',
  quiescing: 'Quiescing',
  cut_prepared: 'Cut prepared',
  committed: 'Committed',
  activating: 'Activating',
  active: 'Active',
  aborted: 'Aborted',
};

export const PHASE_DESCRIPTIONS: Record<TopologyAdmissionPhase['phase'], string> = {
  planned: 'Request reserved; the running graph and catalog still belong to the parent topology.',
  preparing: 'Every required process compiles and certifies the exact candidate; intake stays open.',
  quiescing: 'One old-topology checkpoint barrier and sink settlement are in progress.',
  cut_prepared: 'Every process applied the cut and is holding intake.',
  committed: 'Target catalog and migration root are durable. Irreversible — the request can no longer abort, but the target is not running yet.',
  activating: 'Collecting installation receipts for the target runtime while intake is held.',
  active: 'Release committed for the complete roster. Each node reports its own local activation separately.',
  aborted: 'Definitively aborted before the target commit; no candidate actors were authorized.',
};

export const ABORT_REASONS: Record<string, string> = {
  requested: 'Cancelled before quiescence.',
  leader_changed: 'The leader term changed before cutover.',
  recovery: 'Recovery was durably requested before cutover.',
  checkpoint_aborted: 'The bound old-topology checkpoint was aborted.',
};
