// Module
export { CacheModule, CACHE_TTL_CONFIG, CACHE_FEATURE_CONFIG } from './cache.module';

// Interfaces & Types
export {
  ICacheService,
  CachedValue,
  CacheMetrics,
  CacheHealth,
  CircuitState,
} from './interfaces/cache-service.interface';

export {
  CacheModuleOptions,
  CacheTtlConfig,
  CacheFeatureConfig,
  CircuitBreakerConfig,
} from './interfaces/cache-module-options.interface';

// Config & Constants (CACHE_SERVICE DI token lives here)
export * from './config';

// Errors
export * from './errors';

// Services
export { CacheKeyBuilder } from './services/cache-key-builder.service';
export { CircuitBreakerService } from './services/circuit-breaker.service';
export { CacheMetricsCollector } from './services/cache-metrics-collector.service';
export { CacheService } from './services/cache.service';
