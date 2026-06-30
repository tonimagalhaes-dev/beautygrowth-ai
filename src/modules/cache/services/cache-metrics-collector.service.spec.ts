import { Logger } from '@nestjs/common';

import { CacheMetricsCollector } from './cache-metrics-collector.service';

describe('CacheMetricsCollector', () => {
  let collector: CacheMetricsCollector;
  let loggerWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    collector = new CacheMetricsCollector();
    loggerWarnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─── recordHit / recordMiss counting per resource ──────────────────────────

  describe('recordHit / recordMiss', () => {
    it('should count hits per resource type', () => {
      collector.recordHit('guardrails');
      collector.recordHit('guardrails');
      collector.recordHit('prompts');

      const metrics = collector.getMetrics();
      expect(metrics.hits['guardrails']).toBe(2);
      expect(metrics.hits['prompts']).toBe(1);
    });

    it('should count misses per resource type', () => {
      collector.recordMiss('guardrails');
      collector.recordMiss('prompts');
      collector.recordMiss('prompts');
      collector.recordMiss('prompts');

      const metrics = collector.getMetrics();
      expect(metrics.misses['guardrails']).toBe(1);
      expect(metrics.misses['prompts']).toBe(3);
    });

    it('should track hits and misses independently per resource', () => {
      collector.recordHit('guardrails');
      collector.recordMiss('guardrails');
      collector.recordHit('prompts');

      const metrics = collector.getMetrics();
      expect(metrics.hits['guardrails']).toBe(1);
      expect(metrics.misses['guardrails']).toBe(1);
      expect(metrics.hits['prompts']).toBe(1);
      expect(metrics.misses['prompts']).toBeUndefined();
    });
  });

  // ─── getHitRate ────────────────────────────────────────────────────────────

  describe('getHitRate', () => {
    it('should return 100% when all operations are hits', () => {
      collector.recordHit('guardrails');
      collector.recordHit('guardrails');
      collector.recordHit('guardrails');

      expect(collector.getHitRate('guardrails')).toBe(100);
    });

    it('should return 50% when hits and misses are equal', () => {
      collector.recordHit('guardrails');
      collector.recordMiss('guardrails');

      expect(collector.getHitRate('guardrails')).toBe(50);
    });

    it('should return 0% when all operations are misses', () => {
      collector.recordMiss('guardrails');
      collector.recordMiss('guardrails');
      collector.recordMiss('guardrails');

      expect(collector.getHitRate('guardrails')).toBe(0);
    });

    it('should return 0 when no operations have been recorded', () => {
      expect(collector.getHitRate('guardrails')).toBe(0);
    });

    it('should calculate hit rate per resource independently', () => {
      collector.recordHit('guardrails');
      collector.recordMiss('guardrails');
      collector.recordHit('prompts');
      collector.recordHit('prompts');
      collector.recordHit('prompts');

      expect(collector.getHitRate('guardrails')).toBe(50);
      expect(collector.getHitRate('prompts')).toBe(100);
    });

    it('should include hitRate in getMetrics result', () => {
      collector.recordHit('guardrails');
      collector.recordHit('guardrails');
      collector.recordMiss('guardrails');

      const metrics = collector.getMetrics();
      expect(metrics.hitRate['guardrails']).toBeCloseTo(66.67, 1);
    });
  });

  // ─── recordGetLatency / recordSetLatency ───────────────────────────────────

  describe('recordGetLatency / recordSetLatency', () => {
    it('should record get latencies and compute average', () => {
      collector.recordGetLatency('guardrails', 10);
      collector.recordGetLatency('guardrails', 20);
      collector.recordGetLatency('guardrails', 30);

      const metrics = collector.getMetrics();
      expect(metrics.avgGetLatencyMs['guardrails']).toBe(20);
    });

    it('should record set latencies and compute average', () => {
      collector.recordSetLatency('prompts', 5);
      collector.recordSetLatency('prompts', 15);

      const metrics = collector.getMetrics();
      expect(metrics.avgSetLatencyMs['prompts']).toBe(10);
    });

    it('should track latencies independently per resource type', () => {
      collector.recordGetLatency('guardrails', 10);
      collector.recordGetLatency('prompts', 50);

      const metrics = collector.getMetrics();
      expect(metrics.avgGetLatencyMs['guardrails']).toBe(10);
      expect(metrics.avgGetLatencyMs['prompts']).toBe(50);
    });

    it('should handle single latency value', () => {
      collector.recordGetLatency('guardrails', 42);

      const metrics = collector.getMetrics();
      expect(metrics.avgGetLatencyMs['guardrails']).toBe(42);
    });
  });

  // ─── recordInvalidation ────────────────────────────────────────────────────

  describe('recordInvalidation', () => {
    it('should count invalidations per resource type', () => {
      collector.recordInvalidation('guardrails');
      collector.recordInvalidation('guardrails');
      collector.recordInvalidation('prompts');

      const metrics = collector.getMetrics();
      expect(metrics.invalidations['guardrails']).toBe(2);
      expect(metrics.invalidations['prompts']).toBe(1);
    });
  });

  // ─── recordConnectionError ─────────────────────────────────────────────────

  describe('recordConnectionError', () => {
    it('should increment total connection errors', () => {
      collector.recordConnectionError();
      collector.recordConnectionError();
      collector.recordConnectionError();

      const metrics = collector.getMetrics();
      expect(metrics.connectionErrors).toBe(3);
    });
  });

  // ─── WARN log when hit rate < 50% ─────────────────────────────────────────

  describe('WARN log emission', () => {
    it('should emit WARN when hit rate drops below 50% with >= 10 samples', () => {
      // Record 3 hits and 7 misses (30% hit rate, 10 total samples)
      for (let i = 0; i < 3; i++) {
        collector.recordHit('guardrails');
      }
      for (let i = 0; i < 7; i++) {
        collector.recordMiss('guardrails');
      }

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Low cache hit rate'),
      );
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('guardrails'),
      );
    });

    it('should NOT emit WARN when total samples < 10', () => {
      // Record 1 hit and 5 misses (below 50%, but less than 10 samples)
      collector.recordHit('guardrails');
      for (let i = 0; i < 5; i++) {
        collector.recordMiss('guardrails');
      }

      expect(loggerWarnSpy).not.toHaveBeenCalled();
    });

    it('should NOT emit WARN when hit rate >= 50%', () => {
      // Record 5 hits and 5 misses (50% hit rate, 10 samples)
      for (let i = 0; i < 5; i++) {
        collector.recordHit('guardrails');
      }
      for (let i = 0; i < 5; i++) {
        collector.recordMiss('guardrails');
      }

      expect(loggerWarnSpy).not.toHaveBeenCalled();
    });

    it('should emit WARN per resource type independently', () => {
      // guardrails: 2 hits, 8 misses = 20% (should warn)
      for (let i = 0; i < 2; i++) {
        collector.recordHit('guardrails');
      }
      for (let i = 0; i < 8; i++) {
        collector.recordMiss('guardrails');
      }

      // prompts: 9 hits, 1 miss = 90% (should not warn)
      for (let i = 0; i < 9; i++) {
        collector.recordHit('prompts');
      }
      collector.recordMiss('prompts');

      const warnCalls = loggerWarnSpy.mock.calls.map((c) => c[0]);
      expect(warnCalls.some((msg: string) => msg.includes('guardrails'))).toBe(true);
      expect(warnCalls.some((msg: string) => msg.includes('prompts'))).toBe(false);
    });
  });

  // ─── reset ─────────────────────────────────────────────────────────────────

  describe('reset', () => {
    it('should clear all counters and latencies', () => {
      collector.recordHit('guardrails');
      collector.recordMiss('guardrails');
      collector.recordGetLatency('guardrails', 10);
      collector.recordSetLatency('guardrails', 20);
      collector.recordInvalidation('guardrails');
      collector.recordConnectionError();

      collector.reset();

      const metrics = collector.getMetrics();
      expect(metrics.hits).toEqual({});
      expect(metrics.misses).toEqual({});
      expect(metrics.invalidations).toEqual({});
      expect(metrics.avgGetLatencyMs).toEqual({});
      expect(metrics.avgSetLatencyMs).toEqual({});
      expect(metrics.connectionErrors).toBe(0);
      expect(metrics.hitRate).toEqual({});
    });

    it('should reset hit rate to 0 after clearing', () => {
      collector.recordHit('guardrails');
      collector.recordHit('guardrails');

      collector.reset();

      expect(collector.getHitRate('guardrails')).toBe(0);
    });
  });

  // ─── getMetrics structure ──────────────────────────────────────────────────

  describe('getMetrics', () => {
    it('should return correct CacheMetrics structure with all fields', () => {
      collector.recordHit('guardrails');
      collector.recordMiss('prompts');
      collector.recordGetLatency('guardrails', 5);
      collector.recordSetLatency('prompts', 12);
      collector.recordInvalidation('guardrails');
      collector.recordConnectionError();

      const metrics = collector.getMetrics();

      expect(metrics).toEqual({
        hits: { guardrails: 1 },
        misses: { prompts: 1 },
        invalidations: { guardrails: 1 },
        avgGetLatencyMs: { guardrails: 5 },
        avgSetLatencyMs: { prompts: 12 },
        connectionErrors: 1,
        hitRate: { guardrails: 100, prompts: 0 },
      });
    });

    it('should return empty metrics when no operations recorded', () => {
      const metrics = collector.getMetrics();

      expect(metrics).toEqual({
        hits: {},
        misses: {},
        invalidations: {},
        avgGetLatencyMs: {},
        avgSetLatencyMs: {},
        connectionErrors: 0,
        hitRate: {},
      });
    });
  });
});
