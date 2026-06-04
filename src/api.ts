// LaminarDB Console API Client

export interface ConnectionConfig {
  baseUrl: string;
  token: string;
}

export interface SourceInfo {
  name: string;
}

export interface SinkInfo {
  name: string;
}

export interface StreamInfo {
  name: string;
  sql: string;
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
  default?: string;
}

export interface ConnectorInfo {
  name: string;
  display_name: string;
  version: string;
  is_source: boolean;
  is_sink: boolean;
  config_keys: ConfigKeySpec[];
}

export interface ConnectorsResponse {
  sources: ConnectorInfo[];
  sinks: ConnectorInfo[];
}

export interface SqlResponse {
  data?: Record<string, any>[];
  message?: string;
}

export interface QueryCreateRequest {
  sql: string;
}

export interface QueryCreateResponse {
  stream_id: string;
  ws_url: string;
}

export interface GraphNode {
  name: string;
  node_type: 'Source' | 'Stream' | 'Sink';
  sql: string;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface NodeMetadata {
  cpu_cores: number;
  memory_bytes: number;
}

export interface NodeInfo {
  id: number;
  name: string;
  rpc_address: string;
  raft_address: string;
  state: 'Active' | 'Suspected' | 'Joined' | 'Left';
  metadata: NodeMetadata;
  last_heartbeat_ms: number;
}

export interface AssignmentSnapshot {
  version: number;
  vnodes: Record<number, number>; // vnode index -> node ID
  updated_at_ms: number;
}

export interface LeaderResponse {
  leader: NodeInfo | null;
  is_leader: boolean;
}

export function getConnectionConfig(): ConnectionConfig {
  const defaultUrl = window.location.origin.includes('localhost') || window.location.origin.includes('127.0.0.1')
    ? 'http://localhost:8000'
    : window.location.origin;

  return {
    baseUrl: localStorage.getItem('laminardb_baseUrl') || defaultUrl,
    token: localStorage.getItem('laminardb_token') || '',
  };
}

export function saveConnectionConfig(baseUrl: string, token: string) {
  localStorage.setItem('laminardb_baseUrl', baseUrl);
  localStorage.setItem('laminardb_token', token);
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const { baseUrl, token } = getConnectionConfig();
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;

  const headers = new Headers(options.headers || {});
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  headers.set('Accept', 'application/json');

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const text = await response.text();
    let errMsg = `Request failed: ${response.status} ${response.statusText}`;
    try {
      const parsed = JSON.parse(text);
      if (parsed.message) errMsg = parsed.message;
      else if (parsed.error) errMsg = parsed.error;
    } catch {
      if (text) errMsg = text;
    }
    throw new Error(errMsg);
  }

  // Handle empty or 204 responses
  if (response.status === 204) {
    return {} as T;
  }

  return response.json() as Promise<T>;
}

export const api = {
  // Public
  async checkHealth(): Promise<{ status: string }> {
    return request<{ status: string }>('/health');
  },

  async checkReady(): Promise<{ status: string }> {
    return request<{ status: string }>('/ready');
  },

  // Sources & Sinks & Streams
  async listSources(): Promise<SourceInfo[]> {
    return request<SourceInfo[]>('/api/v1/sources');
  },

  async listSinks(): Promise<SinkInfo[]> {
    return request<SinkInfo[]>('/api/v1/sinks');
  },

  async listStreams(): Promise<StreamInfo[]> {
    return request<StreamInfo[]>('/api/v1/streams');
  },

  async listMvs(): Promise<MaterializedViewInfo[]> {
    return request<MaterializedViewInfo[]>('/api/v1/mvs');
  },

  async listConnectors(): Promise<ConnectorsResponse> {
    return request<ConnectorsResponse>('/api/v1/connectors');
  },

  // SQL Execution
  async executeSql(sql: string): Promise<SqlResponse> {
    return request<SqlResponse>('/api/v1/sql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql }),
    });
  },

  // Ad-hoc Query Creation (G1)
  async createQuery(sql: string): Promise<QueryCreateResponse> {
    return request<QueryCreateResponse>('/api/v1/queries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql }),
    });
  },

  // Checkpoint & Reload
  async triggerCheckpoint(): Promise<{ message: string }> {
    return request<{ message: string }>('/api/v1/checkpoint', {
      method: 'POST',
    });
  },

  async reloadConfig(): Promise<{ message: string }> {
    return request<{ message: string }>('/api/v1/reload', {
      method: 'POST',
    });
  },

  async getMetricsRaw(): Promise<string> {
    const { baseUrl } = getConnectionConfig();
    const url = `${baseUrl.replace(/\/$/, '')}/metrics`;
    const response = await fetch(url);
    if (!response.ok) throw new Error("Failed to fetch metrics");
    return response.text();
  },

  // Lineage Graph
  async getLineageGraph(): Promise<GraphResponse> {
    return request<GraphResponse>('/api/v1/graph');
  },

  // Cluster Endpoints
  async getClusterNodes(): Promise<NodeInfo[]> {
    return request<NodeInfo[]>('/api/v1/cluster/nodes');
  },

  async getClusterVnodes(): Promise<AssignmentSnapshot> {
    return request<AssignmentSnapshot>('/api/v1/cluster/vnodes');
  },

  async getClusterLeader(): Promise<LeaderResponse> {
    return request<LeaderResponse>('/api/v1/cluster/leader');
  },

  async getClusterCheckpoints(): Promise<Record<string, any>[]> {
    return request<Record<string, any>[]>('/api/v1/cluster/checkpoints');
  },

  // Pipeline Control
  async stopPipeline(): Promise<{ message: string }> {
    return request<{ message: string }>('/api/v1/pipeline/stop', {
      method: 'POST',
    });
  },

  async startPipeline(): Promise<{ message: string }> {
    return request<{ message: string }>('/api/v1/pipeline/start', {
      method: 'POST',
    });
  },

  async getPipelineStatus(): Promise<{ pipeline_state: string }> {
    return request<{ pipeline_state: string }>('/api/v1/pipeline/status');
  },

  // WebSocket Connection Helper
  getWebSocketUrl(wsPath: string): string {
    const { baseUrl, token } = getConnectionConfig();
    const wsProto = baseUrl.startsWith('https') ? 'wss' : 'ws';
    const cleanBase = baseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const cleanPath = wsPath.startsWith('/') ? wsPath : `/${wsPath}`;
    
    // Add token query parameter since WS client cannot set Authorization header
    const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : '';
    return `${wsProto}://${cleanBase}${cleanPath}${tokenQuery}`;
  }
};
