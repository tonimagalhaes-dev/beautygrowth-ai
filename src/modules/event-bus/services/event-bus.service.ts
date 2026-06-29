import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Queue, Worker } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';

import { EVENT_REGISTRY } from '../config/event-registry';
import { BASE_RETRY_DELAY_MS, REDIS_PREFIX } from '../config/event-bus.constants';
import {
  DLQItem,
  DomainEventPayload,
  EventBusHealth,
  EventBusMetrics,
  EventHandler,
  IEventBusService,
  PaginatedDLQResult,
  PaginationOptions,
  PublishOptions,
  PublishResult,
  ReplayFilters,
  ReplayResult,
  SubscribeOptions,
} from '../interfaces';
import { AuditService } from './audit.service';
import { ConnectionBuffer } from './connection-buffer.service';
import { MetricsCollector } from './metrics-collector.service';
import { PayloadValidator } from './payload-validator.service';

/**
 * Core EventBusService — orchestrates event publishing via BullMQ
 * with dual-emit support, payload validation, and connection resilience.
 *
 * Implements the IEventBusService interface. For this initial implementation,
 * only the `publish()` method is fully functional. Other methods (subscribe,
 * DLQ management, replay, metrics, health) are stubs for subsequent tasks.
 *
 * @see Requirements 1.1, 1.2, 1.7, 2.5, 4.4, 6.6, 8.5
 */
@Injectable()
export class EventBusService
  implements IEventBusService, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(EventBusService.name);
  private readonly queues: Map<string, Queue> = new Map();
  private readonly workers: Map<string, Worker> = new Map();
  private isConnected = true;
  private enabled = true;
  private redisHost = 'localhost';
  private redisPort = 6379;

  constructor(
    private readonly payloadValidator: PayloadValidator,
    private readonly connectionBuffer: ConnectionBuffer,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
    private readonly metricsCollector: MetricsCollector,
  ) {}

  async onModuleInit(): Promise<void> {
    const enabledConfig = this.configService.get<string>(
      'EVENT_BUS_ENABLED',
      'true',
    );

    if (enabledConfig === 'false') {
      this.enabled = false;
      this.logger.log(
        'Event Bus disabled — operating in fallback mode (EventEmitter2 only)',
      );
      return;
    }

    const redisHost = this.configService.get<string>('REDIS_HOST', 'localhost');
    const redisPort = this.configService.get<number>('REDIS_PORT', 6379);

    this.redisHost = redisHost;
    this.redisPort = redisPort;

    for (const config of EVENT_REGISTRY) {
      const queue = new Queue(config.name, {
        connection: { host: redisHost, port: redisPort },
        prefix: REDIS_PREFIX,
      });
      this.queues.set(config.name, queue);
    }

    this.logger.log(
      `Event Bus initialized with ${this.queues.size} queues (prefix: ${REDIS_PREFIX})`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    const workers = Array.from(this.workers.values());
    for (const worker of workers) {
      await worker.close();
    }
    this.workers.clear();

    const queues = Array.from(this.queues.values());
    for (const queue of queues) {
      await queue.close();
    }
    this.queues.clear();
  }

  /**
   * Publishes a domain event to the distributed event bus.
   *
   * Flow:
   * 1. Look up event config from EVENT_REGISTRY
   * 2. Validate payload using PayloadValidator
   * 3. Generate correlationId (UUID v4) if not provided
   * 4. If dualEmit enabled, emit synchronously via EventEmitter2
   * 5. If Redis connected, enqueue via BullMQ with priority/retry config
   * 6. If Redis disconnected, buffer event via ConnectionBuffer
   *
   * @see Requirements 1.1, 1.2, 1.7, 2.5, 4.4, 6.6, 8.5
   */
  async publish<T extends DomainEventPayload>(
    eventName: string,
    payload: T,
    options?: PublishOptions,
  ): Promise<PublishResult> {
    // 1. Look up config
    const eventConfig = EVENT_REGISTRY.find((e) => e.name === eventName);
    if (!eventConfig) {
      throw new Error(`Event '${eventName}' not found in registry`);
    }

    // 2. Validate payload
    await this.payloadValidator.validatePayload(
      eventName,
      payload as unknown as Record<string, any>,
    );

    // 3. Generate correlationId
    const correlationId = options?.correlationId ?? uuidv4();
    const enrichedPayload = {
      ...payload,
      correlationId,
      timestamp: payload.timestamp ?? new Date(),
    };

    // 4. Dual emit (synchronous, non-blocking for BullMQ path)
    if (eventConfig.dualEmit) {
      this.eventEmitter.emit(eventName, enrichedPayload);
    }

    // 5. Fallback mode — no queues created when EVENT_BUS_ENABLED=false
    const queue = this.queues.get(eventName);
    if (!queue) {
      // Fallback mode — event already emitted via EventEmitter2
      // Also emit via EventEmitter2 even if dualEmit is false when in fallback
      if (!eventConfig.dualEmit) {
        this.eventEmitter.emit(eventName, enrichedPayload);
      }
      return { jobId: 'fallback', correlationId, queueName: eventName };
    }

    // 6. Enqueue or buffer
    if (this.isConnected) {
      const job = await queue.add(eventName, enrichedPayload, {
        priority: options?.priority ?? eventConfig.priority,
        delay: options?.delay,
        attempts: eventConfig.maxRetries,
        backoff: { type: 'exponential', delay: BASE_RETRY_DELAY_MS },
        removeOnComplete: true,
        removeOnFail: false, // Keep in DLQ for inspection and reprocessing
      });

      return { jobId: job.id!, correlationId, queueName: eventName };
    } else {
      // Buffer for later flush when Redis reconnects
      this.connectionBuffer.bufferEvent({
        eventName,
        payload: enrichedPayload,
        options,
        bufferedAt: Date.now(),
      });
      return { jobId: 'buffered', correlationId, queueName: eventName };
    }
  }

  // ─── Connection state management ──────────────────────────────────────────

  /**
   * Updates the Redis connection state.
   * Called externally by connection monitoring logic.
   */
  setConnectionState(connected: boolean): void {
    this.isConnected = connected;
    if (connected) {
      this.logger.log('Redis connection restored');
    } else {
      this.logger.warn('Redis connection lost — buffering events locally');
    }
  }

  /**
   * Returns whether the event bus is currently connected to Redis.
   */
  getConnectionState(): boolean {
    return this.isConnected;
  }

  /**
   * Returns whether the event bus is enabled (not in fallback mode).
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  // ─── Stub methods for subsequent tasks ─────────────────────────────────────

  /**
   * Registers a programmatic consumer for a specific event.
   *
   * Creates a BullMQ Worker that processes jobs by:
   * - Extracting tenantId from payload for context isolation
   * - Calling the handler with the event payload
   * - Recording success/failure audit (non-blocking)
   * - Re-throwing errors to trigger BullMQ retry with exponential backoff
   *
   * Worker is configured with:
   * - Concurrency from options or EVENT_REGISTRY default
   * - Redis connection from ConfigService
   * - Prefix: REDIS_PREFIX for namespace isolation
   *
   * @see Requirements 1.1, 1.5, 5.2, 5.3, 5.5
   */
  subscribe(
    eventName: string,
    handler: EventHandler,
    options?: SubscribeOptions,
  ): void {
    const eventConfig = EVENT_REGISTRY.find((e) => e.name === eventName);
    if (!eventConfig) {
      throw new Error(`Event '${eventName}' not found in registry`);
    }

    // Fallback mode: register handler via EventEmitter2 instead of BullMQ Worker
    if (!this.enabled) {
      this.eventEmitter.on(eventName, handler);
      this.logger.log(
        `Fallback: registered '${eventName}' handler via EventEmitter2`,
      );
      return;
    }

    const concurrency = options?.concurrency ?? eventConfig.concurrency;

    const worker = new Worker(
      eventName,
      async (job) => {
        const payload = job.data;
        const startTime = Date.now();

        this.logger.log(
          JSON.stringify({
            eventName,
            tenantId: payload.tenantId,
            correlationId: payload.correlationId,
            status: 'processing',
            attempt: job.attemptsMade + 1,
            workerInstance: worker.id,
          }),
        );

        try {
          await handler(payload);

          const durationMs = Date.now() - startTime;

          this.logger.log(
            JSON.stringify({
              eventName,
              tenantId: payload.tenantId,
              correlationId: payload.correlationId,
              status: 'success',
              attempt: job.attemptsMade + 1,
              durationMs,
              workerInstance: worker.id,
            }),
          );

          // Record success audit (non-blocking)
          this.auditService
            .recordSuccess({
              eventName,
              payload,
              tenantId: payload.tenantId,
              correlationId: payload.correlationId,
              publishedAt: new Date(job.timestamp),
              processedAt: new Date(),
              durationMs,
              attempts: job.attemptsMade + 1,
              isReplay: payload.isReplay ?? false,
            })
            .catch((err) =>
              this.logger.error(`Audit recording failed: ${err.message}`),
            );
        } catch (error) {
          const durationMs = Date.now() - startTime;
          const isLastAttempt =
            job.attemptsMade + 1 >= eventConfig.maxRetries;
          const logStatus = isLastAttempt ? 'failed' : 'retrying';

          this.logger.error(
            JSON.stringify({
              eventName,
              tenantId: payload.tenantId,
              correlationId: payload.correlationId,
              status: logStatus,
              attempt: job.attemptsMade + 1,
              error:
                error instanceof Error ? error.message : String(error),
              durationMs,
              workerInstance: worker.id,
            }),
          );

          // If this was the last retry, record failure in audit
          if (isLastAttempt) {
            this.auditService
              .recordFailure({
                eventName,
                payload,
                tenantId: payload.tenantId,
                correlationId: payload.correlationId,
                publishedAt: new Date(job.timestamp),
                attempts: job.attemptsMade + 1,
                errors: [
                  {
                    attempt: job.attemptsMade + 1,
                    error:
                      error instanceof Error
                        ? error.message
                        : String(error),
                    timestamp: new Date().toISOString(),
                  },
                ],
              })
              .catch((err) =>
                this.logger.error(
                  `Audit recording failed: ${err.message}`,
                ),
              );
          }

          throw error; // Re-throw to trigger BullMQ retry
        }
      },
      {
        connection: { host: this.redisHost, port: this.redisPort },
        prefix: REDIS_PREFIX,
        concurrency,
      },
    );

    this.workers.set(eventName, worker);
  }

  /**
   * Reprocesses a specific job from the Dead Letter Queue.
   *
   * Flow:
   * 1. Look up the queue for the given event name
   * 2. Fetch the failed job by ID
   * 3. Verify the job is in 'failed' state
   * 4. Re-add the job to the queue with original payload and configured options
   * 5. Remove the failed job from the DLQ
   * 6. Record reprocessment in the audit log
   *
   * @see Requirements 3.4, 3.6
   */
  async reprocessFromDLQ(eventName: string, jobId: string): Promise<void> {
    const queue = this.queues.get(eventName);
    if (!queue) {
      throw new Error(`Queue for event '${eventName}' not found`);
    }

    // Get the failed job from the queue
    const job = await queue.getJob(jobId);
    if (!job) {
      throw new Error(`Job '${jobId}' not found in queue '${eventName}'`);
    }

    // Check if job is in failed state
    const state = await job.getState();
    if (state !== 'failed') {
      throw new Error(
        `Job '${jobId}' is in state '${state}', expected 'failed'`,
      );
    }

    const eventConfig = EVENT_REGISTRY.find((e) => e.name === eventName);

    // Re-add the job to the queue with the original payload
    await queue.add(eventName, job.data, {
      priority: eventConfig?.priority ?? 5,
      attempts: eventConfig?.maxRetries ?? 3,
      backoff: { type: 'exponential', delay: BASE_RETRY_DELAY_MS },
      removeOnComplete: true,
      removeOnFail: false,
    });

    // Remove the failed job from DLQ
    await job.remove();

    // Record reprocessment audit
    await this.auditService.recordReplay({
      eventName,
      payload: job.data,
      tenantId: job.data.tenantId,
      correlationId: job.data.correlationId,
      originalCorrelationId: job.data.correlationId,
      publishedAt: new Date(),
    });

    this.logger.log(
      JSON.stringify({
        eventName,
        tenantId: job.data.tenantId,
        correlationId: job.data.correlationId,
        status: 'reprocessed',
        jobId,
      }),
    );
  }

  /**
   * Lists events in the Dead Letter Queue with pagination.
   *
   * Returns DLQ items ordered from most recent to oldest by failure timestamp.
   * Each item includes the original payload, error history, and attempt count.
   *
   * @see Requirements 3.5
   */
  async listDLQ(
    eventName: string,
    pagination: PaginationOptions,
  ): Promise<PaginatedDLQResult> {
    const queue = this.queues.get(eventName);
    if (!queue) {
      throw new Error(`Queue for event '${eventName}' not found`);
    }

    const { page, pageSize } = pagination;
    const start = (page - 1) * pageSize;
    const end = start + pageSize - 1;

    // Get failed jobs from BullMQ with pagination range
    const failedJobs = await queue.getJobs(['failed'], start, end);
    const totalCount = await queue.getJobCounts('failed');

    const items: DLQItem[] = failedJobs.map((job) => ({
      jobId: job.id!,
      eventName,
      payload: job.data,
      failedAt: new Date(job.finishedOn ?? job.processedOn ?? Date.now()),
      attempts: job.attemptsMade,
      errors:
        job.stacktrace?.map((trace, idx) => ({
          attempt: idx + 1,
          error: trace,
          timestamp: new Date(job.timestamp),
        })) ?? [],
    }));

    // Sort by failedAt descending (most recent first)
    items.sort((a, b) => b.failedAt.getTime() - a.failedAt.getTime());

    return {
      items,
      total: totalCount.failed,
      page,
      pageSize,
    };
  }

  /** @see Task 3.5 */
  async replay(
    _eventName: string,
    _filters: ReplayFilters,
  ): Promise<ReplayResult> {
    throw new Error('Not implemented yet — see task 3.5');
  }

  /** @see Task 9.1 */
  async getMetrics(): Promise<EventBusMetrics> {
    throw new Error('Not implemented yet — see task 9.1');
  }

  /**
   * Returns Event Bus health status including:
   * - Redis connection status (up/down)
   * - Number of active queues
   * - Number of active workers
   * - Aggregated metrics from the last 5 minutes
   *
   * @see Requirements 7.4
   */
  async getHealth(): Promise<EventBusHealth> {
    const redis: 'up' | 'down' = this.isConnected ? 'up' : 'down';
    const queuesActive = this.queues.size;
    const workersActive = this.workers.size;
    const metrics5min = this.metricsCollector.getMetrics();

    return {
      redis,
      queuesActive,
      workersActive,
      metrics5min,
    };
  }
}
