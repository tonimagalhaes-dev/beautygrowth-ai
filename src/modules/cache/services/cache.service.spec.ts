import { CacheService } from './cache.service';
import { CircuitBreakerService } from './circuit-breaker.service';
import { CacheMetricsCollector } from './cache-metrics-collector.service';
import { CacheKeyBuilder } from './cache-key-builder.service';
import { CircuitState } from '../interfaces/cache-service.interface';

describe('CacheService', () => {
  let cacheService: CacheService;
  let redisMock: Record<string, jest.Mock>;
  let circuitBreaker: CircuitBreakerService;
  let metricsCollector: CacheMetricsCollector;
  let keyBuilder: CacheKeyBuilder;

  beforeEach(() => {
    redisMock = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
      exists: jest.fn(),
      scan: jest.fn(),
    };

    circuitBreaker = new CircuitBreakerService(3, 30_000);
    metricsCollector = new CacheMetricsCollector();
    keyBuilder = new CacheKeyBuilder();

    cacheService = new CacheService(
      redisMock as any,
      circuitBreaker,
      metricsCollector,
      keyBuilder,
    );
  });

  // ─── get() ─────────────────────────────────────────────────────────────────

  describe('get()', () => {
    it('should return deserialized data on cache hit', async () => {
      const envelope = {
        v: 1,
        data: { name: 'Test', value: 42 },
        storedAt: new Date().toISOString(),
        resourceType: 'guardrails',
      };
      redisMock.get.mockResolvedValue(JSON.stringify(envelope));

      const result = await cacheService.get<{ name: string; value: number }>(
        'beautygrowth:cache:tenant:550e8400-e29b-41d4-a716-446655440000:guardrails:active',
      );

      expect(result).toEqual({ name: 'Test', value: 42 });
    });

    it('should return null on cache miss', async () => {
      redisMock.get.mockResolvedValue(null);

      const result = await cacheService.get(
        'beautygrowth:cache:tenant:550e8400-e29b-41d4-a716-446655440000:guardrails:active',
      );

      expect(result).toBeNull();
    });

    it('should return null when circuit is OPEN (bypass mode)', async () => {
      // Force circuit to OPEN state
      jest
        .spyOn(circuitBreaker, 'execute')
        .mockResolvedValue(null);
      jest
        .spyOn(circuitBreaker, 'getState')
        .mockReturnValue(CircuitState.OPEN);

      const result = await cacheService.get(
        'beautygrowth:cache:tenant:550e8400-e29b-41d4-a716-446655440000:guardrails:active',
      );

      expect(result).toBeNull();
    });

    it('should return null and record miss on deserialization error', async () => {
      redisMock.get.mockResolvedValue('not-valid-json{{{');
      const recordMissSpy = jest.spyOn(metricsCollector, 'recordMiss');

      const result = await cacheService.get(
        'beautygrowth:cache:tenant:550e8400-e29b-41d4-a716-446655440000:guardrails:active',
      );

      expect(result).toBeNull();
      expect(recordMissSpy).toHaveBeenCalledWith('guardrails');
    });

    it('should deserialize complex nested objects correctly', async () => {
      const complexData = {
        users: [
          { id: 1, name: 'Alice', roles: ['admin', 'user'] },
          { id: 2, name: 'Bob', roles: ['user'] },
        ],
        metadata: { page: 1, total: 100, nested: { deep: true } },
      };
      const envelope = {
        v: 1,
        data: complexData,
        storedAt: new Date().toISOString(),
        resourceType: 'guardrails',
      };
      redisMock.get.mockResolvedValue(JSON.stringify(envelope));

      const result = await cacheService.get(
        'beautygrowth:cache:tenant:550e8400-e29b-41d4-a716-446655440000:guardrails:list',
      );

      expect(result).toEqual(complexData);
    });
  });

  // ─── set() ─────────────────────────────────────────────────────────────────

  describe('set()', () => {
    it('should store value with CachedValue envelope and correct TTL', async () => {
      redisMock.set.mockResolvedValue('OK');

      await cacheService.set(
        'beautygrowth:cache:tenant:550e8400-e29b-41d4-a716-446655440000:guardrails:active',
        { enabled: true },
        120,
      );

      expect(redisMock.set).toHaveBeenCalledWith(
        'beautygrowth:cache:tenant:550e8400-e29b-41d4-a716-446655440000:guardrails:active',
        expect.any(String),
        'EX',
        120,
      );

      // Verify envelope structure
      const storedJson = redisMock.set.mock.calls[0][1];
      const envelope = JSON.parse(storedJson);
      expect(envelope.v).toBe(1);
      expect(envelope.data).toEqual({ enabled: true });
      expect(envelope.storedAt).toBeDefined();
      expect(envelope.resourceType).toBe('guardrails');
    });

    it('should use default TTL when no TTL is provided', async () => {
      redisMock.set.mockResolvedValue('OK');

      await cacheService.set(
        'beautygrowth:cache:global:prompts:template-1',
        { template: 'Hello {{name}}' },
      );

      // prompts resource type resolves to 600
      expect(redisMock.set).toHaveBeenCalledWith(
        'beautygrowth:cache:global:prompts:template-1',
        expect.any(String),
        'EX',
        600,
      );
    });

    it('should be a no-op when circuit is OPEN', async () => {
      jest
        .spyOn(circuitBreaker, 'execute')
        .mockResolvedValue(undefined as unknown as void);

      await cacheService.set(
        'beautygrowth:cache:tenant:550e8400-e29b-41d4-a716-446655440000:guardrails:active',
        { enabled: true },
        60,
      );

      // Redis.set should NOT have been called directly since circuit breaker handles it
      expect(redisMock.set).not.toHaveBeenCalled();
    });

    it('should handle serialization error gracefully', async () => {
      // Circular reference object causes JSON.stringify to throw
      const circular: any = {};
      circular.self = circular;

      await expect(
        cacheService.set(
          'beautygrowth:cache:tenant:550e8400-e29b-41d4-a716-446655440000:guardrails:active',
          circular,
          60,
        ),
      ).resolves.toBeUndefined();

      // Redis should not be called when serialization fails
      expect(redisMock.set).not.toHaveBeenCalled();
    });
  });

  // ─── delete() ──────────────────────────────────────────────────────────────

  describe('delete()', () => {
    it('should delete the specified key', async () => {
      redisMock.del.mockResolvedValue(1);

      await cacheService.delete(
        'beautygrowth:cache:tenant:550e8400-e29b-41d4-a716-446655440000:guardrails:active',
      );

      expect(redisMock.del).toHaveBeenCalledWith(
        'beautygrowth:cache:tenant:550e8400-e29b-41d4-a716-446655440000:guardrails:active',
      );
    });

    it('should be idempotent - no error when key does not exist', async () => {
      redisMock.del.mockResolvedValue(0);

      await expect(
        cacheService.delete('beautygrowth:cache:tenant:550e8400-e29b-41d4-a716-446655440000:guardrails:missing'),
      ).resolves.toBeUndefined();
    });

    it('should be a no-op when circuit is OPEN', async () => {
      jest
        .spyOn(circuitBreaker, 'execute')
        .mockResolvedValue(undefined as unknown as void);

      await cacheService.delete(
        'beautygrowth:cache:tenant:550e8400-e29b-41d4-a716-446655440000:guardrails:active',
      );

      expect(redisMock.del).not.toHaveBeenCalled();
    });
  });

  // ─── deleteByPattern() ─────────────────────────────────────────────────────

  describe('deleteByPattern()', () => {
    it('should use SCAN iteratively and return count of deleted keys', async () => {
      // Simulate a single SCAN iteration that finds 2 keys then cursor '0' (done)
      redisMock.scan.mockResolvedValue(['0', ['key1', 'key2']]);
      redisMock.del.mockResolvedValue(2);

      const count = await cacheService.deleteByPattern(
        'beautygrowth:cache:tenant:550e8400-e29b-41d4-a716-446655440000:*',
      );

      expect(count).toBe(2);
      expect(redisMock.scan).toHaveBeenCalledWith(
        '0',
        'MATCH',
        'beautygrowth:cache:tenant:550e8400-e29b-41d4-a716-446655440000:*',
        'COUNT',
        100,
      );
      expect(redisMock.del).toHaveBeenCalledWith('key1', 'key2');
    });

    it('should handle multiple SCAN iterations', async () => {
      // First iteration returns cursor '5' (not done) with 2 keys
      // Second iteration returns cursor '0' (done) with 1 key
      redisMock.scan
        .mockResolvedValueOnce(['5', ['key1', 'key2']])
        .mockResolvedValueOnce(['0', ['key3']]);
      redisMock.del.mockResolvedValue(1);

      const count = await cacheService.deleteByPattern(
        'beautygrowth:cache:tenant:550e8400-e29b-41d4-a716-446655440000:*',
      );

      expect(count).toBe(3);
      expect(redisMock.scan).toHaveBeenCalledTimes(2);
    });

    it('should return 0 when circuit is OPEN (bypass)', async () => {
      jest.spyOn(circuitBreaker, 'execute').mockResolvedValue(0);

      const count = await cacheService.deleteByPattern(
        'beautygrowth:cache:tenant:550e8400-e29b-41d4-a716-446655440000:*',
      );

      expect(count).toBe(0);
      expect(redisMock.scan).not.toHaveBeenCalled();
    });

    it('should prepend CACHE_PREFIX if pattern does not start with it', async () => {
      redisMock.scan.mockResolvedValue(['0', []]);

      await cacheService.deleteByPattern('tenant:abc:*');

      expect(redisMock.scan).toHaveBeenCalledWith(
        '0',
        'MATCH',
        'beautygrowth:cache:tenant:abc:*',
        'COUNT',
        100,
      );
    });
  });

  // ─── exists() ──────────────────────────────────────────────────────────────

  describe('exists()', () => {
    it('should return true when key exists', async () => {
      redisMock.exists.mockResolvedValue(1);

      const result = await cacheService.exists(
        'beautygrowth:cache:tenant:550e8400-e29b-41d4-a716-446655440000:guardrails:active',
      );

      expect(result).toBe(true);
    });

    it('should return false when key does not exist', async () => {
      redisMock.exists.mockResolvedValue(0);

      const result = await cacheService.exists(
        'beautygrowth:cache:tenant:550e8400-e29b-41d4-a716-446655440000:guardrails:missing',
      );

      expect(result).toBe(false);
    });

    it('should return false when circuit is OPEN (bypass)', async () => {
      jest.spyOn(circuitBreaker, 'execute').mockResolvedValue(false);

      const result = await cacheService.exists(
        'beautygrowth:cache:tenant:550e8400-e29b-41d4-a716-446655440000:guardrails:active',
      );

      expect(result).toBe(false);
      expect(redisMock.exists).not.toHaveBeenCalled();
    });
  });

  // ─── getMetrics() and getHealth() ──────────────────────────────────────────

  describe('getMetrics() and getHealth()', () => {
    it('should delegate getMetrics() to CacheMetricsCollector', () => {
      const spy = jest.spyOn(metricsCollector, 'getMetrics');

      cacheService.getMetrics();

      expect(spy).toHaveBeenCalled();
    });

    it('should return correct redis status "up" when circuit is CLOSED', () => {
      jest.spyOn(circuitBreaker, 'getState').mockReturnValue(CircuitState.CLOSED);

      const health = cacheService.getHealth();

      expect(health.redis).toBe('up');
      expect(health.circuitState).toBe(CircuitState.CLOSED);
    });

    it('should return correct redis status "circuit-open" when circuit is OPEN', () => {
      jest.spyOn(circuitBreaker, 'getState').mockReturnValue(CircuitState.OPEN);

      const health = cacheService.getHealth();

      expect(health.redis).toBe('circuit-open');
      expect(health.circuitState).toBe(CircuitState.OPEN);
    });

    it('should return correct redis status "down" when circuit is HALF_OPEN', () => {
      jest.spyOn(circuitBreaker, 'getState').mockReturnValue(CircuitState.HALF_OPEN);

      const health = cacheService.getHealth();

      expect(health.redis).toBe('down');
      expect(health.circuitState).toBe(CircuitState.HALF_OPEN);
    });

    it('should include ttlConfig and uptimeMs in health', () => {
      const health = cacheService.getHealth();

      expect(health.ttlConfig).toBeDefined();
      expect(health.ttlConfig.default).toBe(300);
      expect(health.uptimeMs).toBeGreaterThanOrEqual(0);
    });
  });
});
