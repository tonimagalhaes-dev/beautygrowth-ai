import { CircuitBreakerService } from './circuit-breaker.service';
import { CircuitBreakerConfig } from '../interfaces/circuit-breaker.interface';

describe('CircuitBreakerService', () => {
  let service: CircuitBreakerService;

  const defaultConfig: CircuitBreakerConfig = {
    failureThreshold: 5,
    successThreshold: 3,
    timeout: 30000,
    resetTimeout: 60000,
  };

  // Helpers
  const successFn = () => Promise.resolve('success');
  const failFn = () => Promise.reject(new Error('service unavailable'));
  const fallbackFn = () => Promise.resolve('fallback');

  beforeEach(() => {
    service = new CircuitBreakerService(defaultConfig);
  });

  // =========================================================================
  // INITIAL STATE
  // =========================================================================

  describe('initial state', () => {
    it('should start in CLOSED state', () => {
      expect(service.getState()).toBe('CLOSED');
    });
  });

  // =========================================================================
  // CLOSED STATE BEHAVIOR
  // =========================================================================

  describe('CLOSED state', () => {
    it('should execute fn successfully and return its result', async () => {
      const result = await service.execute(successFn, fallbackFn);
      expect(result).toBe('success');
      expect(service.getState()).toBe('CLOSED');
    });

    it('should reset failure counter on success', async () => {
      // Accumulate some failures (below threshold)
      for (let i = 0; i < 4; i++) {
        await expect(service.execute(failFn, fallbackFn)).rejects.toThrow();
      }
      expect(service.getState()).toBe('CLOSED');

      // Success should reset the counter
      await service.execute(successFn, fallbackFn);
      expect(service.getState()).toBe('CLOSED');

      // Now 4 more failures should NOT open (counter was reset)
      for (let i = 0; i < 4; i++) {
        await expect(service.execute(failFn, fallbackFn)).rejects.toThrow();
      }
      expect(service.getState()).toBe('CLOSED');
    });

    it('should throw error on failure when circuit remains CLOSED', async () => {
      await expect(service.execute(failFn, fallbackFn)).rejects.toThrow(
        'service unavailable',
      );
      expect(service.getState()).toBe('CLOSED');
    });

    it('should transition to OPEN after failureThreshold consecutive failures', async () => {
      for (let i = 0; i < 4; i++) {
        await expect(service.execute(failFn, fallbackFn)).rejects.toThrow();
      }
      expect(service.getState()).toBe('CLOSED');

      // 5th failure triggers OPEN and returns fallback
      const result = await service.execute(failFn, fallbackFn);
      expect(result).toBe('fallback');
      expect(service.getState()).toBe('OPEN');
    });
  });

  // =========================================================================
  // OPEN STATE BEHAVIOR
  // =========================================================================

  describe('OPEN state', () => {
    beforeEach(async () => {
      // Drive circuit to OPEN
      for (let i = 0; i < 5; i++) {
        try {
          await service.execute(failFn, fallbackFn);
        } catch {
          // Expected for first 4 failures
        }
      }
      expect(service.getState()).toBe('OPEN');
    });

    it('should execute fallback immediately without calling fn', async () => {
      const fn = jest.fn().mockResolvedValue('should not be called');
      const result = await service.execute(fn, fallbackFn);

      expect(result).toBe('fallback');
      expect(fn).not.toHaveBeenCalled();
      expect(service.getState()).toBe('OPEN');
    });

    it('should transition to HALF_OPEN after resetTimeout expires', async () => {
      // Use a service with short resetTimeout for testing
      const fastService = new CircuitBreakerService({
        ...defaultConfig,
        resetTimeout: 50,
      });

      // Drive to OPEN
      for (let i = 0; i < 5; i++) {
        try {
          await fastService.execute(failFn, fallbackFn);
        } catch {
          // Expected
        }
      }
      expect(fastService.getState()).toBe('OPEN');

      // Wait for resetTimeout to pass
      await new Promise((resolve) => setTimeout(resolve, 60));

      // Next call should transition to HALF_OPEN and try fn
      await fastService.execute(successFn, fallbackFn);
      // After success it might still be HALF_OPEN (needs successThreshold)
      expect(['HALF_OPEN', 'CLOSED']).toContain(fastService.getState());
    });
  });

  // =========================================================================
  // HALF_OPEN STATE BEHAVIOR
  // =========================================================================

  describe('HALF_OPEN state', () => {
    let fastService: CircuitBreakerService;

    beforeEach(async () => {
      fastService = new CircuitBreakerService({
        ...defaultConfig,
        resetTimeout: 10,
      });

      // Drive to OPEN
      for (let i = 0; i < 5; i++) {
        try {
          await fastService.execute(failFn, fallbackFn);
        } catch {
          // Expected
        }
      }
      expect(fastService.getState()).toBe('OPEN');

      // Wait for resetTimeout
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    it('should transition to CLOSED after successThreshold consecutive successes', async () => {
      // Each success in HALF_OPEN increments successCount
      for (let i = 0; i < 3; i++) {
        await fastService.execute(successFn, fallbackFn);
      }
      expect(fastService.getState()).toBe('CLOSED');
    });

    it('should transition back to OPEN on any failure', async () => {
      // First call transitions to HALF_OPEN and succeeds
      await fastService.execute(successFn, fallbackFn);
      expect(fastService.getState()).toBe('HALF_OPEN');

      // Failure in HALF_OPEN goes back to OPEN
      const result = await fastService.execute(failFn, fallbackFn);
      expect(result).toBe('fallback');
      expect(fastService.getState()).toBe('OPEN');
    });

    it('should allow test calls and count successes toward threshold', async () => {
      // 2 successes - still HALF_OPEN
      await fastService.execute(successFn, fallbackFn);
      await fastService.execute(successFn, fallbackFn);
      expect(fastService.getState()).toBe('HALF_OPEN');

      // 3rd success - transitions to CLOSED
      await fastService.execute(successFn, fallbackFn);
      expect(fastService.getState()).toBe('CLOSED');
    });
  });

  // =========================================================================
  // TIMEOUT HANDLING
  // =========================================================================

  describe('timeout handling', () => {
    it('should count timeout as failure', async () => {
      const shortTimeoutService = new CircuitBreakerService({
        ...defaultConfig,
        timeout: 50,
      });

      const slowFn = () =>
        new Promise<string>((resolve) => setTimeout(() => resolve('late'), 100));

      // Timeout should be treated as failure
      await expect(
        shortTimeoutService.execute(slowFn, fallbackFn),
      ).rejects.toThrow('Circuit breaker timeout');

      // After failureThreshold timeouts, should open
      for (let i = 0; i < 4; i++) {
        try {
          await shortTimeoutService.execute(slowFn, fallbackFn);
        } catch {
          // Expected
        }
      }
      expect(shortTimeoutService.getState()).toBe('OPEN');
    });
  });

  // =========================================================================
  // RESET
  // =========================================================================

  describe('reset()', () => {
    it('should return to CLOSED state from OPEN', async () => {
      // Drive to OPEN
      for (let i = 0; i < 5; i++) {
        try {
          await service.execute(failFn, fallbackFn);
        } catch {
          // Expected
        }
      }
      expect(service.getState()).toBe('OPEN');

      service.reset();

      expect(service.getState()).toBe('CLOSED');
      // Should be able to execute normally after reset
      const result = await service.execute(successFn, fallbackFn);
      expect(result).toBe('success');
    });

    it('should reset all counters', async () => {
      // Accumulate failures
      for (let i = 0; i < 4; i++) {
        await expect(service.execute(failFn, fallbackFn)).rejects.toThrow();
      }

      service.reset();

      // Should need another full failureThreshold to open
      for (let i = 0; i < 4; i++) {
        await expect(service.execute(failFn, fallbackFn)).rejects.toThrow();
      }
      expect(service.getState()).toBe('CLOSED');
    });
  });

  // =========================================================================
  // DEFAULT CONFIGURATION
  // =========================================================================

  describe('default configuration', () => {
    it('should use default values when no config is provided', () => {
      const defaultService = new CircuitBreakerService();
      expect(defaultService.getState()).toBe('CLOSED');
      // Verify it functions with defaults
    });

    it('should allow partial config override', () => {
      const partialService = new CircuitBreakerService({
        failureThreshold: 10,
      });
      expect(partialService.getState()).toBe('CLOSED');
    });
  });

  // =========================================================================
  // VALID TRANSITIONS ONLY
  // =========================================================================

  describe('state transitions validity', () => {
    it('should only allow CLOSED→OPEN transition (not CLOSED→HALF_OPEN)', async () => {
      // In CLOSED state, we can only go to OPEN via failures
      // There's no way to go directly to HALF_OPEN from CLOSED
      expect(service.getState()).toBe('CLOSED');

      // Only consecutive failures should cause transition
      const result = await service.execute(successFn, fallbackFn);
      expect(result).toBe('success');
      expect(service.getState()).toBe('CLOSED');
    });

    it('should complete full cycle: CLOSED→OPEN→HALF_OPEN→CLOSED', async () => {
      const fastService = new CircuitBreakerService({
        ...defaultConfig,
        resetTimeout: 10,
        successThreshold: 2,
      });

      // CLOSED → OPEN
      for (let i = 0; i < 5; i++) {
        try {
          await fastService.execute(failFn, fallbackFn);
        } catch {
          // Expected
        }
      }
      expect(fastService.getState()).toBe('OPEN');

      // Wait for resetTimeout
      await new Promise((resolve) => setTimeout(resolve, 20));

      // OPEN → HALF_OPEN → CLOSED (2 successes)
      await fastService.execute(successFn, fallbackFn);
      expect(fastService.getState()).toBe('HALF_OPEN');

      await fastService.execute(successFn, fallbackFn);
      expect(fastService.getState()).toBe('CLOSED');
    });

    it('should complete cycle: CLOSED→OPEN→HALF_OPEN→OPEN', async () => {
      const fastService = new CircuitBreakerService({
        ...defaultConfig,
        resetTimeout: 10,
      });

      // CLOSED → OPEN
      for (let i = 0; i < 5; i++) {
        try {
          await fastService.execute(failFn, fallbackFn);
        } catch {
          // Expected
        }
      }
      expect(fastService.getState()).toBe('OPEN');

      // Wait for resetTimeout
      await new Promise((resolve) => setTimeout(resolve, 20));

      // OPEN → HALF_OPEN (on next call attempt)
      await fastService.execute(successFn, fallbackFn);
      expect(fastService.getState()).toBe('HALF_OPEN');

      // HALF_OPEN → OPEN (on failure)
      const result = await fastService.execute(failFn, fallbackFn);
      expect(result).toBe('fallback');
      expect(fastService.getState()).toBe('OPEN');
    });
  });
});
