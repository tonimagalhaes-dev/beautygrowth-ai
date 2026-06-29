import { Injectable } from '@nestjs/common';
import {
  ICircuitBreaker,
  CircuitBreakerState,
  CircuitBreakerConfig,
} from '../interfaces/circuit-breaker.interface';

/**
 * Circuit Breaker Service for protecting against LangGraph Service failures.
 *
 * State Machine Transitions:
 *   CLOSED → OPEN: when failureCount >= failureThreshold
 *   OPEN → HALF_OPEN: after resetTimeout expires (checked on each execute call)
 *   HALF_OPEN → CLOSED: when successCount >= successThreshold
 *   HALF_OPEN → OPEN: on any failure
 *
 * Requirements: 2.1, 2.3, 2.4, 2.5, 2.7, 2.8, 2.9
 */
@Injectable()
export class CircuitBreakerService implements ICircuitBreaker {
  private state: CircuitBreakerState = 'CLOSED';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime: number | null = null;

  private readonly config: CircuitBreakerConfig;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = {
      failureThreshold: config?.failureThreshold ?? 5,
      successThreshold: config?.successThreshold ?? 3,
      timeout: config?.timeout ?? 30000,
      resetTimeout: config?.resetTimeout ?? 60000,
    };
  }

  /**
   * Execute a function with circuit breaker protection.
   *
   * - CLOSED: Executes fn with timeout. Success resets failure counter. Failure increments counter.
   * - OPEN: Checks if resetTimeout has passed → transitions to HALF_OPEN; otherwise returns fallback.
   * - HALF_OPEN: Executes fn. Success increments successCount (transitions to CLOSED at threshold).
   *             Failure transitions immediately back to OPEN.
   */
  async execute<T>(
    fn: () => Promise<T>,
    fallback: () => Promise<T>,
  ): Promise<T> {
    if (this.state === 'OPEN') {
      if (this.shouldAttemptReset()) {
        this.transitionTo('HALF_OPEN');
      } else {
        return fallback();
      }
    }

    try {
      const result = await this.executeWithTimeout(fn);
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      if (this.state === 'OPEN') {
        return fallback();
      }
      throw error;
    }
  }

  /**
   * Get the current state of the circuit breaker.
   */
  getState(): CircuitBreakerState {
    return this.state;
  }

  /**
   * Reset the circuit breaker to initial CLOSED state.
   */
  reset(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
  }

  /**
   * Execute function with configured timeout.
   * If the function takes longer than config.timeout, it counts as a failure.
   */
  private executeWithTimeout<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Circuit breaker timeout: exceeded ${this.config.timeout}ms`));
      }, this.config.timeout);

      fn()
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  /**
   * Handle a successful call.
   * - HALF_OPEN: increment successCount; if >= successThreshold, transition to CLOSED
   * - CLOSED: reset failure counter
   */
  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.config.successThreshold) {
        this.transitionTo('CLOSED');
        this.failureCount = 0;
        this.successCount = 0;
      }
    } else if (this.state === 'CLOSED') {
      this.failureCount = 0;
    }
  }

  /**
   * Handle a failed call.
   * - HALF_OPEN: immediately transition to OPEN
   * - CLOSED: increment failureCount; if >= failureThreshold, transition to OPEN
   */
  private onFailure(): void {
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      this.transitionTo('OPEN');
      this.successCount = 0;
    } else {
      this.failureCount++;
      if (this.failureCount >= this.config.failureThreshold) {
        this.transitionTo('OPEN');
        this.successCount = 0;
      }
    }
  }

  /**
   * Check if enough time has passed since the last failure to attempt a reset.
   */
  private shouldAttemptReset(): boolean {
    if (this.lastFailureTime === null) return false;
    return Date.now() - this.lastFailureTime >= this.config.resetTimeout;
  }

  /**
   * Transition to a new state. Only valid transitions are allowed:
   * CLOSED→OPEN, OPEN→HALF_OPEN, HALF_OPEN→CLOSED, HALF_OPEN→OPEN
   */
  private transitionTo(newState: CircuitBreakerState): void {
    const validTransitions: Record<CircuitBreakerState, CircuitBreakerState[]> = {
      CLOSED: ['OPEN'],
      OPEN: ['HALF_OPEN'],
      HALF_OPEN: ['CLOSED', 'OPEN'],
    };

    if (!validTransitions[this.state].includes(newState)) {
      throw new Error(
        `Invalid circuit breaker transition: ${this.state} → ${newState}`,
      );
    }

    this.state = newState;
  }
}
