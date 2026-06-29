import { Injectable, Logger } from '@nestjs/common';

import { EVENT_REGISTRY } from '../config/event-registry';
import { EventBusMetrics, QueueSizeInfo } from '../interfaces';

/**
 * SLA configuration per event type (in milliseconds).
 * Used to determine when to emit latency alerts.
 */
export const EVENT_SLA: Record<string, number> = {
  'tenant.created': 30_000, // 30s
  'brand.updated': 60_000, // 60s
  'guardrails.changed': 30_000, // 30s
  'guardrails.violation': 120_000, // 2min
};

/** Threshold for queue size alerts (waiting + delayed) */
export const QUEUE_SIZE_ALERT_THRESHOLD = 1000;

/**
 * MetricsCollector — Collects and exposes operational metrics for the Event Bus.
 *
 * Tracks in-memory counters for published, processed, and failed events per type.
 * Collects latency samples to calculate average processing latency.
 * Emits WARN-level structured alerts when:
 *   - Latency exceeds 2x the configured SLA for an event type
 *   - Queue size (waiting + delayed) exceeds 1000 pending events
 *
 * @see Requirements 7.1, 7.2, 7.3
 */
@Injectable()
export class MetricsCollector {
  private readonly logger = new Logger(MetricsCollector.name);

  private published: Record<string, number> = {};
  private processed: Record<string, number> = {};
  private failed: Record<string, number> = {};
  private latencySamples: Record<string, number[]> = {};

  constructor() {
    // Initialize counters for all registered events
    for (const config of EVENT_REGISTRY) {
      this.published[config.name] = 0;
      this.processed[config.name] = 0;
      this.failed[config.name] = 0;
      this.latencySamples[config.name] = [];
    }
  }

  /**
   * Records a published event.
   * Increments the published counter for the given event type.
   */
  recordPublished(eventName: string): void {
    this.published[eventName] = (this.published[eventName] ?? 0) + 1;
  }

  /**
   * Records a successfully processed event with its processing duration.
   * Increments the processed counter, stores the latency sample,
   * and checks for SLA violation alerts.
   */
  recordProcessed(eventName: string, durationMs: number): void {
    this.processed[eventName] = (this.processed[eventName] ?? 0) + 1;

    if (!this.latencySamples[eventName]) {
      this.latencySamples[eventName] = [];
    }
    this.latencySamples[eventName].push(durationMs);

    // Check latency alert condition
    this.checkLatencyAlert(eventName, durationMs);
  }

  /**
   * Records a failed event (moved to DLQ after exhausting retries).
   * Increments the failed counter for the given event type.
   */
  recordFailed(eventName: string): void {
    this.failed[eventName] = (this.failed[eventName] ?? 0) + 1;
  }

  /**
   * Checks if a queue size exceeds the alert threshold and emits WARN log.
   * Called externally by EventBusService when fetching queue sizes.
   *
   * Alert condition: (waiting + delayed) > 1000
   */
  checkQueueSizeAlert(eventName: string, queueSize: QueueSizeInfo): void {
    const pending = queueSize.waiting + queueSize.delayed;
    if (pending > QUEUE_SIZE_ALERT_THRESHOLD) {
      this.logger.warn(
        JSON.stringify({
          alert: 'queue_size_exceeded',
          eventName,
          pendingCount: pending,
          threshold: QUEUE_SIZE_ALERT_THRESHOLD,
        }),
      );
    }
  }

  /**
   * Calculates the average latency (ms) for a given event type.
   * Returns 0 if no samples are available.
   */
  getAverageLatency(eventName: string): number {
    const samples = this.latencySamples[eventName] ?? [];
    if (samples.length === 0) return 0;
    return Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
  }

  /**
   * Returns aggregated metrics for all tracked event types.
   * queueSizes is left empty — populated by EventBusService with actual queue data.
   */
  getMetrics(): EventBusMetrics {
    const avgLatencyMs: Record<string, number> = {};
    for (const eventName of Object.keys(this.latencySamples)) {
      avgLatencyMs[eventName] = this.getAverageLatency(eventName);
    }

    return {
      published: { ...this.published },
      processed: { ...this.processed },
      failed: { ...this.failed },
      avgLatencyMs,
      queueSizes: {},
    };
  }

  /**
   * Resets all metrics counters and latency samples.
   * Useful for periodic cleanup or testing.
   */
  reset(): void {
    for (const key of Object.keys(this.published)) {
      this.published[key] = 0;
      this.processed[key] = 0;
      this.failed[key] = 0;
      this.latencySamples[key] = [];
    }
  }

  /**
   * Checks if the processing duration exceeds 2x the SLA for the event type.
   * Emits a structured WARN log when the threshold is breached.
   */
  private checkLatencyAlert(eventName: string, durationMs: number): void {
    const sla = EVENT_SLA[eventName];
    if (sla && durationMs > 2 * sla) {
      const avgLatency = this.getAverageLatency(eventName);
      this.logger.warn(
        JSON.stringify({
          alert: 'latency_exceeded',
          eventName,
          avgLatencyMs: avgLatency,
          currentLatencyMs: durationMs,
          slaMs: sla,
          threshold: 2 * sla,
        }),
      );
    }
  }
}
