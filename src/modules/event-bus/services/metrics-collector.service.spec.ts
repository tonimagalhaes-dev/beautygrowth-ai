import { QueueSizeInfo } from '../interfaces';
import {
  EVENT_SLA,
  MetricsCollector,
  QUEUE_SIZE_ALERT_THRESHOLD,
} from './metrics-collector.service';

describe('MetricsCollector', () => {
  let collector: MetricsCollector;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    collector = new MetricsCollector();
    // Spy on the logger.warn method
    warnSpy = jest.spyOn((collector as any).logger, 'warn');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('initialization', () => {
    it('should initialize counters for all registered events', () => {
      const metrics = collector.getMetrics();

      expect(metrics.published['tenant.created']).toBe(0);
      expect(metrics.published['brand.updated']).toBe(0);
      expect(metrics.published['guardrails.changed']).toBe(0);
      expect(metrics.published['guardrails.violation']).toBe(0);

      expect(metrics.processed['tenant.created']).toBe(0);
      expect(metrics.failed['tenant.created']).toBe(0);
    });
  });

  describe('recordPublished()', () => {
    it('should increment the published counter for a known event', () => {
      collector.recordPublished('tenant.created');
      collector.recordPublished('tenant.created');
      collector.recordPublished('brand.updated');

      const metrics = collector.getMetrics();
      expect(metrics.published['tenant.created']).toBe(2);
      expect(metrics.published['brand.updated']).toBe(1);
    });

    it('should handle unknown event names gracefully', () => {
      collector.recordPublished('unknown.event');

      const metrics = collector.getMetrics();
      expect(metrics.published['unknown.event']).toBe(1);
    });
  });

  describe('recordProcessed()', () => {
    it('should increment the processed counter', () => {
      collector.recordProcessed('tenant.created', 150);
      collector.recordProcessed('tenant.created', 200);

      const metrics = collector.getMetrics();
      expect(metrics.processed['tenant.created']).toBe(2);
    });

    it('should store latency samples and calculate average', () => {
      collector.recordProcessed('tenant.created', 100);
      collector.recordProcessed('tenant.created', 200);
      collector.recordProcessed('tenant.created', 300);

      expect(collector.getAverageLatency('tenant.created')).toBe(200);
    });

    it('should handle unknown event names gracefully', () => {
      collector.recordProcessed('unknown.event', 500);

      const metrics = collector.getMetrics();
      expect(metrics.processed['unknown.event']).toBe(1);
      expect(metrics.avgLatencyMs['unknown.event']).toBe(500);
    });
  });

  describe('recordFailed()', () => {
    it('should increment the failed counter', () => {
      collector.recordFailed('tenant.created');
      collector.recordFailed('tenant.created');
      collector.recordFailed('brand.updated');

      const metrics = collector.getMetrics();
      expect(metrics.failed['tenant.created']).toBe(2);
      expect(metrics.failed['brand.updated']).toBe(1);
    });

    it('should handle unknown event names gracefully', () => {
      collector.recordFailed('unknown.event');

      const metrics = collector.getMetrics();
      expect(metrics.failed['unknown.event']).toBe(1);
    });
  });

  describe('checkLatencyAlert()', () => {
    it('should emit WARN log when latency exceeds 2x SLA', () => {
      const sla = EVENT_SLA['tenant.created']; // 30_000ms
      const exceedingDuration = 2 * sla + 1; // Just over threshold

      collector.recordProcessed('tenant.created', exceedingDuration);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const logMessage = JSON.parse(warnSpy.mock.calls[0][0]);
      expect(logMessage.alert).toBe('latency_exceeded');
      expect(logMessage.eventName).toBe('tenant.created');
      expect(logMessage.currentLatencyMs).toBe(exceedingDuration);
      expect(logMessage.slaMs).toBe(sla);
      expect(logMessage.threshold).toBe(2 * sla);
    });

    it('should NOT emit WARN when latency is within 2x SLA', () => {
      const sla = EVENT_SLA['tenant.created']; // 30_000ms
      const withinDuration = 2 * sla - 1; // Just under threshold

      collector.recordProcessed('tenant.created', withinDuration);

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should NOT emit WARN when latency equals exactly 2x SLA', () => {
      const sla = EVENT_SLA['tenant.created']; // 30_000ms
      const exactThreshold = 2 * sla;

      collector.recordProcessed('tenant.created', exactThreshold);

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should NOT emit alert for events without SLA configured', () => {
      collector.recordProcessed('unknown.event', 999_999);

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should include average latency in the alert log', () => {
      const sla = EVENT_SLA['brand.updated']; // 60_000ms

      // Add some baseline samples
      collector.recordProcessed('brand.updated', 1000);
      collector.recordProcessed('brand.updated', 2000);
      // This one exceeds 2x SLA
      collector.recordProcessed('brand.updated', 2 * sla + 1000);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const logMessage = JSON.parse(warnSpy.mock.calls[0][0]);
      expect(logMessage.avgLatencyMs).toBeDefined();
      expect(typeof logMessage.avgLatencyMs).toBe('number');
    });
  });

  describe('checkQueueSizeAlert()', () => {
    it('should emit WARN when pending count exceeds threshold', () => {
      const queueSize: QueueSizeInfo = {
        waiting: 800,
        active: 10,
        delayed: 300,
        failed: 5,
      };

      collector.checkQueueSizeAlert('tenant.created', queueSize);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const logMessage = JSON.parse(warnSpy.mock.calls[0][0]);
      expect(logMessage.alert).toBe('queue_size_exceeded');
      expect(logMessage.eventName).toBe('tenant.created');
      expect(logMessage.pendingCount).toBe(1100); // 800 + 300
      expect(logMessage.threshold).toBe(QUEUE_SIZE_ALERT_THRESHOLD);
    });

    it('should NOT emit WARN when pending count is within threshold', () => {
      const queueSize: QueueSizeInfo = {
        waiting: 500,
        active: 10,
        delayed: 400,
        failed: 5,
      };

      collector.checkQueueSizeAlert('tenant.created', queueSize);

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should NOT emit WARN when pending equals exactly threshold', () => {
      const queueSize: QueueSizeInfo = {
        waiting: 700,
        active: 10,
        delayed: 300,
        failed: 5,
      };

      collector.checkQueueSizeAlert('tenant.created', queueSize);

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('should only consider waiting + delayed for pending count', () => {
      const queueSize: QueueSizeInfo = {
        waiting: 100,
        active: 5000,
        delayed: 100,
        failed: 5000,
      };

      collector.checkQueueSizeAlert('tenant.created', queueSize);

      // pending = 100 + 100 = 200, below threshold
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('getAverageLatency()', () => {
    it('should return 0 when no samples exist', () => {
      expect(collector.getAverageLatency('tenant.created')).toBe(0);
    });

    it('should return 0 for unknown event names', () => {
      expect(collector.getAverageLatency('nonexistent.event')).toBe(0);
    });

    it('should return the single sample value for one sample', () => {
      collector.recordProcessed('tenant.created', 500);
      expect(collector.getAverageLatency('tenant.created')).toBe(500);
    });

    it('should calculate rounded average of multiple samples', () => {
      collector.recordProcessed('tenant.created', 100);
      collector.recordProcessed('tenant.created', 200);
      collector.recordProcessed('tenant.created', 301);

      // Average = (100 + 200 + 301) / 3 = 200.33... → rounded to 200
      expect(collector.getAverageLatency('tenant.created')).toBe(200);
    });
  });

  describe('getMetrics()', () => {
    it('should return aggregated metrics with all fields', () => {
      collector.recordPublished('tenant.created');
      collector.recordPublished('tenant.created');
      collector.recordProcessed('tenant.created', 100);
      collector.recordFailed('brand.updated');

      const metrics = collector.getMetrics();

      expect(metrics.published['tenant.created']).toBe(2);
      expect(metrics.processed['tenant.created']).toBe(1);
      expect(metrics.failed['brand.updated']).toBe(1);
      expect(metrics.avgLatencyMs['tenant.created']).toBe(100);
      expect(metrics.queueSizes).toEqual({});
    });

    it('should return copies of internal state (immutable)', () => {
      collector.recordPublished('tenant.created');
      const metrics = collector.getMetrics();

      // Mutating the returned object should not affect internal state
      metrics.published['tenant.created'] = 999;

      const freshMetrics = collector.getMetrics();
      expect(freshMetrics.published['tenant.created']).toBe(1);
    });
  });

  describe('reset()', () => {
    it('should reset all counters and samples to initial values', () => {
      collector.recordPublished('tenant.created');
      collector.recordPublished('tenant.created');
      collector.recordProcessed('tenant.created', 500);
      collector.recordFailed('brand.updated');

      collector.reset();

      const metrics = collector.getMetrics();
      expect(metrics.published['tenant.created']).toBe(0);
      expect(metrics.processed['tenant.created']).toBe(0);
      expect(metrics.failed['brand.updated']).toBe(0);
      expect(metrics.avgLatencyMs['tenant.created']).toBe(0);
    });

    it('should allow recording new metrics after reset', () => {
      collector.recordPublished('tenant.created');
      collector.reset();
      collector.recordPublished('tenant.created');

      const metrics = collector.getMetrics();
      expect(metrics.published['tenant.created']).toBe(1);
    });
  });
});
