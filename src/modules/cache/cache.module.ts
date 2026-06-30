import { DynamicModule, Global, Module, Provider } from '@nestjs/common';
import Redis from 'ioredis';

import {
  CacheModuleOptions,
  CacheFeatureConfig,
  CacheTtlConfig,
} from './interfaces/cache-module-options.interface';
import {
  CACHE_PREFIX,
  CACHE_SERVICE,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_RECOVERY_TIMEOUT_MS,
  DEFAULT_TTL,
  GUARDRAILS_SYSTEM_TTL,
  GUARDRAILS_TENANT_TTL,
  PROMPTS_TTL,
} from './config/cache.constants';
import { REDIS_CLIENT } from './config/cache.tokens';
import { CacheService } from './services/cache.service';
import { CircuitBreakerService } from './services/circuit-breaker.service';
import { CacheMetricsCollector } from './services/cache-metrics-collector.service';
import { CacheKeyBuilder } from './services/cache-key-builder.service';

/**
 * Token de DI para a configuração de TTL do módulo.
 */
export const CACHE_TTL_CONFIG = Symbol('CACHE_TTL_CONFIG');

/**
 * Token de DI para configuração de feature (forFeature).
 */
export const CACHE_FEATURE_CONFIG = Symbol('CACHE_FEATURE_CONFIG');

/**
 * CacheModule — Módulo dinâmico global para cache distribuído via Redis.
 *
 * Uso:
 * - `CacheModule.forRoot(options?)` — registro global, cria conexão Redis e serviços core
 * - `CacheModule.forFeature(config)` — registro de configuração TTL específica para um feature module
 *
 * @see Requirements 1.3, 6.1, 6.4, 6.5
 */
@Global()
@Module({})
export class CacheModule {
  /**
   * Registro global do módulo com configuração completa.
   * Cria a conexão Redis e registra todos os serviços internos.
   *
   * Providers registrados:
   * - REDIS_CLIENT: instância ioredis conectada
   * - CircuitBreakerService: circuit breaker configurável
   * - CacheMetricsCollector: coletor de métricas
   * - CacheKeyBuilder: builder de chaves com namespace
   * - CacheService / CACHE_SERVICE: serviço principal de cache
   * - CACHE_TTL_CONFIG: configuração de TTL resolvida (env vars + options)
   */
  static forRoot(options?: CacheModuleOptions): DynamicModule {
    const redisProvider: Provider = {
      provide: REDIS_CLIENT,
      useFactory: () => {
        const host =
          options?.redis?.host ??
          process.env.REDIS_HOST ??
          'localhost';
        const port =
          options?.redis?.port ??
          (Number(process.env.REDIS_PORT) || 6379);

        return new Redis({ host, port, maxRetriesPerRequest: 3 });
      },
    };

    const circuitBreakerProvider: Provider = {
      provide: CircuitBreakerService,
      useFactory: () => {
        const threshold =
          options?.circuitBreaker?.failureThreshold ??
          DEFAULT_FAILURE_THRESHOLD;
        const recoveryTimeout =
          options?.circuitBreaker?.recoveryTimeout ??
          DEFAULT_RECOVERY_TIMEOUT_MS;

        return new CircuitBreakerService(threshold, recoveryTimeout);
      },
    };

    const metricsProvider: Provider = {
      provide: CacheMetricsCollector,
      useClass: CacheMetricsCollector,
    };

    const keyBuilderProvider: Provider = {
      provide: CacheKeyBuilder,
      useFactory: () => {
        const prefix = options?.prefix ?? CACHE_PREFIX;
        return new CacheKeyBuilder(prefix);
      },
    };

    const ttlConfigProvider: Provider = {
      provide: CACHE_TTL_CONFIG,
      useFactory: (): CacheTtlConfig => {
        return {
          guardrails_tenant: Number(
            process.env.CACHE_TTL_GUARDRAILS_TENANT ??
              options?.ttlConfig?.guardrails_tenant ??
              GUARDRAILS_TENANT_TTL,
          ),
          guardrails_system: Number(
            process.env.CACHE_TTL_GUARDRAILS_SYSTEM ??
              options?.ttlConfig?.guardrails_system ??
              GUARDRAILS_SYSTEM_TTL,
          ),
          prompts: Number(
            process.env.CACHE_TTL_PROMPTS ??
              options?.ttlConfig?.prompts ??
              PROMPTS_TTL,
          ),
          default: Number(
            process.env.CACHE_TTL_DEFAULT ??
              options?.ttlConfig?.default ??
              options?.defaultTtl ??
              DEFAULT_TTL,
          ),
        };
      },
    };

    const cacheServiceProvider: Provider = {
      provide: CACHE_SERVICE,
      useExisting: CacheService,
    };

    return {
      module: CacheModule,
      providers: [
        redisProvider,
        circuitBreakerProvider,
        metricsProvider,
        keyBuilderProvider,
        ttlConfigProvider,
        CacheService,
        cacheServiceProvider,
      ],
      exports: [
        CACHE_SERVICE,
        CacheService,
        CacheKeyBuilder,
        CacheMetricsCollector,
        CircuitBreakerService,
        REDIS_CLIENT,
        CACHE_TTL_CONFIG,
      ],
      global: true,
    };
  }

  /**
   * Registro em feature modules que precisam de configuração de TTL
   * específica para seu domínio (ex: guardrails, prompts).
   *
   * Registra um provider com token `CACHE_FEATURE_CONFIG` contendo
   * o nome do recurso e TTL override para o módulo consumidor.
   */
  static forFeature(config: CacheFeatureConfig): DynamicModule {
    const featureConfigProvider: Provider = {
      provide: CACHE_FEATURE_CONFIG,
      useValue: config,
    };

    return {
      module: CacheModule,
      providers: [featureConfigProvider],
      exports: [featureConfigProvider],
    };
  }
}
