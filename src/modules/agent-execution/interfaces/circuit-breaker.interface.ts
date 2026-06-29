/**
 * Circuit Breaker interfaces for resilience against LangGraph Service failures.
 * Implements state machine with transitions: CLOSED→OPEN, OPEN→HALF_OPEN, HALF_OPEN→CLOSED, HALF_OPEN→OPEN.
 *
 * Requirements: 2.1, 2.3, 2.4, 2.5, 2.7, 2.8, 2.9
 */

/**
 * Valid states for the Circuit Breaker state machine.
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Failures exceeded threshold, requests go to fallback
 * - HALF_OPEN: Testing if service recovered, allows limited requests
 */
export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Circuit Breaker interface for protecting against downstream service failures.
 */
export interface ICircuitBreaker {
  /**
   * Execute a function with circuit breaker protection.
   * In CLOSED/HALF_OPEN states: attempts fn(), falls back on failure (when circuit opens).
   * In OPEN state: immediately executes fallback without trying fn.
   *
   * @param fn - The primary function to execute
   * @param fallback - The fallback function when circuit is open
   * @returns The result from either fn or fallback
   */
  execute<T>(fn: () => Promise<T>, fallback: () => Promise<T>): Promise<T>;

  /**
   * Get the current state of the circuit breaker.
   */
  getState(): CircuitBreakerState;

  /**
   * Reset the circuit breaker to CLOSED state with all counters zeroed.
   */
  reset(): void;
}

/**
 * Configuration for the Circuit Breaker.
 */
export interface CircuitBreakerConfig {
  /** Number of consecutive failures before opening the circuit (default: 5) */
  failureThreshold: number;
  /** Number of successes in HALF_OPEN before closing the circuit (default: 3) */
  successThreshold: number;
  /** Per-request timeout in milliseconds (default: 30000) */
  timeout: number;
  /** Time in ms before transitioning from OPEN to HALF_OPEN (default: 60000) */
  resetTimeout: number;
}
