/**
 * Configuration interfaces for the CacheModule.
 *
 * Defines module registration options, TTL configuration per resource type,
 * feature-specific config and circuit breaker parameters.
 */

// ─── TTL Configuration ───────────────────────────────────────────────────────

export interface CacheTtlConfig {
  /** TTL para guardrails de tenant em segundos (default: 300 = 5 min) */
  guardrails_tenant?: number;
  /** TTL para guardrails de sistema em segundos (default: 600 = 10 min) */
  guardrails_system?: number;
  /** TTL para prompts em segundos (default: 600 = 10 min) */
  prompts?: number;
  /** TTL padrão em segundos (default: 300 = 5 min) */
  default?: number;
}

// ─── Circuit Breaker Config ──────────────────────────────────────────────────

export interface CircuitBreakerConfig {
  /** Número de falhas consecutivas para abrir o circuito (default: 3) */
  failureThreshold?: number;
  /** Intervalo em ms para tentar reconexão quando aberto (default: 30000) */
  recoveryTimeout?: number;
}

// ─── Feature Config ──────────────────────────────────────────────────────────

export interface CacheFeatureConfig {
  /** Nome do recurso para namespace (ex: 'guardrails', 'prompts') */
  resourceName: string;
  /** TTL específico para este recurso (override do default) */
  ttl?: number;
}

// ─── Module Options ──────────────────────────────────────────────────────────

export interface CacheModuleOptions {
  /** Configuração de conexão Redis (host, port) */
  redis?: {
    host?: string; // default: process.env.REDIS_HOST || 'localhost'
    port?: number; // default: process.env.REDIS_PORT || 6379
  };
  /** Prefixo global para todas as chaves (default: 'beautygrowth:cache:') */
  prefix?: string;
  /** TTL padrão em segundos (default: 300) */
  defaultTtl?: number;
  /** Configuração de TTL por tipo de recurso */
  ttlConfig?: CacheTtlConfig;
  /** Configuração do circuit breaker */
  circuitBreaker?: CircuitBreakerConfig;
}
