import { useCallback, useEffect, useState } from 'react';
import {
  Activity, AlertCircle, Database, Gauge, GitBranch, Lock, Network, Plug, Server, Settings, Zap,
} from 'lucide-react';
import { api, getConnectionConfig, saveConnectionConfig } from './api';
import type { ConnectionProbe } from './api';
import { ENGINE_CONTRACT, ENGINE_CONTRACT_SHORT_SHA } from './contract';
import OverviewTab from './components/OverviewTab';
import CatalogTab from './components/CatalogTab';
import WorksheetTab from './components/WorksheetTab';
import CheckpointsTab from './components/CheckpointsTab';
import MetricsTab from './components/MetricsTab';
import LineageTab from './components/LineageTab';
import TopologyTab from './components/TopologyTab';
import ConnectorsTab from './components/ConnectorsTab';
import logoUrl from './assets/brand/laminardb-logo.svg';
import markUrl from './assets/brand/laminardb-mark.svg';
import './App.css';

type TabKey = 'overview' | 'topology' | 'catalog' | 'connectors' | 'worksheet' | 'checkpoints' | 'metrics' | 'lineage';
type ConnectionStatus = 'connected' | 'degraded' | 'disconnected' | 'checking';

const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: 'overview', label: 'Overview', icon: <Server size={16} aria-hidden="true" /> },
  { key: 'topology', label: 'Topology', icon: <Network size={16} aria-hidden="true" /> },
  { key: 'catalog', label: 'Catalog', icon: <Database size={16} aria-hidden="true" /> },
  { key: 'connectors', label: 'Connectors & CDC', icon: <Plug size={16} aria-hidden="true" /> },
  { key: 'worksheet', label: 'SQL worksheet', icon: <Zap size={16} aria-hidden="true" /> },
  { key: 'checkpoints', label: 'Checkpoints & state', icon: <Activity size={16} aria-hidden="true" /> },
  { key: 'metrics', label: 'Metrics', icon: <Gauge size={16} aria-hidden="true" /> },
  { key: 'lineage', label: 'Lineage', icon: <GitBranch size={16} aria-hidden="true" /> },
];

function statusFromProbe(probe: ConnectionProbe): ConnectionStatus {
  return probe.readiness.ready && probe.control_plane_authenticated === true ? 'connected' : 'degraded';
}

function probeSummary(probe: ConnectionProbe | null, status: ConnectionStatus): string {
  if (status === 'checking') return 'Checking connection';
  if (status === 'disconnected') return 'Disconnected';
  if (!probe) return status === 'connected' ? 'Connected' : 'Reachable, not ready';
  if (probe.readiness.ready) return 'Connected and ready';
  if (probe.control_plane_authenticated === null) return 'Reachable; control plane still starting';
  return `Reachable; pipeline ${probe.health.pipeline_state}`;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('checking');
  const [connectionError, setConnectionError] = useState('');
  const [probe, setProbe] = useState<ConnectionProbe | null>(null);

  const verifyConnection = useCallback(async (
    url: string,
    accessToken: string,
    options: { persist: boolean; announceChecking: boolean },
  ): Promise<boolean> => {
    if (options.announceChecking) setConnectionStatus('checking');
    setConnectionError('');
    try {
      const nextProbe = await api.probeConnection({ baseUrl: url, token: accessToken });
      const config = options.persist ? saveConnectionConfig(url, accessToken) : { baseUrl: url, token: accessToken };
      setBaseUrl(config.baseUrl);
      setToken(config.token);
      setProbe(nextProbe);
      setConnectionStatus(statusFromProbe(nextProbe));
      return true;
    } catch (error) {
      if (options.announceChecking) setProbe(null);
      setConnectionStatus('disconnected');
      setConnectionError(error instanceof Error ? error.message : 'Could not reach LaminarDB.');
      if (options.announceChecking) setShowSettings(true);
      return false;
    }
  }, []);

  useEffect(() => {
    const config = getConnectionConfig();
    setBaseUrl(config.baseUrl);
    setToken(config.token);
    void verifyConnection(config.baseUrl, config.token, { persist: false, announceChecking: true });
  }, [verifyConnection]);

  useEffect(() => {
    if (!probe && connectionStatus !== 'connected' && connectionStatus !== 'degraded') return;
    const interval = window.setInterval(() => {
      const config = getConnectionConfig();
      void verifyConnection(config.baseUrl, config.token, { persist: false, announceChecking: false });
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [connectionStatus, probe, verifyConnection]);

  const handleSaveSettings = async (event: React.FormEvent) => {
    event.preventDefault();
    const connected = await verifyConnection(baseUrl, token, { persist: true, announceChecking: true });
    if (connected) setShowSettings(false);
  };

  const usable = probe !== null || connectionStatus === 'connected' || connectionStatus === 'degraded';
  const versionMismatch = Boolean(probe?.health.version && probe.health.version !== ENGINE_CONTRACT.version);

  return (
    <div className="app-container">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <header className="header">
        <div className="brand">
          <img className="brand-lockup" src={logoUrl} alt="LaminarDB" width={128} height={22} />
          <img className="brand-mark" src={markUrl} alt="LaminarDB" width={23} height={22} />
          <span className="brand-product">Console</span>
        </div>

        <div className="header-controls">
          <div className="connection-config-bar" role="status" aria-live="polite">
            <span className={`pulse-dot ${connectionStatus === 'connected' ? 'success' : connectionStatus === 'degraded' || connectionStatus === 'checking' ? 'warning' : 'error'}`} aria-hidden="true" />
            <span className="connection-summary">
              <strong>{probeSummary(probe, connectionStatus)}</strong>
              {usable && <span>{baseUrl}{probe?.health.version ? ` · v${probe.health.version}` : ''}</span>}
            </span>
            <button
              className="icon-button settings-button"
              type="button"
              onClick={() => setShowSettings((shown) => !shown)}
              aria-label="Connection settings"
              aria-expanded={showSettings}
              aria-controls="connection-settings"
              title="Connection settings"
            >
              <Settings size={16} aria-hidden="true" />
            </button>
          </div>

          <nav className="nav-tabs" aria-label="Console sections" tabIndex={usable ? undefined : 0}>
            {TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                className={`nav-tab ${activeTab === tab.key ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.key)}
                aria-current={activeTab === tab.key ? 'page' : undefined}
                disabled={!usable}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            ))}
          </nav>
        </div>
      </header>

      {showSettings && (
        <form id="connection-settings" className="connection-settings" onSubmit={(event) => void handleSaveSettings(event)}>
          <div className="settings-fields">
            <div className="field-group">
              <label htmlFor="server-url">LaminarDB API URL</label>
              <input
                id="server-url"
                type="url"
                className="input-field"
                placeholder="http://localhost:8080"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                autoComplete="url"
                required
              />
            </div>
            <div className="field-group">
              <label htmlFor="console-token">Console bearer token <span className="optional-label">optional when server auth is disabled</span></label>
              <div className="input-with-icon">
                <Lock size={14} aria-hidden="true" />
                <input
                  id="console-token"
                  type="password"
                  className="input-field"
                  placeholder="Bearer token"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  autoComplete="off"
                />
              </div>
              <span className="field-help">The token is kept in session storage, not persistent local storage. WebSocket auth uses the server-defined query-token boundary.</span>
            </div>
          </div>
          <div className="settings-actions">
            <button className="btn btn-secondary" type="button" onClick={() => setShowSettings(false)}>Cancel</button>
            <button className="btn btn-primary" type="submit" disabled={connectionStatus === 'checking'}>
              {connectionStatus === 'checking' ? 'Checking…' : 'Connect'}
            </button>
          </div>
          <div className="contract-pin">
            Console contract: LaminarDB {ENGINE_CONTRACT.version} at <code>{ENGINE_CONTRACT_SHORT_SHA}</code> ({ENGINE_CONTRACT.branch}), reviewed {ENGINE_CONTRACT.reviewedOn}.
          </div>
          {connectionError && (
            <div className="notice notice-error settings-error" role="alert">
              <AlertCircle size={16} aria-hidden="true" />
              <span>Connection failed: {connectionError}</span>
            </div>
          )}
        </form>
      )}

      {usable && (versionMismatch || connectionStatus === 'degraded' || connectionStatus === 'disconnected') && (
        <div className={`compatibility-banner ${versionMismatch ? 'compatibility-warning' : ''}`} role="status">
          <AlertCircle size={15} aria-hidden="true" />
          <span>
            {connectionStatus === 'disconnected'
              ? `Connection lost${connectionError ? `: ${connectionError}` : '.'} The console is retaining the last successful state and will retry every 15 seconds.`
              : versionMismatch
              ? `This console was reviewed against LaminarDB ${ENGINE_CONTRACT.version} (${ENGINE_CONTRACT_SHORT_SHA}); the connected server reports ${probe?.health.version}. Protocol compatibility is not guaranteed.`
              : `Server is reachable but not ready${probe?.readiness.error ? `: ${probe.readiness.error}` : '.'}`}
          </span>
        </div>
      )}

      <main id="main-content" className="main-content" tabIndex={-1}>
        {!usable ? (
          <div className="connection-empty-state">
            <div className="glass-card connection-card">
              <img className="connection-mark" src={markUrl} alt="" width={48} height={45} />
              <h1>LaminarDB Console</h1>
              <p>Connect to a LaminarDB server you run to browse its catalog, execute SQL, and follow checkpoints, metrics and lineage on a single node or a cluster.</p>
              {connectionStatus === 'checking' ? (
                <span className="checking-label"><span className="pulse-dot warning" aria-hidden="true" /> Checking the server and protected control plane…</span>
              ) : (
                <button className="btn btn-primary" type="button" onClick={() => setShowSettings(true)}>Configure connection</button>
              )}
            </div>
          </div>
        ) : (
          <div className="tab-host">
            {activeTab === 'overview' && <OverviewTab />}
            {activeTab === 'topology' && <TopologyTab />}
            {activeTab === 'catalog' && <CatalogTab />}
            {activeTab === 'connectors' && <ConnectorsTab />}
            {activeTab === 'worksheet' && <WorksheetTab />}
            {activeTab === 'checkpoints' && <CheckpointsTab />}
            {activeTab === 'metrics' && <MetricsTab />}
            {activeTab === 'lineage' && <LineageTab />}
          </div>
        )}
      </main>
    </div>
  );
}
