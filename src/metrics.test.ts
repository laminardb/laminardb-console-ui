import { describe, expect, it, vi } from 'vitest';
import {
  M, histogramMean, histogramQuantile, parsePrometheusText, rate, subsystemOf, value,
  valueMatching,
} from './metrics';
import type { MetricsSnapshot } from './metrics';

const ENGINE_SHA = 'f905741c3730bdf4733fd3b0501e45ab31518d89';

describe(`LaminarDB Prometheus contract at ${ENGINE_SHA}`, () => {
  it('parses types, escaped labels, gauges, counters, and histograms', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const snapshot = parsePrometheusText(`# HELP laminardb_events_ingested_total Events ingested
# TYPE laminardb_events_ingested_total counter
laminardb_events_ingested_total{instance="node-a",pipeline="main"} 12
# TYPE laminardb_source_idle gauge
laminardb_source_idle{source="orders\\nprimary",instance="node-a"} 1
# TYPE laminardb_cycle_duration_seconds histogram
laminardb_cycle_duration_seconds_bucket{le="0.1"} 2
laminardb_cycle_duration_seconds_bucket{le="0.5"} 8
laminardb_cycle_duration_seconds_bucket{le="+Inf"} 10
laminardb_cycle_duration_seconds_sum 2.4
laminardb_cycle_duration_seconds_count 10
`);

    expect(snapshot.at).toBe(1_000);
    expect(value(snapshot, M.eventsIngested)).toBe(12);
    expect(valueMatching(snapshot, M.sourceIdle, { source: 'orders\nprimary' })).toBe(1);
    expect(histogramQuantile(snapshot, M.cycleDuration, 0.5)).toBeCloseTo(0.3);
    expect(histogramMean(snapshot, M.cycleDuration)).toBeCloseTo(0.24);
  });

  it('omits non-finite samples instead of poisoning derived values', () => {
    const snapshot = parsePrometheusText(`# TYPE laminardb_pipeline_watermark gauge
laminardb_pipeline_watermark NaN
`);
    expect(value(snapshot, M.pipelineWatermark)).toBeUndefined();
  });

  it('derives per-second rates and clamps a restart reset to zero', () => {
    const snapshot = (at: number, counter: number): MetricsSnapshot => ({
      at,
      families: new Map([[M.eventsIngested, {
        name: M.eventsIngested,
        type: 'counter',
        help: '',
        samples: [{ labels: {}, value: counter }],
        buckets: [],
      }]]),
    });
    expect(rate(snapshot(0, 10), snapshot(2_000, 18), M.eventsIngested)).toBe(4);
    expect(rate(snapshot(0, 10), snapshot(2_000, 2), M.eventsIngested)).toBe(0);
  });

  it('uses current metric names and does not classify removed 0.28 state tiers', () => {
    expect(M.managedStateAccountedBytes).toBe('laminardb_managed_state_accounted_bytes');
    expect(M.shuffleDeliveryLossIncidents).toBe('laminardb_shuffle_delivery_loss_incidents_total');
    expect(M.clusterSubscriptionRetainedBytes).toBe('laminardb_cluster_subscription_retained_bytes');
    expect(Object.values(M)).not.toContain('laminardb_state_hot_bytes');
    expect(subsystemOf(M.checkpointBarrierLocal)).toBe('Checkpointing');
    expect(subsystemOf(M.clusterSubscriptionManifestRefresh)).toBe('Cluster subscriptions');
  });
});
