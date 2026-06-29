import { Injectable, Logger } from '@nestjs/common';

import {
  BASE_RETRY_DELAY_MS,
  CONNECTION_BUFFER_TTL_MS,
  MAX_RECONNECT_DELAY_MS,
} from '../config/event-bus.constants';
import { PublishOptions } from '../interfaces/event-bus.interface';

/**
 * Represents an event stored in the local buffer while Redis is disconnected.
 */
export interface BufferedEvent {
  eventName: string;
  payload: Record<string, any>;
  options?: PublishOptions;
  bufferedAt: number;
}

/**
 * Callback used by flush() to enqueue buffered events when connection is restored.
 */
export type FlushCallback = (event: BufferedEvent) => Promise<void>;

/**
 * Buffer local que armazena eventos quando a conexão Redis é perdida.
 * Drena automaticamente quando a conexão é restaurada.
 *
 * Comportamento:
 * - DISCONNECTED (< 30s): armazena eventos no buffer local
 * - DISCONNECTED (> 30s): descarta eventos expirados com log WARN
 * - Ao reconectar: flush do buffer (FIFO) via callback
 * - Reconexão automática com backoff: 1s, 2s, 4s, 8s, 16s
 */
@Injectable()
export class ConnectionBuffer {
  private readonly logger = new Logger(ConnectionBuffer.name);
  private buffer: BufferedEvent[] = [];
  private reconnectAttempt = 0;

  /**
   * Armazena evento no buffer local.
   * Chamado quando a conexão Redis está indisponível.
   */
  bufferEvent(event: BufferedEvent): void {
    this.buffer.push(event);
    this.logger.debug(
      `Event buffered: ${event.eventName} (buffer size: ${this.buffer.length})`,
    );
  }

  /**
   * Drena buffer enviando eventos para Redis via callback (FIFO).
   * Remove cada evento do buffer após envio com sucesso.
   */
  async flush(callback: FlushCallback): Promise<void> {
    const eventsToFlush = [...this.buffer];
    this.buffer = [];

    this.logger.log(
      `Flushing ${eventsToFlush.length} buffered events to Redis`,
    );

    for (const event of eventsToFlush) {
      try {
        await callback(event);
      } catch (error) {
        // Re-buffer events that failed to flush
        this.buffer.push(event);
        this.logger.error(
          `Failed to flush event ${event.eventName}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (this.buffer.length > 0) {
      this.logger.warn(
        `${this.buffer.length} events could not be flushed and remain in buffer`,
      );
    }
  }

  /**
   * Remove eventos que excederam o TTL de 30s.
   * Eventos expirados são descartados com log WARN.
   */
  pruneExpired(): void {
    const now = Date.now();
    const expiredCount = this.buffer.filter(
      (event) => now - event.bufferedAt >= CONNECTION_BUFFER_TTL_MS,
    ).length;

    if (expiredCount > 0) {
      this.buffer = this.buffer.filter(
        (event) => now - event.bufferedAt < CONNECTION_BUFFER_TTL_MS,
      );
      this.logger.warn(
        `Pruned ${expiredCount} expired events from buffer (TTL: ${CONNECTION_BUFFER_TTL_MS}ms)`,
      );
    }
  }

  /**
   * Verifica se algum evento no buffer excedeu o TTL de 30s.
   */
  isBufferExpired(): boolean {
    const now = Date.now();
    return this.buffer.some(
      (event) => now - event.bufferedAt >= CONNECTION_BUFFER_TTL_MS,
    );
  }

  /**
   * Calcula delay de reconexão com exponential backoff.
   * Fórmula: min(BASE_RETRY_DELAY_MS * 2^attempt, MAX_RECONNECT_DELAY_MS)
   * Sequência: 1s, 2s, 4s, 8s, 16s (capped)
   */
  getReconnectDelay(): number {
    return Math.min(
      BASE_RETRY_DELAY_MS * Math.pow(2, this.reconnectAttempt),
      MAX_RECONNECT_DELAY_MS,
    );
  }

  /**
   * Incrementa o contador de tentativas de reconexão.
   * Chamado quando uma tentativa de reconexão falha.
   */
  incrementReconnectAttempt(): void {
    this.reconnectAttempt++;
  }

  /**
   * Reseta o contador de tentativas de reconexão.
   * Chamado quando a reconexão é bem-sucedida.
   */
  resetReconnectAttempt(): void {
    this.reconnectAttempt = 0;
  }

  /**
   * Retorna o número atual de eventos no buffer.
   */
  getBufferSize(): number {
    return this.buffer.length;
  }

  /**
   * Retorna o número atual de tentativas de reconexão.
   */
  getReconnectAttemptCount(): number {
    return this.reconnectAttempt;
  }
}
