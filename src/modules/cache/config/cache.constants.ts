/**
 * Cache Module Constants
 *
 * Central configuration values for the distributed cache module.
 * All Redis keys are prefixed with CACHE_PREFIX to avoid collisions
 * with the event bus namespace ('beautygrowth:events:').
 */

/** Namespace prefix for all Redis keys used by the Cache Module */
export const CACHE_PREFIX = 'beautygrowth:cache:';

/** DI token for injecting the ICacheService implementation */
export const CACHE_SERVICE = Symbol('CACHE_SERVICE');

// ─── Default TTLs (seconds) ─────────────────────────────────────────────────

/** Default TTL for cache entries without specific configuration (5 min) */
export const DEFAULT_TTL = 300;

/** TTL for tenant-scoped guardrails cache (5 min) */
export const GUARDRAILS_TENANT_TTL = 300;

/** TTL for system-wide guardrails cache (10 min) */
export const GUARDRAILS_SYSTEM_TTL = 600;

/** TTL for prompt template cache (10 min) */
export const PROMPTS_TTL = 600;

// ─── Circuit Breaker Defaults ────────────────────────────────────────────────

/** Number of consecutive failures before the circuit opens */
export const DEFAULT_FAILURE_THRESHOLD = 3;

/** Time in ms to wait before attempting recovery (half-open state) */
export const DEFAULT_RECOVERY_TIMEOUT_MS = 30_000;
