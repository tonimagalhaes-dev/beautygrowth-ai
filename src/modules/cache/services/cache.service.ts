import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

import {
  CachedValue,
  CacheHealth,
  CacheMetrics,
  CircuitState,
  ICacheService,
} from '../interfaces/cache-service.interface';
import { CacheTtlConfig } from '../interfaces/cache-module-options.interface';
import { CACHE_PREFIX, DEFAULT_TTL } from '../config/cache.constants';
import { REDIS_CLIENT } from '../config/cache.tokens';
import { CircuitBreakerService } from './circuit-breaker.service';
import { CacheMetricsCollector } from './cache-metrics-collector.service';
import { CacheKeyBuilder } from './cache-key-builder.service';

/**
 * Implementação principal do serviço de cache distribuído.
 *
 * Encapsula operações Redis com circuit breaker para resiliência,
 * métricas de observabilidade e serialização via envelope CachedValue.
 */
@Injectable()
export class CacheService implements ICacheService {
  private readonly logger = new Logger(CacheService.name);
  private readonly startTime = Date.now();

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly circuitBreaker: CircuitBreakerService,
    private readonly metricsCollector: CacheMetricsCollector,
    private readonly keyBuilder: CacheKeyBuilder,
  ) {}

  /**
   * Recupera um valor do cache.
   * Retorna null em caso de miss OU quando em modo bypass (circuit open).
   */
  async get<T>(key: string): Promise<T | null> {
    const resourceType = this.extractResourceType(key);
    const startMs = Date.now();

    const result = await this.circuitBreaker.execute<string | null>(
      async () => this.redis.get(key),
      null,
    );

    const latencyMs = Date.now() - startMs;
    this.metricsCollector.recordGetLatency(resourceType, latencyMs);

    // Circuit was open — bypass mode
    if (this.circuitBreaker.getState() === CircuitState.OPEN && result === null) {
      this.metricsCollector.recordBypass(resourceType);
      return null;
    }

    if (result === null) {
      this.metricsCollector.recordMiss(resourceType);
      return null;
    }

    try {
      const envelope: CachedValue<T> = JSON.parse(result);
      this.metricsCollector.recordHit(resourceType);
      return envelope.data;
    } catch (error) {
      this.logger.error(
        `Failed to deserialize cached value for key "${key}"`,
        error instanceof Error ? error.stack : String(error),
      );
      this.metricsCollector.recordMiss(resourceType);
      return null;
    }
  }

  /**
   * Armazena um valor no cache com TTL.
   * No-op silencioso quando em modo bypass.
   */
  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const resourceType = this.extractResourceType(key);
    const effectiveTtl = ttlSeconds ?? this.resolveTtl(resourceType);
    const startMs = Date.now();

    const envelope: CachedValue<T> = {
      v: 1,
      data: value,
      storedAt: new Date().toISOString(),
      resourceType,
    };

    let serialized: string;
    try {
      serialized = JSON.stringify(envelope);
    } catch (error) {
      this.logger.error(
        `Failed to serialize value for key "${key}"`,
        error instanceof Error ? error.stack : String(error),
      );
      return;
    }

    await this.circuitBreaker.execute<void>(
      async () => {
        await this.redis.set(key, serialized, 'EX', effectiveTtl);
      },
      undefined as unknown as void,
    );

    const latencyMs = Date.now() - startMs;
    this.metricsCollector.recordSetLatency(resourceType, latencyMs);
  }

  /**
   * Remove uma chave específica do cache.
   * Idempotente: não gera erro se a chave não existe.
   */
  async delete(key: string): Promise<void> {
    await this.circuitBreaker.execute<void>(
      async () => {
        await this.redis.del(key);
      },
      undefined as unknown as void,
    );
  }

  /**
   * Remove todas as chaves que correspondem ao padrão glob.
   * Usa SCAN iterativo com COUNT=100 para não bloquear o Redis.
   * Retorna a contagem de chaves deletadas.
   */
  async deleteByPattern(pattern: string): Promise<number> {
    const fullPattern = pattern.startsWith(CACHE_PREFIX)
      ? pattern
      : `${CACHE_PREFIX}${pattern}`;

    const result = await this.circuitBreaker.execute<number>(
      async () => {
        let cursor = '0';
        let deletedCount = 0;

        do {
          const [nextCursor, keys] = await this.redis.scan(
            cursor,
            'MATCH',
            fullPattern,
            'COUNT',
            100,
          );
          cursor = nextCursor;

          if (keys.length > 0) {
            await this.redis.del(...keys);
            deletedCount += keys.length;
          }
        } while (cursor !== '0');

        return deletedCount;
      },
      0,
    );

    return result;
  }

  /**
   * Verifica se uma chave existe no cache.
   * Retorna false quando em modo bypass.
   */
  async exists(key: string): Promise<boolean> {
    const result = await this.circuitBreaker.execute<boolean>(
      async () => {
        const count = await this.redis.exists(key);
        return count > 0;
      },
      false,
    );

    return result;
  }

  /**
   * Retorna métricas agregadas do cache.
   */
  getMetrics(): CacheMetrics {
    return this.metricsCollector.getMetrics();
  }

  /**
   * Retorna status de saúde do cache.
   */
  getHealth(): CacheHealth {
    const circuitState = this.circuitBreaker.getState();

    let redisStatus: 'up' | 'down' | 'circuit-open';
    switch (circuitState) {
      case CircuitState.OPEN:
        redisStatus = 'circuit-open';
        break;
      case CircuitState.HALF_OPEN:
        redisStatus = 'down';
        break;
      case CircuitState.CLOSED:
      default:
        redisStatus = 'up';
        break;
    }

    return {
      redis: redisStatus,
      circuitState,
      metrics: this.getMetrics(),
      ttlConfig: this.buildTtlConfig(),
      uptimeMs: Date.now() - this.startTime,
    };
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────

  /**
   * Extrai o tipo de recurso a partir da chave Redis.
   * Ex: "beautygrowth:cache:tenant:{id}:guardrails:active" → "guardrails"
   * Ex: "beautygrowth:cache:global:prompts:{id}:active" → "prompts"
   */
  private extractResourceType(key: string): string {
    // Remove prefix
    const withoutPrefix = key.startsWith(CACHE_PREFIX)
      ? key.slice(CACHE_PREFIX.length)
      : key;

    // Patterns:
    // tenant:{tenantId}:{resource}:{identifier}
    // global:{resource}:{identifier}
    const parts = withoutPrefix.split(':');

    if (parts[0] === 'tenant' && parts.length >= 3) {
      // tenant:{uuid}:{resource}:...
      return parts[2] ?? 'unknown';
    }

    if (parts[0] === 'global' && parts.length >= 2) {
      // global:{resource}:...
      return parts[1] ?? 'unknown';
    }

    return 'unknown';
  }

  /**
   * Resolve o TTL com base no tipo de recurso.
   */
  private resolveTtl(resourceType: string): number {
    switch (resourceType) {
      case 'guardrails':
        return Number(
          process.env.CACHE_TTL_GUARDRAILS_TENANT ??
            DEFAULT_TTL,
        );
      case 'prompts':
        return Number(process.env.CACHE_TTL_PROMPTS ?? 600);
      default:
        return DEFAULT_TTL;
    }
  }

  /**
   * Constrói a configuração de TTL atualmente em uso.
   */
  private buildTtlConfig(): CacheTtlConfig {
    return {
      guardrails_tenant: Number(
        process.env.CACHE_TTL_GUARDRAILS_TENANT ?? DEFAULT_TTL,
      ),
      guardrails_system: Number(
        process.env.CACHE_TTL_GUARDRAILS_SYSTEM ?? 600,
      ),
      prompts: Number(process.env.CACHE_TTL_PROMPTS ?? 600),
      default: DEFAULT_TTL,
    };
  }
}
