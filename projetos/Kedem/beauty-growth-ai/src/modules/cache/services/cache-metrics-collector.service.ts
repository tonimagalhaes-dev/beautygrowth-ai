import { Injectable, Logger } from '@nestjs/common';

import { CacheMetrics } from '../interfaces/cache-service.interface';

/**
 * Coletor de métricas para o módulo de cache distribuído.
 * Mantém contadores em memória para hits, misses, invalidações,
 * latências e erros de conexão, agregados por tipo de recurso.
 */
@Injectable()
export class CacheMetricsCollector {
  private readonly logger = new Logger(CacheMetricsCollector.name);
  private hits: Map<string, number> = new Map();
  private misses: Map<string, number> = new Map();
  private bypasses: Map<string, number> = new Map();
  private invalidations: Map<string, number> = new Map();
  private getLatencies: Map<string, number[]> = new Map();
  private setLatencies: Map<string, number[]> = new Map();
  private connectionErrors = 0;
  private hitRateWindow: Map<string, { hits: number; misses: number; lastCheck: number }> = new Map();

  /** Registra hit para um tipo de recurso */
  recordHit(resourceType: string): void {
    this.hits.set(resourceType, (this.hits.get(resourceType) ?? 0) + 1);
    this.checkHitRateWarning(resourceType);
  }

  /** Registra miss para um tipo de recurso */
  recordMiss(resourceType: string): void {
    this.misses.set(resourceType, (this.misses.get(resourceType) ?? 0) + 1);
    this.checkHitRateWarning(resourceType);
  }

  /** Registra bypass (circuit open) para um tipo de recurso */
  recordBypass(resourceType: string): void {
    this.bypasses.set(
      resourceType,
      (this.bypasses.get(resourceType) ?? 0) + 1,
    );
  }

  /** Registra invalidação para um tipo de recurso */
  recordInvalidation(resourceType: string): void {
    this.invalidations.set(
      resourceType,
      (this.invalidations.get(resourceType) ?? 0) + 1,
    );
  }

  /** Registra latência de operação GET */
  recordGetLatency(resourceType: string, ms: number): void {
    const latencies = this.getLatencies.get(resourceType) ?? [];
    latencies.push(ms);
    this.getLatencies.set(resourceType, latencies);
  }

  /** Registra latência de operação SET */
  recordSetLatency(resourceType: string, ms: number): void {
    const latencies = this.setLatencies.get(resourceType) ?? [];
    latencies.push(ms);
    this.setLatencies.set(resourceType, latencies);
  }

  /** Registra erro de conexão */
  recordConnectionError(): void {
    this.connectionErrors++;
  }

  /**
   * Calcula hit rate para um recurso: hits / (hits + misses) * 100
   * Retorna 0 se não há operações registradas.
   */
  getHitRate(resourceType: string): number {
    const h = this.hits.get(resourceType) ?? 0;
    const m = this.misses.get(resourceType) ?? 0;
    const total = h + m;
    if (total === 0) return 0;
    return (h / total) * 100;
  }

  /** Retorna métricas agregadas */
  getMetrics(): CacheMetrics {
    const hits = this.mapToRecord(this.hits);
    const misses = this.mapToRecord(this.misses);
    const invalidations = this.mapToRecord(this.invalidations);
    const avgGetLatencyMs = this.computeAverageLatencies(this.getLatencies);
    const avgSetLatencyMs = this.computeAverageLatencies(this.setLatencies);

    const hitRate: Record<string, number> = {};
    const allResourceTypes = new Set([
      ...this.hits.keys(),
      ...this.misses.keys(),
    ]);
    for (const rt of allResourceTypes) {
      hitRate[rt] = this.getHitRate(rt);
    }

    return {
      hits,
      misses,
      invalidations,
      avgGetLatencyMs,
      avgSetLatencyMs,
      connectionErrors: this.connectionErrors,
      hitRate,
    };
  }

  /** Reseta todas as métricas */
  reset(): void {
    this.hits.clear();
    this.misses.clear();
    this.bypasses.clear();
    this.invalidations.clear();
    this.getLatencies.clear();
    this.setLatencies.clear();
    this.connectionErrors = 0;
    this.hitRateWindow.clear();
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  /**
   * Checks hit rate in a 5-minute window and emits WARN if below 50%.
   */
  private checkHitRateWarning(resourceType: string): void {
    const now = Date.now();
    const windowMs = 5 * 60 * 1000; // 5 minutes

    let window = this.hitRateWindow.get(resourceType);
    if (!window || now - window.lastCheck > windowMs) {
      // Start new window
      window = { hits: 0, misses: 0, lastCheck: now };
      this.hitRateWindow.set(resourceType, window);
    }

    const h = this.hits.get(resourceType) ?? 0;
    const m = this.misses.get(resourceType) ?? 0;
    window.hits = h;
    window.misses = m;

    const total = h + m;
    if (total >= 10) {
      // Only warn when we have enough samples
      const rate = (h / total) * 100;
      if (rate < 50) {
        this.logger.warn(
          `Low cache hit rate for resource "${resourceType}": ${rate.toFixed(1)}% (threshold: 50%)`,
        );
      }
    }
  }

  private mapToRecord(map: Map<string, number>): Record<string, number> {
    const record: Record<string, number> = {};
    for (const [key, value] of map) {
      record[key] = value;
    }
    return record;
  }

  private computeAverageLatencies(
    latencyMap: Map<string, number[]>,
  ): Record<string, number> {
    const record: Record<string, number> = {};
    for (const [key, values] of latencyMap) {
      if (values.length === 0) {
        record[key] = 0;
      } else {
        const sum = values.reduce((acc, v) => acc + v, 0);
        record[key] = sum / values.length;
      }
    }
    return record;
  }
}
