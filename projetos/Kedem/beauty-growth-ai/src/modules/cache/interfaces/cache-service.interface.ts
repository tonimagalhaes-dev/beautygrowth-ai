/**
 * Core interfaces and types for the Distributed Cache module.
 *
 * Defines the contract for cache operations, cached value envelope,
 * metrics collection and health monitoring.
 */

import { CacheTtlConfig } from './cache-module-options.interface';

// ─── Circuit State ───────────────────────────────────────────────────────────

/** Estados do circuit breaker para proteção contra falhas Redis */
export enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half-open',
}

// ─── Cached Value Envelope ───────────────────────────────────────────────────

/**
 * Envelope interno para dados cacheados.
 * Permite versionamento do formato sem breaking changes.
 */
export interface CachedValue<T> {
  /** Versão do schema de cache (para migrations futuras) */
  v: 1;
  /** Dados serializados */
  data: T;
  /** Timestamp de armazenamento (ISO 8601) */
  storedAt: string;
  /** Tipo de recurso (para métricas) */
  resourceType: string;
}

// ─── Cache Metrics ───────────────────────────────────────────────────────────

export interface CacheMetrics {
  /** Hits por tipo de recurso */
  hits: Record<string, number>;
  /** Misses por tipo de recurso */
  misses: Record<string, number>;
  /** Invalidações por tipo de recurso */
  invalidations: Record<string, number>;
  /** Latência média de get em ms por tipo */
  avgGetLatencyMs: Record<string, number>;
  /** Latência média de set em ms por tipo */
  avgSetLatencyMs: Record<string, number>;
  /** Total de erros de conexão */
  connectionErrors: number;
  /** Hit rate por tipo (%) */
  hitRate: Record<string, number>;
}

// ─── Cache Health ────────────────────────────────────────────────────────────

export interface CacheHealth {
  /** Status da conexão Redis */
  redis: 'up' | 'down' | 'circuit-open';
  /** Estado do circuit breaker */
  circuitState: CircuitState;
  /** Métricas agregadas */
  metrics: CacheMetrics;
  /** Configuração de TTL ativa */
  ttlConfig: CacheTtlConfig;
  /** Uptime do módulo em ms */
  uptimeMs: number;
}

// ─── Service Interface ───────────────────────────────────────────────────────

/** DI Token para injeção do CacheService */
export const CACHE_SERVICE = Symbol('CACHE_SERVICE');

/**
 * Contrato principal do serviço de cache distribuído.
 * Todas as operações são tenant-aware e resilientes a falhas de Redis.
 */
export interface ICacheService {
  /**
   * Recupera um valor do cache.
   * Retorna null em caso de miss OU quando em modo bypass (circuit open).
   */
  get<T>(key: string): Promise<T | null>;

  /**
   * Armazena um valor no cache com TTL.
   * No-op silencioso quando em modo bypass.
   * @param ttlSeconds - Override de TTL; se não fornecido, usa config por recurso ou default
   */
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;

  /**
   * Remove uma chave específica do cache.
   * Idempotente: não gera erro se a chave não existe.
   */
  delete(key: string): Promise<void>;

  /**
   * Remove todas as chaves que correspondem ao padrão glob.
   * Usa SCAN internamente para não bloquear o Redis.
   * Idempotente: não gera erro se nenhuma chave corresponde.
   */
  deleteByPattern(pattern: string): Promise<number>;

  /**
   * Verifica se uma chave existe no cache.
   * Retorna false quando em modo bypass.
   */
  exists(key: string): Promise<boolean>;

  /**
   * Retorna métricas agregadas do cache.
   */
  getMetrics(): CacheMetrics;

  /**
   * Retorna status de saúde do cache.
   */
  getHealth(): CacheHealth;
}
