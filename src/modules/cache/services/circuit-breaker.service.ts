import { Injectable } from '@nestjs/common';

import { CircuitState } from '../interfaces/cache-service.interface';
import {
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_RECOVERY_TIMEOUT_MS,
} from '../config/cache.constants';

/**
 * Circuit breaker para proteção contra falhas de conexão Redis.
 * Estados: CLOSED (normal) → OPEN (bypass) → HALF_OPEN (tentando reconexão)
 *
 * - CLOSED: operações normais, conta falhas consecutivas
 * - OPEN: rejeita operações retornando fallback, após recoveryTimeoutMs → HALF_OPEN
 * - HALF_OPEN: permite uma operação teste — sucesso → CLOSED, falha → OPEN
 */
@Injectable()
export class CircuitBreakerService {
  private state: CircuitState = CircuitState.CLOSED;
  private consecutiveFailures = 0;
  private lastFailureTime = 0;

  constructor(
    private readonly failureThreshold: number = DEFAULT_FAILURE_THRESHOLD,
    private readonly recoveryTimeoutMs: number = DEFAULT_RECOVERY_TIMEOUT_MS,
  ) {}

  /**
   * Retorna o estado atual do circuit breaker.
   * Se OPEN e o tempo de recuperação expirou, transiciona para HALF_OPEN.
   */
  getState(): CircuitState {
    if (this.state === CircuitState.OPEN) {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.recoveryTimeoutMs) {
        this.state = CircuitState.HALF_OPEN;
      }
    }
    return this.state;
  }

  /**
   * Executa uma operação protegida pelo circuit breaker.
   * - OPEN: retorna fallback imediatamente (sem I/O)
   * - CLOSED ou HALF_OPEN: tenta a operação
   *   - Sucesso → recordSuccess() → retorna resultado
   *   - Falha (exceção) → recordFailure() → retorna fallback
   */
  async execute<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
    const currentState = this.getState();

    if (currentState === CircuitState.OPEN) {
      return fallback;
    }

    try {
      const result = await operation();
      this.recordSuccess();
      return result;
    } catch {
      this.recordFailure();
      return fallback;
    }
  }

  /**
   * Registra uma operação bem-sucedida.
   * Reseta o contador de falhas consecutivas e transiciona para CLOSED.
   */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = CircuitState.CLOSED;
  }

  /**
   * Registra uma falha de operação.
   * Incrementa o contador de falhas consecutivas e registra o timestamp.
   * Se o threshold é atingido, transiciona para OPEN.
   */
  recordFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = CircuitState.OPEN;
    }
  }

  /**
   * Reseta o circuit breaker para o estado inicial CLOSED.
   */
  reset(): void {
    this.state = CircuitState.CLOSED;
    this.consecutiveFailures = 0;
  }
}
