import { CircuitBreakerService } from './circuit-breaker.service';
import { CircuitState } from '../interfaces/cache-service.interface';
import {
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_RECOVERY_TIMEOUT_MS,
} from '../config/cache.constants';

describe('CircuitBreakerService', () => {
  let circuitBreaker: CircuitBreakerService;

  beforeEach(() => {
    jest.useFakeTimers();
    circuitBreaker = new CircuitBreakerService();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('initial state', () => {
    it('should start in CLOSED state', () => {
      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should use default failure threshold of 3', () => {
      // 2 failures should not open
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);

      // 3rd failure opens it
      circuitBreaker.recordFailure();
      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);
    });

    it('should use default recovery timeout of 30000ms', () => {
      // Force open
      for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD; i++) {
        circuitBreaker.recordFailure();
      }
      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);

      // Advance less than 30s — still OPEN
      jest.advanceTimersByTime(DEFAULT_RECOVERY_TIMEOUT_MS - 1);
      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);

      // Advance to exactly 30s — transitions to HALF_OPEN
      jest.advanceTimersByTime(1);
      expect(circuitBreaker.getState()).toBe(CircuitState.HALF_OPEN);
    });
  });

  describe('CLOSED state', () => {
    it('should stay closed on successful operation', async () => {
      const result = await circuitBreaker.execute(
        () => Promise.resolve('ok'),
        'fallback',
      );

      expect(result).toBe('ok');
      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should stay closed on fewer than N failures', () => {
      for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD - 1; i++) {
        circuitBreaker.recordFailure();
      }
      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should transition to OPEN after N consecutive failures', () => {
      for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD; i++) {
        circuitBreaker.recordFailure();
      }
      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);
    });

    it('should transition to OPEN after N consecutive failures via execute()', async () => {
      const failingOp = () => Promise.reject(new Error('connection lost'));

      for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD; i++) {
        await circuitBreaker.execute(failingOp, 'fallback');
      }

      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);
    });

    it('should reset failure count on success between failures', () => {
      // 2 failures
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();

      // 1 success resets count
      circuitBreaker.recordSuccess();

      // 2 more failures — still not at threshold
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();

      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should reset failure count on success via execute()', async () => {
      const failingOp = () => Promise.reject(new Error('fail'));
      const successOp = () => Promise.resolve('ok');

      // 2 failures
      await circuitBreaker.execute(failingOp, 'fb');
      await circuitBreaker.execute(failingOp, 'fb');

      // Success resets
      await circuitBreaker.execute(successOp, 'fb');

      // 2 more failures — should still be CLOSED
      await circuitBreaker.execute(failingOp, 'fb');
      await circuitBreaker.execute(failingOp, 'fb');

      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
    });
  });

  describe('OPEN state', () => {
    beforeEach(() => {
      // Force circuit to OPEN
      for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD; i++) {
        circuitBreaker.recordFailure();
      }
    });

    it('should return fallback immediately without calling operation', async () => {
      const operation = jest.fn(() => Promise.resolve('real-value'));

      const result = await circuitBreaker.execute(operation, 'fallback-value');

      expect(result).toBe('fallback-value');
      expect(operation).not.toHaveBeenCalled();
    });

    it('should transition to HALF_OPEN after recovery timeout', () => {
      jest.advanceTimersByTime(DEFAULT_RECOVERY_TIMEOUT_MS);
      expect(circuitBreaker.getState()).toBe(CircuitState.HALF_OPEN);
    });

    it('should stay OPEN before recovery timeout has elapsed', () => {
      jest.advanceTimersByTime(DEFAULT_RECOVERY_TIMEOUT_MS - 1);
      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);
    });
  });

  describe('HALF_OPEN state', () => {
    beforeEach(() => {
      // Force circuit to OPEN, then advance time to HALF_OPEN
      for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD; i++) {
        circuitBreaker.recordFailure();
      }
      jest.advanceTimersByTime(DEFAULT_RECOVERY_TIMEOUT_MS);
      expect(circuitBreaker.getState()).toBe(CircuitState.HALF_OPEN);
    });

    it('should transition to CLOSED on successful operation', async () => {
      const result = await circuitBreaker.execute(
        () => Promise.resolve('recovered'),
        'fallback',
      );

      expect(result).toBe('recovered');
      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should transition to OPEN on failed operation', async () => {
      const result = await circuitBreaker.execute(
        () => Promise.reject(new Error('still failing')),
        'fallback',
      );

      expect(result).toBe('fallback');
      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);
    });

    it('should allow exactly one test operation through', async () => {
      const operation = jest.fn(() => Promise.resolve('test-result'));

      await circuitBreaker.execute(operation, 'fallback');

      expect(operation).toHaveBeenCalledTimes(1);
    });
  });

  describe('reset()', () => {
    it('should reset to CLOSED from OPEN state', () => {
      for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD; i++) {
        circuitBreaker.recordFailure();
      }
      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);

      circuitBreaker.reset();
      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should reset to CLOSED from HALF_OPEN state', () => {
      for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD; i++) {
        circuitBreaker.recordFailure();
      }
      jest.advanceTimersByTime(DEFAULT_RECOVERY_TIMEOUT_MS);
      expect(circuitBreaker.getState()).toBe(CircuitState.HALF_OPEN);

      circuitBreaker.reset();
      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should reset failure counter allowing fresh threshold', () => {
      // Accumulate failures but not enough to open
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();

      circuitBreaker.reset();

      // Now need full threshold to open again
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
    });
  });

  describe('custom configuration', () => {
    it('should respect custom failure threshold', () => {
      const customCb = new CircuitBreakerService(5, 10000);

      for (let i = 0; i < 4; i++) {
        customCb.recordFailure();
      }
      expect(customCb.getState()).toBe(CircuitState.CLOSED);

      customCb.recordFailure();
      expect(customCb.getState()).toBe(CircuitState.OPEN);
    });

    it('should respect custom recovery timeout', () => {
      const customCb = new CircuitBreakerService(2, 5000);

      customCb.recordFailure();
      customCb.recordFailure();
      expect(customCb.getState()).toBe(CircuitState.OPEN);

      jest.advanceTimersByTime(4999);
      expect(customCb.getState()).toBe(CircuitState.OPEN);

      jest.advanceTimersByTime(1);
      expect(customCb.getState()).toBe(CircuitState.HALF_OPEN);
    });
  });
});
