import { parse as parseLosslessJson } from 'lossless-json';

/** Values declared as Rust `u64` on control-plane JSON are represented as strings in the UI. */
export type WireU64 = string;

export interface ConnectionConfig {
  baseUrl: string;
  token: string;
}

export interface ErrorBody {
  error: string;
}

export interface HealthResponse {
  status: 'healthy' | 'unhealthy' | string;
  version: string;
  pipeline_state: string;
}

export interface ReadinessProbe {
  ready: boolean;
  http_status: number;
  health?: HealthResponse;
  error?: string;
}

export interface ConnectionProbe {
  health: HealthResponse;
  health_http_status: number;
  readiness: ReadinessProbe;
  pipeline: PipelineStatusResponse | null;
  /** `null` means the startup serving gate ran before auth could be checked. */
  control_plane_authenticated: boolean | null;
}

export interface SourceInfo {
  name: string;
  watermark_column?: string;
}

export interface SinkInfo {
  name: string;
}

export interface StreamInfo {
  name: string;
  sql?: string;
}

export interface MaterializedViewInfo {
  name: string;
  sql: string;
  state: string;
}

export interface ConfigKeySpec {
  key: string;
  description: string;
  required: boolean;
  default: string | null;
}

/** `SchemaDiscovery`: explicit | built_in | metadata | query (snake_case). */
export type SchemaDiscovery = 'explicit' | 'built_in' | 'metadata' | 'query';
/** `SchemaPreparation`: none | explicit_table_creation | explicit_registration. */
export type SchemaPreparation = 'none' | 'explicit_table_creation' | 'explicit_registration';

/** Direction-specific schema authority reported by `ConnectorInfo.schema_capabilities`. */
export interface SchemaCapabilities {
  discovery: SchemaDiscovery;
  /** Formats with authoritative metadata; empty with `metadata` discovery means a native protocol. */
  metadata_formats: string[];
  /** Fixed-decoder formats; empty with `built_in` discovery means a native protocol. */
  built_in_formats: string[];
  query_derived: boolean;
  bounded_sampling: boolean;
  preparation: SchemaPreparation;
}

export interface ConnectorInfo {
  name: string;
  display_name: string;
  version: string;
  is_source: boolean;
  is_sink: boolean;
  config_keys: ConfigKeySpec[];
  /** Absent only on servers older than the 0.32 contract. */
  schema_capabilities: SchemaCapabilities | null;
}

export type ProcessRuntime = 'native_rust' | 'remote_rust' | 'remote_python';

/** GET /api/v1/process-functions. Bindings are installed at startup; this route is read-only. */
export interface ProcessFunctionInfo {
  output: string;
  source: string;
  function_id: string;
  pipeline_state_id: string;
  descriptor_version: number;
  implementation_digest: string;
  runtime: ProcessRuntime;
}

export interface ConnectorsResponse {
  sources: ConnectorInfo[];
  sinks: ConnectorInfo[];
}

/** POST /api/v1/sql. Int64/UInt64/Decimal row values are already quoted by the engine. */
export interface SqlResponse {
  result_type: string;
  object_name?: string;
  rows_affected?: WireU64;
  data?: Record<string, unknown>[];
  truncated?: boolean;
  /**
   * Running-cluster SOURCE/STREAM/SINK DDL is admitted as an asynchronous
   * topology migration (HTTP 202). The receipt is not a completed change.
   */
  topology_operation?: TopologyAdmissionStatus;
}

// ---------------------------------------------------------------------------
// Cluster topology migrations (laminar-core cluster::control::topology)

export interface CatalogManifestRef {
  version: number;
  sha256: string;
  encoded_len: WireU64;
  entry_count: number;
}

/** Explicitly adopted legacy inventory; always topology version 1. */
export interface LegacyTopologyBaseline {
  protocol_version: number;
  topology_version: WireU64;
  manifest: CatalogManifestRef;
  deployment_id: string;
  operation_id: string;
  authority_sequence: WireU64;
}

/** Irreversible target catalog decision. It does not authorize output or open intake. */
export interface TopologyCommit {
  protocol_version: number;
  operation_id: string;
  parent_version: WireU64;
  parent_manifest: CatalogManifestRef;
  topology_version: WireU64;
  manifest: CatalogManifestRef;
  authority_sequence: WireU64;
}

export type TopologyCatalogState =
  | { state: 'uninitialized' }
  | { state: 'legacy_sealed'; manifest: CatalogManifestRef }
  | { state: 'versioned'; baseline: LegacyTopologyBaseline; committed: TopologyCommit | null };

/** GET /api/v1/cluster/topology. Activation evidence is for the answering process only. */
export interface ClusterTopologyStatus {
  catalog: TopologyCatalogState;
  committed_version: WireU64 | null;
  /** Version this process runs with live authority and intake released. */
  locally_active_version: WireU64 | null;
  /** Committed migration that still freezes the complete owner map. Do not rescale while set. */
  live_migration: WireU64 | null;
  journal: { retained: number; capacity: number };
}

export const TOPOLOGY_PHASES = [
  'planned', 'preparing', 'quiescing', 'cut_prepared', 'committed', 'activating', 'active',
] as const;
export type TopologyProgressPhase = typeof TOPOLOGY_PHASES[number];
export type TopologyAbortReason = 'requested' | 'leader_changed' | 'recovery' | 'checkpoint_aborted';
export type TopologyAdmissionPhase =
  | { phase: TopologyProgressPhase }
  | { phase: 'aborted'; reason: TopologyAbortReason };

/**
 * Durable status of one payload-bound migration request. Rendered fields are
 * validated; deeper evidence (leader proofs, cut inventory, certificates) is
 * retained losslessly in `raw` for inspection rather than re-modelled here.
 */
export interface TopologyAdmissionStatus {
  operation_id: string;
  plan: { sha256: string; encoded_len: WireU64 };
  admitted_sequence: WireU64;
  status_sequence: WireU64;
  /** Wire field `state` (Rust field `phase`), internally tagged by `phase`. */
  state: TopologyAdmissionPhase;
  commit: TopologyCommit | null;
  /** Installation receipts collected for the current activation round. */
  activation: {
    processes: number;
    installations: number;
    released_sequence: WireU64 | null;
  } | null;
  certificates: number;
  completed_cut_participants: number;
  raw: Record<string, unknown>;
}

export type TopologyObjectTransition = 'preserve' | 'add_future_only' | 'remove';

export interface ClusterTopologyObjectPlan {
  name: string;
  kind: string;
  catalog_generation: WireU64;
  transition: TopologyObjectTransition;
  initialization: string;
  definition_sha256: string;
  compatibility_sha256: string;
  dependencies: string[];
  schema_sha256: string | null;
  managed_state_contract: string | null;
}

/** POST /api/v1/cluster/topology/validate. Certifies only the answering process's local plan. */
export interface ClusterTopologyValidation {
  validation_format_version: number;
  scope: string;
  deployment_id: string;
  parent_version: WireU64;
  target_version: WireU64;
  parent_manifest: CatalogManifestRef;
  target_manifest: CatalogManifestRef;
  environment_sha256: string;
  compatibility_sha256: string;
  statements: string[];
  objects: ClusterTopologyObjectPlan[];
  requires_processing_pause: boolean;
  required_before_activation: string[];
}

export interface ClusterTopologyRequest {
  operation_id: string;
  expected_parent_version: WireU64;
  statements: string[];
}

export interface ClusterTopologyAdoptionRequest {
  operation_id: string;
  expected_manifest: CatalogManifestRef;
  expected_deployment_id: string;
  coordinated_upgrade_complete: boolean;
}

export type CheckpointFailureDisposition = 'retryable' | 'requires_recovery';

export interface CheckpointTriggerResponse {
  success: boolean;
  checkpoint_id: WireU64;
  epoch: WireU64;
  duration_ms: WireU64;
  error?: string;
  failure_disposition?: CheckpointFailureDisposition;
}

/** Exact-JSON Arrow row returned by SHOW CHECKPOINT STATUS. */
export interface CheckpointStatusRow {
  checkpoint_id: WireU64;
  epoch: WireU64;
  timestamp_ms: WireU64;
  sources: string;
  sinks: string;
  completed_this_runtime: WireU64;
}

export interface ReloadOp {
  action: string;
  object_type: string;
  name: string;
}

export interface ReloadFailure extends ReloadOp {
  error: string;
}

export interface ReloadResult {
  success: boolean;
  applied: ReloadOp[];
  failed: ReloadFailure[];
  warnings: string[];
}

export interface GraphNode {
  name: string;
  node_type: 'Source' | 'Stream' | 'Sink';
  sql: string | null;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type NodeState = 'Joining' | 'Active' | 'Suspected' | 'Draining' | 'Left';

export interface NodeMetadata {
  cores: number;
  memory_bytes: WireU64;
  failure_domain: string | null;
  tags: Record<string, string>;
  version: string;
}

export interface NodeInfo {
  id: WireU64;
  name: string;
  rpc_address: string;
  state: NodeState;
  metadata: NodeMetadata;
  last_heartbeat_ms: number;
}

export interface CheckpointParticipant {
  node_id: WireU64;
  boot_incarnation: string;
}

export interface CheckpointAssignmentFence {
  assignment_version: WireU64;
  partitioning_abi_version: number;
  vnode_count: number;
  assignment_digest: number[];
  participants: CheckpointParticipant[];
}

export interface LeaderProof {
  owner: {
    node_id: WireU64;
    boot_id: string;
    process_term: WireU64;
  };
  fencing_token: WireU64;
}

export interface AssignmentDrainTransition {
  predecessor: CheckpointAssignmentFence;
  target: CheckpointAssignmentFence;
  leader: LeaderProof;
}

/** GET /api/v1/cluster/vnodes. Map keys are vnode indices; values are exact node IDs. */
export interface AssignmentSnapshot {
  version: WireU64;
  partitioning_abi_version: number;
  vnodes: Record<string, WireU64>;
  participants: CheckpointParticipant[];
  updated_at_ms: number;
  draining: boolean;
  drain_transition: AssignmentDrainTransition | null;
}

export interface LeaderResponse {
  leader: NodeInfo | null;
  is_leader: boolean;
}

export interface ClusterStatusResponse {
  mode: 'cluster';
  node_id: string;
  pipeline_state: string;
  /** Process-local aggregate health; null only before engine metrics are attached. */
  subscription_output: ClusterSubscriptionOutputHealth | null;
}

export interface ClusterSubscriptionOutputHealth {
  active_readers: WireU64;
  pending_bytes: WireU64;
  retained_bytes: WireU64;
  orphan_bytes: WireU64;
  open_failures: WireU64;
  segment_write_failures: WireU64;
  manifest_failures: WireU64;
  integrity_failures: WireU64;
  stale_writer_rejections: WireU64;
  sequence_gaps: WireU64;
  lag_disconnects: WireU64;
}

export interface PipelineStatusResponse {
  pipeline_state: string;
  last_error?: string;
}

export interface PipelineControlResponse {
  message: string;
}

const BASE_URL_KEY = 'laminardb_baseUrl';
const SESSION_TOKEN_KEY = 'laminardb_token';
const LEGACY_TOKEN_KEY = 'laminardb_token';
const INTEGER_PATTERN = /^-?(?:0|[1-9]\d*)$/;
const U64_MAX = 18_446_744_073_709_551_615n;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export class ApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly body: unknown;
  /** Stable `LDB-xxxx` code from topology write routes (`{error, code}` bodies). */
  readonly code?: string;
  /**
   * Topology operation whose outcome may be uncertain. Read from the
   * `x-laminar-topology-operation-id` header when CORS exposes it, otherwise
   * from the engine's "topology operation <uuid> may be admitted" message.
   */
  readonly operationId?: string;
  /** Seconds from `Retry-After` when the browser can read it (429/504 topology responses). */
  readonly retryAfter?: number;

  constructor(
    status: number,
    statusText: string,
    message: string,
    body?: unknown,
    details: { code?: string; operationId?: string; retryAfter?: number } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.statusText = statusText;
    this.body = body;
    if (details.code) this.code = details.code;
    if (details.operationId) this.operationId = details.operationId;
    if (details.retryAfter !== undefined) this.retryAfter = details.retryAfter;
  }
}

/** True for a canonical lowercase, hyphenated, non-nil UUID (the engine's operation identity). */
export function isOperationUuid(value: string): boolean {
  return UUID_PATTERN.test(value) && value !== NIL_UUID;
}

/**
 * Random v4 UUID for a new topology request. `crypto.randomUUID` exists only in
 * secure contexts, so build it from `getRandomValues`, which consoles served over
 * plain HTTP on a LAN host still have.
 */
export function newOperationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/** Parse engine JSON without rounding an unquoted Rust u64 above 2^53 - 1. */
export function parseEngineJson(text: string): unknown {
  return parseLosslessJson(text, undefined, {
    parseNumber: (raw) => {
      if (INTEGER_PATTERN.test(raw)) {
        const integer = BigInt(raw);
        if (integer > BigInt(Number.MAX_SAFE_INTEGER) || integer < BigInt(Number.MIN_SAFE_INTEGER)) {
          return raw;
        }
      }
      const number = Number(raw);
      return Number.isFinite(number) ? number : raw;
    },
  });
}

export function normalizeBaseUrl(raw: string): string {
  const candidate = raw.trim();
  if (!candidate) throw new Error('LaminarDB API URL is required.');
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('Enter an absolute LaminarDB URL, for example http://localhost:8080.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('LaminarDB API URL must use http:// or https://.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Do not place credentials in the LaminarDB API URL; use the bearer token field.');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('LaminarDB API URL cannot contain a query string or fragment.');
  }
  return parsed.toString().replace(/\/$/, '');
}

function defaultBaseUrl(): string {
  const localOrStatic = ['localhost', '127.0.0.1', 'github.io', 'vercel.app', 'netlify.app']
    .some((host) => window.location.hostname === host || window.location.hostname.endsWith(`.${host}`));
  return localOrStatic ? 'http://localhost:8080' : window.location.origin;
}

export function getConnectionConfig(): ConnectionConfig {
  // Tokens are session-scoped. Migrate the old persistent key once, then remove it.
  let token = sessionStorage.getItem(SESSION_TOKEN_KEY) ?? '';
  const legacyToken = localStorage.getItem(LEGACY_TOKEN_KEY);
  if (!token && legacyToken) {
    token = legacyToken;
    sessionStorage.setItem(SESSION_TOKEN_KEY, token);
  }
  if (legacyToken !== null) localStorage.removeItem(LEGACY_TOKEN_KEY);

  return {
    baseUrl: localStorage.getItem(BASE_URL_KEY) || defaultBaseUrl(),
    token,
  };
}

export function saveConnectionConfig(baseUrl: string, token: string): ConnectionConfig {
  const config = { baseUrl: normalizeBaseUrl(baseUrl), token: token.trim() };
  localStorage.setItem(BASE_URL_KEY, config.baseUrl);
  if (config.token) sessionStorage.setItem(SESSION_TOKEN_KEY, config.token);
  else sessionStorage.removeItem(SESSION_TOKEN_KEY);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  return config;
}

interface RequestOptions extends RequestInit {
  acceptedStatuses?: number[];
  config?: ConnectionConfig;
  authenticated?: boolean;
}

function endpointUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

function errorMessage(status: number, statusText: string, body: unknown, fallbackText: string): string {
  if (isRecord(body) && typeof body.error === 'string') return body.error;
  if (fallbackText && fallbackText.length < 500 && !/<(?:!doctype|html)/i.test(fallbackText)) {
    return fallbackText;
  }
  return `Request failed: ${status} ${statusText}`.trim();
}

async function fetchEndpoint(path: string, options: RequestOptions = {}): Promise<Response> {
  const { authenticated = true, config: suppliedConfig, ...init } = options;
  delete init.acceptedStatuses;
  const config = suppliedConfig ?? getConnectionConfig();
  const headers = new Headers(init.headers);
  if (authenticated && config.token) headers.set('Authorization', `Bearer ${config.token}`);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  return fetch(endpointUrl(config.baseUrl, path), { ...init, headers });
}

async function responseBody(response: Response): Promise<{ value: unknown; text: string }> {
  if (response.status === 204) return { value: {}, text: '' };
  const text = await response.text();
  if (!text) return { value: {}, text };
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('json')) {
    try {
      return { value: parseEngineJson(text), text };
    } catch (cause) {
      throw new ProtocolError(`LaminarDB returned malformed JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  return { value: text, text };
}

const UNCERTAIN_OPERATION_PATTERN = /topology operation ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) may be admitted/;

function errorDetails(response: Response, body: unknown, message: string) {
  const code = isRecord(body) && typeof body.code === 'string' ? body.code : undefined;
  const header = response.headers.get('x-laminar-topology-operation-id')?.trim().toLowerCase();
  const fromMessage = UNCERTAIN_OPERATION_PATTERN.exec(message)?.[1];
  const operationId = header && isOperationUuid(header) ? header : fromMessage;
  const retryHeader = response.headers.get('retry-after');
  const retryAfter = retryHeader && /^\d+$/.test(retryHeader.trim()) ? Number(retryHeader.trim()) : undefined;
  return { code, operationId, retryAfter };
}

async function requestJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetchEndpoint(path, options);
  const body = await responseBody(response);
  if (!response.ok && !(options.acceptedStatuses ?? []).includes(response.status)) {
    const message = errorMessage(response.status, response.statusText, body.value, body.text);
    throw new ApiError(
      response.status,
      response.statusText,
      message,
      body.value,
      errorDetails(response, body.value, message),
    );
  }
  if (typeof body.value === 'string') {
    throw new ProtocolError(`Expected JSON from ${path}, received ${response.headers.get('content-type') || 'plain text'}.`);
  }
  return body.value as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ProtocolError(`${context} is not a JSON object.`);
  return value;
}

function asArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw new ProtocolError(`${context} is not a JSON array.`);
  return value;
}

function textValue(value: unknown, context: string): string {
  if (typeof value !== 'string') throw new ProtocolError(`${context} is not a string.`);
  return value;
}

function booleanValue(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') throw new ProtocolError(`${context} is not a boolean.`);
  return value;
}

function wireU64(value: unknown, context: string): WireU64 {
  if (typeof value === 'string' && /^\d+$/.test(value) && BigInt(value) <= U64_MAX) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new ProtocolError(`${context} is not an exact unsigned integer.`);
}

function finiteNumber(value: unknown, context: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new ProtocolError(`${context} is not a finite number.`);
}

function integerInRange(value: unknown, min: number, max: number, context: string): number {
  const number = finiteNumber(value, context);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new ProtocolError(`${context} is outside the supported integer range.`);
  }
  return number;
}

function normalizeSource(value: unknown): SourceInfo {
  const source = asRecord(value, 'source');
  return {
    name: textValue(source.name, 'source.name'),
    ...(source.watermark_column === undefined
      ? {}
      : { watermark_column: textValue(source.watermark_column, 'source.watermark_column') }),
  };
}

function normalizeSink(value: unknown): SinkInfo {
  const sink = asRecord(value, 'sink');
  return { name: textValue(sink.name, 'sink.name') };
}

function normalizeStream(value: unknown): StreamInfo {
  const stream = asRecord(value, 'stream');
  return {
    name: textValue(stream.name, 'stream.name'),
    ...(stream.sql === undefined ? {} : { sql: textValue(stream.sql, 'stream.sql') }),
  };
}

function normalizeMaterializedView(value: unknown): MaterializedViewInfo {
  const view = asRecord(value, 'materialized view');
  return {
    name: textValue(view.name, 'materialized view.name'),
    sql: textValue(view.sql, 'materialized view.sql'),
    state: textValue(view.state, 'materialized view.state'),
  };
}

function normalizeConfigKey(value: unknown): ConfigKeySpec {
  const key = asRecord(value, 'connector config key');
  if (key.default !== null && typeof key.default !== 'string') {
    throw new ProtocolError('connector config key.default is not a string or null.');
  }
  return {
    key: textValue(key.key, 'connector config key.key'),
    description: textValue(key.description, 'connector config key.description'),
    required: booleanValue(key.required, 'connector config key.required'),
    default: key.default,
  };
}

function enumValue<T extends string>(value: unknown, variants: readonly T[], context: string): T {
  const text = textValue(value, context);
  if (!(variants as readonly string[]).includes(text)) {
    throw new ProtocolError(`${context} '${text}' is not a supported variant.`);
  }
  return text as T;
}

function stringList(value: unknown, context: string): string[] {
  return asArray(value, context).map((item) => textValue(item, `${context} item`));
}

function normalizeSchemaCapabilities(value: unknown): SchemaCapabilities | null {
  if (value === undefined) return null;
  const caps = asRecord(value, 'connector.schema_capabilities');
  return {
    discovery: enumValue(caps.discovery, ['explicit', 'built_in', 'metadata', 'query'] as const, 'schema_capabilities.discovery'),
    metadata_formats: stringList(caps.metadata_formats, 'schema_capabilities.metadata_formats'),
    built_in_formats: stringList(caps.built_in_formats, 'schema_capabilities.built_in_formats'),
    query_derived: booleanValue(caps.query_derived, 'schema_capabilities.query_derived'),
    bounded_sampling: booleanValue(caps.bounded_sampling, 'schema_capabilities.bounded_sampling'),
    preparation: enumValue(
      caps.preparation,
      ['none', 'explicit_table_creation', 'explicit_registration'] as const,
      'schema_capabilities.preparation',
    ),
  };
}

function normalizeConnector(value: unknown): ConnectorInfo {
  const connector = asRecord(value, 'connector');
  return {
    name: textValue(connector.name, 'connector.name'),
    display_name: textValue(connector.display_name, 'connector.display_name'),
    version: textValue(connector.version, 'connector.version'),
    is_source: booleanValue(connector.is_source, 'connector.is_source'),
    is_sink: booleanValue(connector.is_sink, 'connector.is_sink'),
    config_keys: asArray(connector.config_keys, 'connector.config_keys').map(normalizeConfigKey),
    schema_capabilities: normalizeSchemaCapabilities(connector.schema_capabilities),
  };
}

function normalizeProcessFunction(value: unknown): ProcessFunctionInfo {
  const binding = asRecord(value, 'process function');
  return {
    output: textValue(binding.output, 'process function.output'),
    source: textValue(binding.source, 'process function.source'),
    function_id: textValue(binding.function_id, 'process function.function_id'),
    pipeline_state_id: textValue(binding.pipeline_state_id, 'process function.pipeline_state_id'),
    descriptor_version: integerInRange(binding.descriptor_version, 0, 4_294_967_295, 'process function.descriptor_version'),
    implementation_digest: textValue(binding.implementation_digest, 'process function.implementation_digest'),
    runtime: enumValue(binding.runtime, ['native_rust', 'remote_rust', 'remote_python'] as const, 'process function.runtime'),
  };
}

function operationUuid(value: unknown, context: string): string {
  const text = textValue(value, context);
  if (!isOperationUuid(text)) throw new ProtocolError(`${context} is not a non-nil lowercase UUID.`);
  return text;
}

function nullableU64(value: unknown, context: string): WireU64 | null {
  return value === null || value === undefined ? null : wireU64(value, context);
}

function normalizeManifest(value: unknown, context: string): CatalogManifestRef {
  const manifest = asRecord(value, context);
  return {
    version: integerInRange(manifest.version, 0, 65_535, `${context}.version`),
    sha256: textValue(manifest.sha256, `${context}.sha256`),
    encoded_len: wireU64(manifest.encoded_len, `${context}.encoded_len`),
    entry_count: integerInRange(manifest.entry_count, 0, 4_294_967_295, `${context}.entry_count`),
  };
}

function normalizeBaseline(value: unknown): LegacyTopologyBaseline {
  const baseline = asRecord(value, 'topology baseline');
  return {
    protocol_version: integerInRange(baseline.protocol_version, 0, 65_535, 'topology baseline.protocol_version'),
    topology_version: wireU64(baseline.topology_version, 'topology baseline.topology_version'),
    manifest: normalizeManifest(baseline.manifest, 'topology baseline.manifest'),
    deployment_id: textValue(baseline.deployment_id, 'topology baseline.deployment_id'),
    operation_id: operationUuid(baseline.operation_id, 'topology baseline.operation_id'),
    authority_sequence: wireU64(baseline.authority_sequence, 'topology baseline.authority_sequence'),
  };
}

function normalizeTopologyCommit(value: unknown): TopologyCommit {
  const commit = asRecord(value, 'topology commit');
  return {
    protocol_version: integerInRange(commit.protocol_version, 0, 65_535, 'topology commit.protocol_version'),
    operation_id: operationUuid(commit.operation_id, 'topology commit.operation_id'),
    parent_version: wireU64(commit.parent_version, 'topology commit.parent_version'),
    parent_manifest: normalizeManifest(commit.parent_manifest, 'topology commit.parent_manifest'),
    topology_version: wireU64(commit.topology_version, 'topology commit.topology_version'),
    manifest: normalizeManifest(commit.manifest, 'topology commit.manifest'),
    authority_sequence: wireU64(commit.authority_sequence, 'topology commit.authority_sequence'),
  };
}

function normalizeCatalogState(value: unknown): TopologyCatalogState {
  const catalog = asRecord(value, 'topology catalog');
  const state = enumValue(catalog.state, ['uninitialized', 'legacy_sealed', 'versioned'] as const, 'topology catalog.state');
  if (state === 'uninitialized') return { state };
  if (state === 'legacy_sealed') {
    return { state, manifest: normalizeManifest(catalog.manifest, 'topology catalog.manifest') };
  }
  return {
    state,
    baseline: normalizeBaseline(catalog.baseline),
    committed: catalog.committed === undefined || catalog.committed === null
      ? null
      : normalizeTopologyCommit(catalog.committed),
  };
}

export function normalizeTopologyStatus(value: unknown): ClusterTopologyStatus {
  const status = asRecord(value, 'cluster topology status');
  const journal = asRecord(status.journal, 'cluster topology status.journal');
  return {
    catalog: normalizeCatalogState(status.catalog),
    committed_version: nullableU64(status.committed_version, 'cluster topology status.committed_version'),
    locally_active_version: nullableU64(status.locally_active_version, 'cluster topology status.locally_active_version'),
    live_migration: nullableU64(status.live_migration, 'cluster topology status.live_migration'),
    journal: {
      retained: integerInRange(journal.retained, 0, Number.MAX_SAFE_INTEGER, 'topology journal.retained'),
      capacity: integerInRange(journal.capacity, 0, Number.MAX_SAFE_INTEGER, 'topology journal.capacity'),
    },
  };
}

function normalizeAdmissionPhase(value: unknown): TopologyAdmissionPhase {
  const state = asRecord(value, 'topology operation.state');
  const phase = enumValue(state.phase, [...TOPOLOGY_PHASES, 'aborted'] as const, 'topology operation.state.phase');
  if (phase !== 'aborted') return { phase };
  return {
    phase,
    reason: enumValue(
      state.reason,
      ['requested', 'leader_changed', 'recovery', 'checkpoint_aborted'] as const,
      'topology operation.state.reason',
    ),
  };
}

export function normalizeTopologyOperation(value: unknown): TopologyAdmissionStatus {
  const status = asRecord(value, 'topology operation');
  const plan = asRecord(status.plan, 'topology operation.plan');
  let activation: TopologyAdmissionStatus['activation'] = null;
  if (status.activation !== undefined && status.activation !== null) {
    const round = asRecord(status.activation, 'topology operation.activation');
    const release = round.release === undefined || round.release === null
      ? null
      : asRecord(round.release, 'topology operation.activation.release');
    activation = {
      processes: asArray(round.processes, 'topology operation.activation.processes').length,
      installations: asArray(round.installations, 'topology operation.activation.installations').length,
      released_sequence: release === null
        ? null
        : wireU64(release.authority_sequence, 'topology operation.activation.release.authority_sequence'),
    };
  }
  const preparation = status.preparation === undefined || status.preparation === null
    ? null
    : asRecord(status.preparation, 'topology operation.preparation');
  const cut = status.cut === undefined || status.cut === null ? null : asRecord(status.cut, 'topology operation.cut');
  return {
    operation_id: operationUuid(status.operation_id, 'topology operation.operation_id'),
    plan: {
      sha256: textValue(plan.sha256, 'topology operation.plan.sha256'),
      encoded_len: wireU64(plan.encoded_len, 'topology operation.plan.encoded_len'),
    },
    admitted_sequence: wireU64(status.admitted_sequence, 'topology operation.admitted_sequence'),
    status_sequence: wireU64(status.status_sequence, 'topology operation.status_sequence'),
    state: normalizeAdmissionPhase(status.state),
    commit: status.commit === undefined || status.commit === null ? null : normalizeTopologyCommit(status.commit),
    activation,
    certificates: preparation === null
      ? 0
      : asArray(preparation.certificates, 'topology operation.preparation.certificates').length,
    completed_cut_participants: cut === null || cut.completed_participants === undefined
      ? 0
      : asArray(cut.completed_participants, 'topology operation.cut.completed_participants').length,
    raw: status,
  };
}

function normalizeObjectPlan(value: unknown): ClusterTopologyObjectPlan {
  const object = asRecord(value, 'topology object plan');
  const nullableText = (field: unknown, context: string) => field === null || field === undefined
    ? null
    : textValue(field, context);
  return {
    name: textValue(object.name, 'topology object plan.name'),
    kind: textValue(object.kind, 'topology object plan.kind'),
    catalog_generation: wireU64(object.catalog_generation, 'topology object plan.catalog_generation'),
    transition: enumValue(object.transition, ['preserve', 'add_future_only', 'remove'] as const, 'topology object plan.transition'),
    initialization: textValue(object.initialization, 'topology object plan.initialization'),
    definition_sha256: textValue(object.definition_sha256, 'topology object plan.definition_sha256'),
    compatibility_sha256: textValue(object.compatibility_sha256, 'topology object plan.compatibility_sha256'),
    dependencies: stringList(object.dependencies, 'topology object plan.dependencies'),
    schema_sha256: nullableText(object.schema_sha256, 'topology object plan.schema_sha256'),
    managed_state_contract: nullableText(object.managed_state_contract, 'topology object plan.managed_state_contract'),
  };
}

export function normalizeTopologyValidation(value: unknown): ClusterTopologyValidation {
  const validation = asRecord(value, 'topology validation');
  return {
    validation_format_version: integerInRange(validation.validation_format_version, 0, 65_535, 'topology validation.validation_format_version'),
    scope: textValue(validation.scope, 'topology validation.scope'),
    deployment_id: textValue(validation.deployment_id, 'topology validation.deployment_id'),
    parent_version: wireU64(validation.parent_version, 'topology validation.parent_version'),
    target_version: wireU64(validation.target_version, 'topology validation.target_version'),
    parent_manifest: normalizeManifest(validation.parent_manifest, 'topology validation.parent_manifest'),
    target_manifest: normalizeManifest(validation.target_manifest, 'topology validation.target_manifest'),
    environment_sha256: textValue(validation.environment_sha256, 'topology validation.environment_sha256'),
    compatibility_sha256: textValue(validation.compatibility_sha256, 'topology validation.compatibility_sha256'),
    statements: stringList(validation.statements, 'topology validation.statements'),
    objects: asArray(validation.objects, 'topology validation.objects').map(normalizeObjectPlan),
    requires_processing_pause: booleanValue(validation.requires_processing_pause, 'topology validation.requires_processing_pause'),
    required_before_activation: stringList(validation.required_before_activation, 'topology validation.required_before_activation'),
  };
}

/** Serialize a u64 as a bare JSON number without passing through a JavaScript double. */
function u64Literal(value: WireU64, context: string): string {
  return wireU64(value, context);
}

function manifestJson(manifest: CatalogManifestRef): string {
  return `{"version":${manifest.version},"sha256":${JSON.stringify(manifest.sha256)},"encoded_len":${u64Literal(manifest.encoded_len, 'manifest.encoded_len')},"entry_count":${manifest.entry_count}}`;
}

/** Exact `ClusterTopologyRequest` body. The engine denies unknown fields. */
export function topologyRequestBody(request: ClusterTopologyRequest): string {
  if (!isOperationUuid(request.operation_id)) throw new Error('operation_id must be a non-nil lowercase UUID.');
  if (request.statements.length === 0) throw new Error('A topology request needs at least one statement.');
  return `{"operation_id":${JSON.stringify(request.operation_id)},"expected_parent_version":${u64Literal(request.expected_parent_version, 'expected_parent_version')},"statements":${JSON.stringify(request.statements)}}`;
}

/** Exact `TopologyValidationRequest` body. */
export function topologyValidationBody(expectedParentVersion: WireU64, statements: string[]): string {
  return `{"expected_parent_version":${u64Literal(expectedParentVersion, 'expected_parent_version')},"statements":${JSON.stringify(statements)}}`;
}

/** Exact `ClusterTopologyAdoptionRequest` body. */
export function topologyAdoptionBody(request: ClusterTopologyAdoptionRequest): string {
  if (!isOperationUuid(request.operation_id)) throw new Error('operation_id must be a non-nil lowercase UUID.');
  return `{"operation_id":${JSON.stringify(request.operation_id)},"expected_manifest":${manifestJson(request.expected_manifest)},"expected_deployment_id":${JSON.stringify(request.expected_deployment_id)},"coordinated_upgrade_complete":${request.coordinated_upgrade_complete ? 'true' : 'false'}}`;
}

function normalizeConnectors(value: unknown): ConnectorsResponse {
  const connectors = asRecord(value, 'connectors response');
  return {
    sources: asArray(connectors.sources, 'connectors response.sources').map(normalizeConnector),
    sinks: asArray(connectors.sinks, 'connectors response.sinks').map(normalizeConnector),
  };
}

function normalizeParticipant(value: unknown): CheckpointParticipant {
  const participant = asRecord(value, 'checkpoint participant');
  return {
    node_id: wireU64(participant.node_id, 'checkpoint participant.node_id'),
    boot_incarnation: textValue(participant.boot_incarnation, 'checkpoint participant.boot_incarnation'),
  };
}

function normalizeFence(value: unknown): CheckpointAssignmentFence {
  const fence = asRecord(value, 'assignment fence');
  const digest = asArray(fence.assignment_digest, 'assignment fence.assignment_digest')
    .map((byte) => integerInRange(byte, 0, 255, 'assignment digest byte'));
  if (digest.length !== 32) throw new ProtocolError('assignment fence.assignment_digest must contain 32 bytes.');
  return {
    assignment_version: wireU64(fence.assignment_version, 'assignment fence.assignment_version'),
    partitioning_abi_version: integerInRange(fence.partitioning_abi_version, 0, 65_535, 'assignment fence.partitioning_abi_version'),
    vnode_count: integerInRange(fence.vnode_count, 1, 65_535, 'assignment fence.vnode_count'),
    assignment_digest: digest,
    participants: asArray(fence.participants, 'assignment fence.participants').map(normalizeParticipant),
  };
}

function normalizeNode(value: unknown): NodeInfo {
  const node = asRecord(value, 'cluster node');
  const metadata = asRecord(node.metadata, 'cluster node.metadata');
  const tags = Object.fromEntries(
    Object.entries(asRecord(metadata.tags, 'cluster node.metadata.tags'))
      .map(([key, val]) => [key, textValue(val, `cluster node.metadata.tags.${key}`)]),
  );
  const state = textValue(node.state, 'cluster node.state');
  if (!['Joining', 'Active', 'Suspected', 'Draining', 'Left'].includes(state)) {
    throw new ProtocolError(`cluster node.state '${state}' is not a NodeState variant.`);
  }
  return {
    id: wireU64(node.id, 'cluster node.id'),
    name: textValue(node.name, 'cluster node.name'),
    rpc_address: textValue(node.rpc_address, 'cluster node.rpc_address'),
    state: state as NodeState,
    metadata: {
      cores: integerInRange(metadata.cores, 0, 4_294_967_295, 'cluster node.metadata.cores'),
      memory_bytes: wireU64(metadata.memory_bytes, 'cluster node.metadata.memory_bytes'),
      failure_domain: metadata.failure_domain === null
        ? null
        : textValue(metadata.failure_domain, 'cluster node.metadata.failure_domain'),
      tags,
      version: textValue(metadata.version, 'cluster node.metadata.version'),
    },
    last_heartbeat_ms: finiteNumber(node.last_heartbeat_ms, 'cluster node.last_heartbeat_ms'),
  };
}

function normalizeAssignment(value: unknown): AssignmentSnapshot {
  const snapshot = asRecord(value, 'assignment snapshot');
  const rawVnodes = asRecord(snapshot.vnodes, 'assignment snapshot.vnodes');
  const vnodes = Object.fromEntries(
    Object.entries(rawVnodes).map(([vnode, owner]) => {
      if (!/^\d+$/.test(vnode) || BigInt(vnode) > 4_294_967_295n) {
        throw new ProtocolError(`assignment vnode key '${vnode}' is not a u32.`);
      }
      return [vnode, wireU64(owner, `assignment vnode ${vnode}`)];
    }),
  );
  let drainTransition: AssignmentDrainTransition | null = null;
  if (snapshot.drain_transition !== null && snapshot.drain_transition !== undefined) {
    const transition = asRecord(snapshot.drain_transition, 'assignment drain transition');
    const leader = asRecord(transition.leader, 'assignment drain leader');
    const owner = asRecord(leader.owner, 'assignment drain leader owner');
    drainTransition = {
      predecessor: normalizeFence(transition.predecessor),
      target: normalizeFence(transition.target),
      leader: {
        owner: {
          node_id: wireU64(owner.node_id, 'leader owner.node_id'),
          boot_id: textValue(owner.boot_id, 'leader owner.boot_id'),
          process_term: wireU64(owner.process_term, 'leader owner.process_term'),
        },
        fencing_token: wireU64(leader.fencing_token, 'leader.fencing_token'),
      },
    };
  }
  return {
    version: wireU64(snapshot.version, 'assignment snapshot.version'),
    partitioning_abi_version: integerInRange(snapshot.partitioning_abi_version, 0, 65_535, 'assignment snapshot.partitioning_abi_version'),
    vnodes,
    participants: asArray(snapshot.participants, 'assignment snapshot.participants').map(normalizeParticipant),
    updated_at_ms: finiteNumber(snapshot.updated_at_ms, 'assignment snapshot.updated_at_ms'),
    draining: booleanValue(snapshot.draining, 'assignment snapshot.draining'),
    drain_transition: drainTransition,
  };
}

function normalizeCheckpointResult(value: unknown): CheckpointTriggerResponse {
  const result = asRecord(value, 'checkpoint response');
  if (typeof result.success !== 'boolean') {
    throw new ProtocolError('Checkpoint endpoint did not return CheckpointResponse.');
  }
  if (result.error !== undefined && typeof result.error !== 'string') {
    throw new ProtocolError('checkpoint response.error is not a string.');
  }
  if (result.failure_disposition !== undefined
    && result.failure_disposition !== 'retryable'
    && result.failure_disposition !== 'requires_recovery') {
    throw new ProtocolError('checkpoint response.failure_disposition is not a supported variant.');
  }
  return {
    success: result.success,
    checkpoint_id: wireU64(result.checkpoint_id, 'checkpoint response.checkpoint_id'),
    epoch: wireU64(result.epoch, 'checkpoint response.epoch'),
    duration_ms: wireU64(result.duration_ms, 'checkpoint response.duration_ms'),
    ...(typeof result.error === 'string' ? { error: result.error } : {}),
    ...(result.failure_disposition === 'retryable' || result.failure_disposition === 'requires_recovery'
      ? { failure_disposition: result.failure_disposition }
      : {}),
  };
}

function normalizeSqlResponse(value: unknown): SqlResponse {
  const result = asRecord(value, 'SQL response');
  const resultType = textValue(result.result_type, 'SQL response.result_type');
  if (result.object_name !== undefined && typeof result.object_name !== 'string') {
    throw new ProtocolError('SQL response.object_name is not a string.');
  }
  const data = result.data === undefined
    ? undefined
    : asArray(result.data, 'SQL response.data').map((row) => asRecord(row, 'SQL response row'));
  if (result.truncated !== undefined && typeof result.truncated !== 'boolean') {
    throw new ProtocolError('SQL response.truncated is not a boolean.');
  }
  return {
    result_type: resultType,
    ...(typeof result.object_name === 'string' ? { object_name: result.object_name } : {}),
    ...(result.rows_affected !== undefined
      ? { rows_affected: wireU64(result.rows_affected, 'SQL response.rows_affected') }
      : {}),
    ...(data === undefined ? {} : { data }),
    ...(result.truncated === true ? { truncated: true } : {}),
    ...(result.topology_operation === undefined || result.topology_operation === null
      ? {}
      : { topology_operation: normalizeTopologyOperation(result.topology_operation) }),
  };
}

function normalizeGraph(value: unknown): GraphResponse {
  const graph = asRecord(value, 'graph response');
  return {
    nodes: asArray(graph.nodes, 'graph response.nodes').map((value) => {
      const node = asRecord(value, 'graph node');
      const nodeType = textValue(node.node_type, 'graph node.node_type');
      if (!['Source', 'Stream', 'Sink'].includes(nodeType)) {
        throw new ProtocolError(`graph node.node_type '${nodeType}' is not supported.`);
      }
      if (node.sql !== null && typeof node.sql !== 'string') {
        throw new ProtocolError('graph node.sql is not a string or null.');
      }
      return {
        name: textValue(node.name, 'graph node.name'),
        node_type: nodeType as GraphNode['node_type'],
        sql: node.sql,
      };
    }),
    edges: asArray(graph.edges, 'graph response.edges').map((value) => {
      const edge = asRecord(value, 'graph edge');
      return {
        from: textValue(edge.from, 'graph edge.from'),
        to: textValue(edge.to, 'graph edge.to'),
      };
    }),
  };
}

function normalizePipelineStatus(value: unknown): PipelineStatusResponse {
  const status = asRecord(value, 'pipeline status');
  return {
    pipeline_state: textValue(status.pipeline_state, 'pipeline status.pipeline_state'),
    ...(status.last_error === undefined
      ? {}
      : { last_error: textValue(status.last_error, 'pipeline status.last_error') }),
  };
}

function normalizePipelineControl(value: unknown): PipelineControlResponse {
  const result = asRecord(value, 'pipeline control response');
  return { message: textValue(result.message, 'pipeline control response.message') };
}

function normalizeReloadOp(value: unknown, context: string): ReloadOp {
  const operation = asRecord(value, context);
  return {
    action: textValue(operation.action, `${context}.action`),
    object_type: textValue(operation.object_type, `${context}.object_type`),
    name: textValue(operation.name, `${context}.name`),
  };
}

function normalizeReloadResult(value: unknown): ReloadResult {
  const result = asRecord(value, 'reload response');
  return {
    success: booleanValue(result.success, 'reload response.success'),
    applied: asArray(result.applied, 'reload response.applied')
      .map((operation) => normalizeReloadOp(operation, 'reload applied operation')),
    failed: asArray(result.failed, 'reload response.failed').map((value) => {
      const operation = asRecord(value, 'reload failed operation');
      return {
        ...normalizeReloadOp(operation, 'reload failed operation'),
        error: textValue(operation.error, 'reload failed operation.error'),
      };
    }),
    warnings: asArray(result.warnings, 'reload response.warnings')
      .map((warning) => textValue(warning, 'reload response warning')),
  };
}

function normalizeHealth(value: unknown, context: string): HealthResponse {
  const health = asRecord(value, context);
  return {
    status: textValue(health.status, `${context}.status`),
    version: textValue(health.version, `${context}.version`),
    pipeline_state: textValue(health.pipeline_state, `${context}.pipeline_state`),
  };
}

async function checkHealthWith(config?: ConnectionConfig): Promise<{ health: HealthResponse; httpStatus: number }> {
  const response = await fetchEndpoint('/health', { authenticated: false, config });
  const body = await responseBody(response);
  let health: HealthResponse;
  try {
    health = normalizeHealth(body.value, 'health response');
  } catch (error) {
    if (!response.ok) {
      throw new ApiError(response.status, response.statusText, errorMessage(response.status, response.statusText, body.value, body.text), body.value);
    }
    throw error;
  }
  // 503 is the documented liveness result for an explicitly Stopped pipeline.
  if (!response.ok && response.status !== 503) {
    throw new ApiError(response.status, response.statusText, errorMessage(response.status, response.statusText, body.value, body.text), body.value);
  }
  return { health, httpStatus: response.status };
}

async function checkReadyWith(config?: ConnectionConfig): Promise<ReadinessProbe> {
  const response = await fetchEndpoint('/ready', { authenticated: false, config });
  const body = await responseBody(response);
  if (response.ok) {
    const health = normalizeHealth(body.value, 'readiness response');
    return { ready: true, http_status: response.status, health };
  }
  if (response.status === 503) {
    return {
      ready: false,
      http_status: response.status,
      error: errorMessage(response.status, response.statusText, body.value, body.text),
    };
  }
  throw new ApiError(response.status, response.statusText, errorMessage(response.status, response.statusText, body.value, body.text), body.value);
}

export const api = {
  async checkHealth(): Promise<HealthResponse> {
    return (await checkHealthWith()).health;
  },

  async checkReady(): Promise<ReadinessProbe> {
    return checkReadyWith();
  },

  async probeConnection(config: ConnectionConfig): Promise<ConnectionProbe> {
    const normalized = { baseUrl: normalizeBaseUrl(config.baseUrl), token: config.token.trim() };
    const [{ health, httpStatus }, readiness] = await Promise.all([
      checkHealthWith(normalized),
      checkReadyWith(normalized),
    ]);
    try {
      const pipeline = normalizePipelineStatus(
        await requestJson<unknown>('/api/v1/pipeline/status', { config: normalized }),
      );
      return {
        health,
        health_http_status: httpStatus,
        readiness,
        pipeline,
        control_plane_authenticated: true,
      };
    } catch (error) {
      // The startup gate wraps the console router and can return 503 before the
      // bearer middleware runs, so authentication cannot yet be established.
      if (error instanceof ApiError && error.status === 503) {
        return {
          health,
          health_http_status: httpStatus,
          readiness,
          pipeline: null,
          control_plane_authenticated: null,
        };
      }
      throw error;
    }
  },

  async listSources(): Promise<SourceInfo[]> {
    return asArray(await requestJson<unknown>('/api/v1/sources'), 'sources response').map(normalizeSource);
  },

  async listSinks(): Promise<SinkInfo[]> {
    return asArray(await requestJson<unknown>('/api/v1/sinks'), 'sinks response').map(normalizeSink);
  },

  async listStreams(): Promise<StreamInfo[]> {
    return asArray(await requestJson<unknown>('/api/v1/streams'), 'streams response').map(normalizeStream);
  },

  async getStream(name: string): Promise<StreamInfo> {
    return normalizeStream(await requestJson<unknown>(`/api/v1/streams/${encodeURIComponent(name)}`));
  },

  async listMvs(): Promise<MaterializedViewInfo[]> {
    return asArray(await requestJson<unknown>('/api/v1/mvs'), 'materialized views response')
      .map(normalizeMaterializedView);
  },

  async listConnectors(): Promise<ConnectorsResponse> {
    return normalizeConnectors(await requestJson<unknown>('/api/v1/connectors'));
  },

  async listProcessFunctions(): Promise<ProcessFunctionInfo[]> {
    return asArray(await requestJson<unknown>('/api/v1/process-functions'), 'process functions response')
      .map(normalizeProcessFunction);
  },

  async executeSql(sql: string): Promise<SqlResponse> {
    const value = await requestJson<unknown>('/api/v1/sql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql }),
    });
    return normalizeSqlResponse(value);
  },

  async triggerCheckpoint(): Promise<CheckpointTriggerResponse> {
    const value = await requestJson<unknown>('/api/v1/checkpoint', {
      method: 'POST',
      // Unsuccessful CheckpointResult values intentionally use HTTP 500 but
      // still carry failure_disposition, epoch and ID needed by operators.
      acceptedStatuses: [500],
    });
    if (isRecord(value) && typeof value.success !== 'boolean') {
      throw new ApiError(500, 'Internal Server Error', errorMessage(500, 'Internal Server Error', value, ''), value);
    }
    return normalizeCheckpointResult(value);
  },

  async reloadConfig(): Promise<ReloadResult> {
    return normalizeReloadResult(await requestJson<unknown>('/api/v1/reload', {
      method: 'POST',
      acceptedStatuses: [207],
    }));
  },

  async getMetricsRaw(): Promise<string> {
    const response = await fetchEndpoint('/metrics', { authenticated: false, headers: { Accept: 'text/plain' } });
    const text = await response.text();
    if (!response.ok) {
      throw new ApiError(response.status, response.statusText, `Metrics request failed: ${response.status} ${response.statusText}`);
    }
    return text;
  },

  async getLineageGraph(): Promise<GraphResponse> {
    return normalizeGraph(await requestJson<unknown>('/api/v1/graph'));
  },

  async getClusterStatus(): Promise<ClusterStatusResponse> {
    const status = asRecord(await requestJson<unknown>('/api/v1/cluster'), 'cluster status response');
    if (status.mode !== 'cluster') throw new ProtocolError("cluster status response.mode is not 'cluster'.");
    const output = status.subscription_output === null
      ? null
      : asRecord(status.subscription_output, 'cluster status response.subscription_output');
    return {
      mode: status.mode,
      node_id: textValue(status.node_id, 'cluster status response.node_id'),
      pipeline_state: textValue(status.pipeline_state, 'cluster status response.pipeline_state'),
      subscription_output: output === null ? null : {
        active_readers: wireU64(output.active_readers, 'cluster subscription output.active_readers'),
        pending_bytes: wireU64(output.pending_bytes, 'cluster subscription output.pending_bytes'),
        retained_bytes: wireU64(output.retained_bytes, 'cluster subscription output.retained_bytes'),
        orphan_bytes: wireU64(output.orphan_bytes, 'cluster subscription output.orphan_bytes'),
        open_failures: wireU64(output.open_failures, 'cluster subscription output.open_failures'),
        segment_write_failures: wireU64(output.segment_write_failures, 'cluster subscription output.segment_write_failures'),
        manifest_failures: wireU64(output.manifest_failures, 'cluster subscription output.manifest_failures'),
        integrity_failures: wireU64(output.integrity_failures, 'cluster subscription output.integrity_failures'),
        stale_writer_rejections: wireU64(output.stale_writer_rejections, 'cluster subscription output.stale_writer_rejections'),
        sequence_gaps: wireU64(output.sequence_gaps, 'cluster subscription output.sequence_gaps'),
        lag_disconnects: wireU64(output.lag_disconnects, 'cluster subscription output.lag_disconnects'),
      },
    };
  },

  async getClusterNodes(): Promise<NodeInfo[]> {
    return asArray(await requestJson<unknown>('/api/v1/cluster/nodes'), 'cluster nodes response')
      .map(normalizeNode);
  },

  async getClusterVnodes(): Promise<AssignmentSnapshot> {
    return normalizeAssignment(await requestJson<unknown>('/api/v1/cluster/vnodes'));
  },

  async getClusterLeader(): Promise<LeaderResponse> {
    const raw = asRecord(await requestJson<unknown>('/api/v1/cluster/leader'), 'leader response');
    return {
      leader: raw.leader === null ? null : normalizeNode(raw.leader),
      is_leader: booleanValue(raw.is_leader, 'leader response.is_leader'),
    };
  },

  async getClusterCheckpoints(): Promise<CheckpointStatusRow[]> {
    const rows = asArray(await requestJson<unknown>('/api/v1/cluster/checkpoints'), 'checkpoint status response');
    return rows.map((value) => {
      const row = asRecord(value, 'checkpoint status row');
      return {
        checkpoint_id: wireU64(row.checkpoint_id, 'checkpoint status.checkpoint_id'),
        epoch: wireU64(row.epoch, 'checkpoint status.epoch'),
        timestamp_ms: wireU64(row.timestamp_ms, 'checkpoint status.timestamp_ms'),
        sources: textValue(row.sources, 'checkpoint status.sources'),
        sinks: textValue(row.sinks, 'checkpoint status.sinks'),
        completed_this_runtime: wireU64(row.completed_this_runtime, 'checkpoint status.completed_this_runtime'),
      };
    });
  },

  /** 404 means a single-node server (or a build without the cluster feature). */
  async getClusterTopology(): Promise<ClusterTopologyStatus> {
    return normalizeTopologyStatus(await requestJson<unknown>('/api/v1/cluster/topology'));
  },

  /** Effect-free; certifies only the answering process's local candidate plan. */
  async validateClusterTopology(expectedParentVersion: WireU64, statements: string[]): Promise<ClusterTopologyValidation> {
    return normalizeTopologyValidation(await requestJson<unknown>('/api/v1/cluster/topology/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: topologyValidationBody(expectedParentVersion, statements),
    }));
  },

  /**
   * Durable admission (HTTP 202). Followers forward to the leader. After a
   * 503/504 the outcome is uncertain: read the operation and retry with the
   * same identity and payload, never a fresh UUID.
   */
  async submitClusterTopology(request: ClusterTopologyRequest): Promise<TopologyAdmissionStatus> {
    return normalizeTopologyOperation(await requestJson<unknown>('/api/v1/cluster/topology/operations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: topologyRequestBody(request),
    }));
  },

  async getClusterTopologyOperation(operationId: string): Promise<TopologyAdmissionStatus> {
    if (!isOperationUuid(operationId)) throw new Error('Operation ID must be a non-nil lowercase UUID.');
    return normalizeTopologyOperation(
      await requestJson<unknown>(`/api/v1/cluster/topology/operations/${encodeURIComponent(operationId)}`),
    );
  },

  async adoptClusterTopology(request: ClusterTopologyAdoptionRequest): Promise<LegacyTopologyBaseline> {
    return normalizeBaseline(await requestJson<unknown>('/api/v1/cluster/topology/adopt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: topologyAdoptionBody(request),
    }));
  },

  async stopPipeline(local = false): Promise<PipelineControlResponse> {
    return normalizePipelineControl(
      await requestJson<unknown>(`/api/v1/pipeline/stop${local ? '?local=true' : ''}`, { method: 'POST' }),
    );
  },

  async startPipeline(local = false): Promise<PipelineControlResponse> {
    return normalizePipelineControl(
      await requestJson<unknown>(`/api/v1/pipeline/start${local ? '?local=true' : ''}`, { method: 'POST' }),
    );
  },

  async getPipelineStatus(): Promise<PipelineStatusResponse> {
    return normalizePipelineStatus(await requestJson<unknown>('/api/v1/pipeline/status'));
  },

  /** Build the only WebSocket endpoint supported by the pinned server. */
  getSubscriptionUrl(name: string, asOfEpoch?: WireU64): string {
    const target = name.trim();
    if (!target || new TextEncoder().encode(target).length > 1024) {
      throw new Error('Subscription target must contain 1–1024 UTF-8 bytes.');
    }
    if (asOfEpoch !== undefined && (!/^\d+$/.test(asOfEpoch) || BigInt(asOfEpoch) > U64_MAX)) {
      throw new Error('AS OF epoch must be within the LaminarDB u64 range.');
    }
    const { baseUrl, token } = getConnectionConfig();
    const url = new URL(baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const prefix = url.pathname.replace(/\/$/, '');
    url.pathname = `${prefix}/ws/${encodeURIComponent(target)}`;
    url.search = '';
    url.hash = '';
    if (token) url.searchParams.set('token', token);
    if (asOfEpoch !== undefined) url.searchParams.set('as_of_epoch', asOfEpoch);
    return url.toString();
  },
};
