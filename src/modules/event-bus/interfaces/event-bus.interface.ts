/**
 * Core interfaces and types for the Distributed Event Bus module.
 *
 * Defines the contract for event publishing, consuming, DLQ management,
 * replay, metrics and health monitoring.
 */

// ─── Priority ────────────────────────────────────────────────────────────────

/** Event priority levels: 1 (alta), 5 (média), 10 (baixa) */
export type EventPriority = 1 | 5 | 10;

// ─── Domain Event Payload ────────────────────────────────────────────────────

/** Base payload obrigatório para todos os eventos de domínio */
export interface DomainEventPayload {
  tenantId: string;
  timestamp?: Date;
  correlationId?: string;
}

// ─── Publish ─────────────────────────────────────────────────────────────────

export interface PublishOptions {
  /** Override da prioridade padrão do evento */
  priority?: EventPriority;
  /** Delay em ms antes de disponibilizar para consumo */
  delay?: number;
  /** Permite rastreamento externo */
  correlationId?: string;
}

export interface PublishResult {
  jobId: string;
  correlationId: string;
  queueName: string;
}

// ─── Subscribe ───────────────────────────────────────────────────────────────

export interface SubscribeOptions {
  /** Workers paralelos para este handler */
  concurrency?: number;
  /** Ativa rate limiting por tenant (default: true) */
  groupByTenant?: boolean;
}

// ─── Pagination ──────────────────────────────────────────────────────────────

export interface PaginationOptions {
  page: number;
  pageSize: number;
}

// ─── Dead Letter Queue ───────────────────────────────────────────────────────

export interface DLQItem {
  jobId: string;
  eventName: string;
  payload: Record<string, any>;
  failedAt: Date;
  attempts: number;
  errors: Array<{ attempt: number; error: string; timestamp: Date }>;
}

export interface PaginatedDLQResult {
  items: DLQItem[];
  total: number;
  page: number;
  pageSize: number;
}

// ─── Replay ──────────────────────────────────────────────────────────────────

export interface ReplayFilters {
  tenantId?: string;
  startDate?: Date;
  endDate?: Date;
  status?: 'success' | 'failed';
}

export interface ReplayResult {
  replayed: number;
  correlationIds: string[];
}

// ─── Metrics & Health ────────────────────────────────────────────────────────

export interface QueueSizeInfo {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
}

export interface EventBusMetrics {
  published: Record<string, number>;
  processed: Record<string, number>;
  failed: Record<string, number>;
  avgLatencyMs: Record<string, number>;
  queueSizes: Record<string, QueueSizeInfo>;
}

export interface EventBusHealth {
  redis: 'up' | 'down';
  queuesActive: number;
  workersActive: number;
  metrics5min: EventBusMetrics;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export type EventHandler<T = any> = (payload: T) => Promise<void>;

// ─── Service Interface ───────────────────────────────────────────────────────

/**
 * Contract principal do EventBusService.
 * Encapsula publicação, consumo, DLQ, replay e observabilidade.
 */
export interface IEventBusService {
  /**
   * Publica um evento de domínio no barramento distribuído.
   * Persiste no Redis antes de retornar confirmação.
   */
  publish<T extends DomainEventPayload>(
    eventName: string,
    payload: T,
    options?: PublishOptions,
  ): Promise<PublishResult>;

  /**
   * Registra um consumer para um evento específico (uso programático).
   * Preferir @OnDistributedEvent() para registro declarativo.
   */
  subscribe(
    eventName: string,
    handler: EventHandler,
    options?: SubscribeOptions,
  ): void;

  /** Reprocessa um evento específico da Dead Letter Queue */
  reprocessFromDLQ(eventName: string, jobId: string): Promise<void>;

  /** Lista eventos na DLQ com paginação */
  listDLQ(
    eventName: string,
    pagination: PaginationOptions,
  ): Promise<PaginatedDLQResult>;

  /** Republica eventos históricos filtrados */
  replay(eventName: string, filters: ReplayFilters): Promise<ReplayResult>;

  /** Retorna métricas agregadas do event bus */
  getMetrics(): Promise<EventBusMetrics>;

  /** Retorna status de saúde */
  getHealth(): Promise<EventBusHealth>;
}
