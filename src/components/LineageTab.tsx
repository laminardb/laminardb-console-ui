import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, HelpCircle, Network, RefreshCw } from 'lucide-react';
import { api } from '../api';
import type { GraphEdge, GraphNode } from '../api';
import { isSensitiveOptionKey, redactSqlSecrets } from '../sqlDisplay';

// Extract the connector name a Source ingests FROM / a Sink emits INTO.
const getConnectorName = (node: GraphNode): string | null => {
  if (!node.sql) return null;
  if (node.node_type === 'Source') {
    const m = node.sql.match(/\bFROM\s+([A-Za-z_]\w*)/i);
    return m ? m[1].toUpperCase() : null;
  }
  if (node.node_type === 'Sink') {
    const m = node.sql.match(/\bINTO\s+([A-Za-z_]\w*)/i);
    return m ? m[1].toUpperCase() : null;
  }
  return null;
};

// Parse the `WITH ('key' = 'value', ...)` / connector options block from DDL.
const parseRelationConfig = (sql?: string | null): { key: string; value: string; hidden: boolean }[] => {
  if (!sql) return [];
  const withMatch = sql.match(/\b(?:WITH|FROM\s+\w+|INTO\s+\w+)\s*\(([\s\S]*)\)/i);
  if (!withMatch) return [];
  const pairs: { key: string; value: string; hidden: boolean }[] = [];
  const re = /['"]?([\w.\-]+)['"]?\s*=\s*['"]([^'"]*)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(withMatch[1])) !== null) {
    const hidden = isSensitiveOptionKey(m[1]);
    pairs.push({ key: m[1], value: hidden ? '[hidden]' : m[2], hidden });
  }
  return pairs;
};

export default function LineageTab() {
  const [graphData, setGraphData] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [selectedGraphNode, setSelectedGraphNode] = useState<GraphNode | null>(null);
  const [graphError, setGraphError] = useState('');

  const fetchLineageGraph = useCallback(async () => {
    setGraphLoading(true);
    setGraphError('');
    try {
      const graph = await api.getLineageGraph();
      setGraphData(graph);
      setSelectedGraphNode((selected) => {
        if (selected && graph.nodes.some((node) => node.name === selected.name)) return selected;
        return graph.nodes[0] ?? null;
      });
    } catch (error) {
      setGraphError(error instanceof Error ? error.message : 'Could not load the lineage graph.');
    } finally {
      setGraphLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchLineageGraph();
  }, [fetchLineageGraph]);

  // Renders the topology nodes layout in columns
  const renderLineageTopology = () => {
    if (!graphData || graphData.nodes.length === 0) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'hsl(var(--text-muted))' }}>
          <Network size={48} style={{ opacity: 0.3, marginBottom: 12 }} />
          <span>No lineage topology records found. Use the SQL Console to create Sources and Streams.</span>
        </div>
      );
    }

    const getNodeDetails = (node: GraphNode) => {
      if (node.node_type === 'Stream') {
        return 'STREAM';
      }
      if (!node.sql) return (node.node_type as string).toUpperCase();

      if (node.node_type === 'Source') {
        const match = node.sql.match(/FROM\s+(\w+)/i);
        const conn = match ? match[1].toUpperCase() : '';
        return conn ? `SOURCE • ${conn}` : 'SOURCE';
      }

      if (node.node_type === 'Sink') {
        const match = node.sql.match(/INTO\s+(\w+)/i);
        const conn = match ? match[1].toUpperCase() : '';
        return conn ? `SINK • ${conn}` : 'SINK';
      }

      return (node.node_type as string).toUpperCase();
    };

    // Calculate topological levels for nodes using a simple propagation pass
    const nodeLevels: Record<string, number> = {};
    graphData.nodes.forEach(n => {
      nodeLevels[n.name] = 0;
    });

    // A DAG can require at most node-count minus one relaxation passes. The
    // bound also prevents malformed cyclic graph data from looping forever.
    for (let i = 0; i < graphData.nodes.length; i++) {
      graphData.edges.forEach(edge => {
        const fromLevel = nodeLevels[edge.from] ?? 0;
        const toLevel = nodeLevels[edge.to] ?? 0;
        if (toLevel <= fromLevel) {
          nodeLevels[edge.to] = fromLevel + 1;
        }
      });
    }

    const maxLevel = Math.max(...Object.values(nodeLevels), 0);

    const levelColumns: Record<number, GraphNode[]> = {};
    graphData.nodes.forEach(node => {
      const lvl = nodeLevels[node.name] ?? 0;
      if (!levelColumns[lvl]) {
        levelColumns[lvl] = [];
      }
      levelColumns[lvl].push(node);
    });

    const nodeCoords: Record<string, { x: number; y: number }> = {};
    const paddingX = 80;
    const paddingY = 60;
    const cardWidth = 240;
    const cardHeight = 75;

    const minGapX = 120;
    const minGapY = 40;

    const maxNodesInCol = Math.max(...Object.values(levelColumns).map(cols => cols.length), 1);

    const canvasWidth = Math.max(800, paddingX * 2 + cardWidth + maxLevel * (cardWidth + minGapX));
    const canvasHeight = Math.max(500, paddingY * 2 + maxNodesInCol * cardHeight + (maxNodesInCol - 1) * minGapY);

    const colWidth = cardWidth + minGapX;

    Object.keys(levelColumns).forEach(lvlStr => {
      const lvl = parseInt(lvlStr, 10);
      const colNodes = levelColumns[lvl];
      const x = paddingX + lvl * colWidth;

      const occupiedHeight = colNodes.length * cardHeight + (colNodes.length - 1) * minGapY;
      const startY = (canvasHeight - occupiedHeight) / 2;

      colNodes.forEach((node, nodeIdx) => {
        const y = startY + nodeIdx * (cardHeight + minGapY);
        nodeCoords[node.name] = { x, y };
      });
    });

    // Layout is left-to-right by level, so connect each "from" card's right edge
    // to the "to" card's left edge with a horizontal bezier.
    const links = graphData.edges.map((edge, idx) => {
      const fromCoord = nodeCoords[edge.from];
      const toCoord = nodeCoords[edge.to];

      if (!fromCoord || !toCoord) return null;

      const startX = fromCoord.x + cardWidth;
      const startY = fromCoord.y + cardHeight / 2;
      const endX = toCoord.x - 6; // leave room for the arrowhead
      const endY = toCoord.y + cardHeight / 2;

      const dx = Math.max(40, (endX - startX) / 2);
      const pathString = `M ${startX} ${startY} C ${startX + dx} ${startY}, ${endX - dx} ${endY}, ${endX} ${endY}`;

      return (
        <path
          key={`link-${idx}`}
          d={pathString}
          className="link-line active"
          markerEnd="url(#lineage-arrow)"
        />
      );
    });

    const typeColor = (t: string) =>
      t === 'Source' ? '#059669' : t === 'Sink' ? '#d97706' : '#2563eb';

    return (
      <svg
        viewBox={`0 0 ${canvasWidth} ${canvasHeight}`}
        preserveAspectRatio="xMidYMin meet"
        style={{ display: 'block', width: '100%', height: 'auto' }}
        role="group"
        aria-label={`Pipeline lineage with ${graphData.nodes.length} nodes and ${graphData.edges.length} edges`}
      >
        <defs>
          <marker
            id="lineage-arrow"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(14, 165, 233, 0.6)" />
          </marker>
        </defs>
        <g>
          {links}
          {graphData.nodes.map((node) => {
            const coords = nodeCoords[node.name];
            if (!coords) return null;

            const isSelected = selectedGraphNode?.name === node.name;
            const color = typeColor(node.node_type);
            const fullName = node.name || `(unnamed ${node.node_type.toLowerCase()})`;
            const label = fullName.length > 24 ? `${fullName.slice(0, 22)}…` : fullName;

            return (
              <g
                key={`node-${node.name}`}
                transform={`translate(${coords.x}, ${coords.y})`}
                className={`node-group ${isSelected ? 'selected' : ''}`}
                onClick={() => setSelectedGraphNode(node)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setSelectedGraphNode(node);
                  }
                }}
                role="button"
                tabIndex={0}
                aria-label={`${fullName}, ${getNodeDetails(node)}`}
                aria-pressed={isSelected}
              >
                <title>{`${fullName} — ${getNodeDetails(node)}`}</title>
                <rect width={cardWidth} height={cardHeight} className="node-rect" />
                {/* Type accent stripe */}
                <rect x={12} y={14} width={4} height={cardHeight - 28} rx={2} fill={color} />
                <text x={28} y={31} fill="hsl(var(--text-primary))" style={{ fontSize: '14px', fontWeight: 700, fontFamily: 'var(--font-sans)' }}>
                  {label}
                </text>
                <text x={28} y={52} fill={color} style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', fontFamily: 'var(--font-sans)' }}>
                  {getNodeDetails(node)}
                </text>
                <circle cx={cardWidth - 20} cy={cardHeight / 2} r="5" fill={color} />
              </g>
            );
          })}
        </g>
      </svg>
    );
  };

  return (
    <section className="lineage-layout tab-page" aria-labelledby="lineage-title">
      {/* Visual DAG panel */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minWidth: 0, minHeight: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h1 id="lineage-title" style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Stream topology lineage</h1>
            <p style={{ color: 'hsl(var(--text-secondary))', fontSize: 12, marginTop: 4 }}>
              Select any node to inspect its DDL definition and parameters.
            </p>
          </div>
          <button className="btn btn-secondary" type="button" onClick={() => void fetchLineageGraph()} disabled={graphLoading} style={{ padding: '6px 12px' }}>
            <RefreshCw size={13} className={graphLoading ? 'animate-spin' : ''} aria-hidden="true" />
            <span>Refresh</span>
          </button>
        </div>

        {graphError && <div className="notice notice-error" role="alert"><AlertCircle size={16} aria-hidden="true" /><span>{graphError}</span></div>}
        <div className="topology-container" style={{ flex: 1, minHeight: 0 }} aria-busy={graphLoading}>
          {graphLoading ? (
            <div role="status" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12 }}>
              <RefreshCw size={24} className="animate-spin" aria-hidden="true" />
              <span style={{ color: 'hsl(var(--text-muted))' }}>Loading lineage graph…</span>
            </div>
          ) : (
            renderLineageTopology()
          )}
          {!graphLoading && graphData && graphData.nodes.length > 0 && (
            <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', gap: 14, padding: '6px 12px', background: 'rgba(255, 255, 255, 0.85)', border: '1px solid var(--border-translucent)', borderRadius: 8, fontSize: 11, fontWeight: 600, backdropFilter: 'blur(4px)' }}>
              {([['Source', '#059669'], ['Stream', '#2563eb'], ['Sink', '#d97706']] as const).map(([lbl, c]) => (
                <span key={lbl} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'hsl(var(--text-secondary))' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: c }} />
                  {lbl}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Node details panel (right sidebar) */}
      <div style={{ flex: '0 0 440px', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {selectedGraphNode ? (
          <div className="glass-card" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12, overflow: 'hidden' }}>
            <div style={{ borderBottom: '1px solid var(--border-translucent)', paddingBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className={`badge ${selectedGraphNode.node_type === 'Source' ? 'badge-emerald' : selectedGraphNode.node_type === 'Sink' ? 'badge-amber' : 'badge-blue'}`} style={{ textTransform: 'uppercase' }}>
                  {selectedGraphNode.node_type}
                </span>
                <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0, fontFamily: 'var(--font-sans)' }}>
                  {selectedGraphNode.name || `(unnamed ${selectedGraphNode.node_type.toLowerCase()})`}
                </h3>
              </div>
              <span style={{ fontSize: 11, color: 'hsl(var(--text-muted))' }}>Node details</span>
            </div>

            {/* Connector & configuration details (for Sources & Sinks) */}
            {(selectedGraphNode.node_type === 'Source' || selectedGraphNode.node_type === 'Sink') && (() => {
              const connector = getConnectorName(selectedGraphNode);
              const config = parseRelationConfig(selectedGraphNode.sql);
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <h4 style={{ fontSize: 12, fontWeight: 600, color: 'hsl(var(--text-secondary))', margin: 0 }}>
                    {selectedGraphNode.node_type === 'Source' ? 'Ingestion Details' : 'Egress Details'}
                  </h4>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: 13 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ color: 'hsl(var(--text-muted))' }}>Name:</span>
                      <span style={{ fontFamily: 'var(--font-mono)', color: 'hsl(var(--text-primary))' }}>
                        {selectedGraphNode.name || 'N/A'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ color: 'hsl(var(--text-muted))' }}>Connector:</span>
                      <span className={`badge ${selectedGraphNode.node_type === 'Source' ? 'badge-emerald' : 'badge-amber'}`}>
                        {connector || 'Unknown'}
                      </span>
                    </div>
                  </div>
                  {config.length > 0 ? (
                    <table className="meta-table" style={{ marginTop: 4 }}>
                      <caption className="sr-only">Connector options for {selectedGraphNode.name}</caption>
                      <thead>
                        <tr>
                          <th scope="col">Option Key</th>
                          <th scope="col">Value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {config.map((opt) => (
                          <tr key={opt.key}>
                            <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{opt.key}</td>
                            <td style={{ fontFamily: 'var(--font-mono)', color: 'hsl(var(--text-secondary))' }}>{opt.value}{opt.hidden ? ' (sensitive)' : ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <span style={{ fontSize: 12, color: 'hsl(var(--text-muted))' }}>
                      No connector configuration parsed from the definition.
                    </span>
                  )}
                </div>
              );
            })()}

            {/* SQL Code for node */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <h4 style={{ fontSize: 12, fontWeight: 600, color: 'hsl(var(--text-secondary))', marginBottom: 6 }}>Definition SQL Statement</h4>
              <pre className="code-preview" style={{ flex: 1, margin: 0, overflow: 'auto', fontSize: '13px', lineHeight: 1.5 }}>
                {selectedGraphNode.sql
                  ? redactSqlSecrets(selectedGraphNode.sql)
                  : '-- No SQL definition is registered for this graph node.'}
              </pre>
            </div>
          </div>
        ) : (
          <div className="glass-card" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'hsl(var(--text-muted))' }}>
            <HelpCircle size={36} style={{ opacity: 0.3, marginBottom: 8 }} />
            <span>Select a node in the graph above to view its SQL query definition here.</span>
          </div>
        )}
      </div>
    </section>
  );
}
