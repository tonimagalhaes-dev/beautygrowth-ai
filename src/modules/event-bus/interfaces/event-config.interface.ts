/**
 * Configuration interfaces for the Event Bus module.
 *
 * Defines the declarative event configuration schema, consumer options,
 * and module initialization options.
 */

import { Type } from '@nestjs/common';

import { EventPriority } from './event-bus.interface';

// ─── Event Configuration ─────────────────────────────────────────────────────

/**
 * Configuração declarativa de um evento de domínio no EventRegistry.
 * Novos eventos são adicionados ao registro sem alteração do core do módulo.
 */
export interface EventConfig {
  /** Nome do evento (ex: 'tenant.created') */
  name: string;
  /** Prioridade padrão: 1 (alta), 5 (média), 10 (baixa) */
  priority: EventPriority;
  /** Número máximo de tentativas antes de mover para DLQ */
  maxRetries: number;
  /** TTL do job em ms (default: 24h = 86400000) */
  ttl?: number;
  /** Workers simultâneos para processar este evento */
  concurrency: number;
  /** Emitir também via EventEmitter2 durante período de transição */
  dualEmit: boolean;
  /** Classe class-validator para validação do payload */
  payloadSchema: Type<any>;
}

// ─── Consumer Options ────────────────────────────────────────────────────────

/**
 * Opções para o decorator @OnDistributedEvent e registro programático.
 */
export interface ConsumerOptions {
  /** Workers paralelos para este handler */
  concurrency?: number;
  /** Ativa rate limiting por tenant (default: true) */
  groupByTenant?: boolean;
}

// ─── Module Options ──────────────────────────────────────────────────────────

/**
 * Opções de inicialização do EventBusModule via forRoot().
 */
export interface EventBusModuleOptions {
  /** Habilita/desabilita o event bus distribuído (default: true) */
  enabled?: boolean;
  /** URL de conexão Redis (default: redis://localhost:6379) */
  redisUrl?: string;
  /** Prefixo para chaves Redis (default: 'beautygrowth:events:') */
  prefix?: string;
}
