import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, FindOptionsWhere, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';
import { EventAuditLog } from '../entities/event-audit-log.entity';
import { ReplayFilters, ReplayResult } from '../interfaces';

/**
 * Parameters for recording a successful event processing.
 */
export interface RecordSuccessParams {
  eventName: string;
  payload: Record<string, any>;
  tenantId: string;
  correlationId: string;
  publishedAt: Date;
  processedAt: Date;
  durationMs: number;
  attempts: number;
  isReplay?: boolean;
}

/**
 * Parameters for recording a failed event processing (moved to DLQ).
 */
export interface RecordFailureParams {
  eventName: string;
  payload: Record<string, any>;
  tenantId: string;
  correlationId: string;
  publishedAt: Date;
  attempts: number;
  errors: Array<{ attempt: number; error: string; timestamp: string }>;
}

/**
 * Parameters for recording a replayed event in the audit log.
 */
export interface RecordReplayParams {
  eventName: string;
  payload: Record<string, any>;
  tenantId: string;
  correlationId: string;
  originalCorrelationId: string;
  publishedAt: Date;
}

/**
 * AuditService — persists audit records for all processed domain events
 * and provides replay functionality with filtering capabilities.
 *
 * @see Requirements 6.1, 6.2, 6.4, 6.5, 6.6
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(EventAuditLog)
    private readonly auditRepo: Repository<EventAuditLog>,
  ) {}

  /**
   * Records a successful event processing in the audit log.
   *
   * Persists: eventName, payload, tenantId, correlationId,
   * publishedAt, processedAt, durationMs, attempts, status='success'.
   *
   * @see Requirement 6.1
   */
  async recordSuccess(params: RecordSuccessParams): Promise<EventAuditLog> {
    const entry = this.auditRepo.create({
      eventName: params.eventName,
      payload: params.payload,
      tenantId: params.tenantId,
      correlationId: params.correlationId,
      publishedAt: params.publishedAt,
      processedAt: params.processedAt,
      durationMs: params.durationMs,
      attempts: params.attempts,
      isReplay: params.isReplay ?? false,
      status: 'success',
    });

    const saved = await this.auditRepo.save(entry);

    this.logger.log(
      `Audit recorded: ${params.eventName} [success] tenant=${params.tenantId} correlation=${params.correlationId}`,
    );

    return saved;
  }

  /**
   * Records a failed event processing in the audit log (event moved to DLQ).
   *
   * Persists: eventName, payload, tenantId, correlationId,
   * publishedAt, attempts, errors array with per-attempt details, status='failed'.
   *
   * @see Requirement 6.2
   */
  async recordFailure(params: RecordFailureParams): Promise<EventAuditLog> {
    const entry = this.auditRepo.create({
      eventName: params.eventName,
      payload: params.payload,
      tenantId: params.tenantId,
      correlationId: params.correlationId,
      publishedAt: params.publishedAt,
      processedAt: new Date(),
      durationMs: 0,
      attempts: params.attempts,
      errors: params.errors,
      isReplay: false,
      status: 'failed',
    });

    const saved = await this.auditRepo.save(entry);

    this.logger.warn(
      `Audit recorded: ${params.eventName} [failed] tenant=${params.tenantId} correlation=${params.correlationId} attempts=${params.attempts}`,
    );

    return saved;
  }

  /**
   * Records a replayed event in the audit log with status='replayed'.
   *
   * @see Requirement 6.5
   */
  async recordReplay(params: RecordReplayParams): Promise<EventAuditLog> {
    const entry = this.auditRepo.create({
      eventName: params.eventName,
      payload: params.payload,
      tenantId: params.tenantId,
      correlationId: params.correlationId,
      publishedAt: params.publishedAt,
      durationMs: 0,
      attempts: 0,
      isReplay: true,
      status: 'replayed' as const,
    });

    const saved = await this.auditRepo.save(entry);

    this.logger.log(
      `Audit recorded: ${params.eventName} [replayed] tenant=${params.tenantId} ` +
        `newCorrelation=${params.correlationId} originalCorrelation=${params.originalCorrelationId}`,
    );

    return saved;
  }

  /**
   * Queries the audit log for events matching filters and returns data
   * needed to republish them with isReplay: true marking.
   *
   * Filters supported:
   * - tenantId: filter by specific tenant
   * - startDate/endDate: filter by publishedAt date range
   * - status: filter by processing status ('success' | 'failed')
   *
   * The actual re-publishing is done by the caller (EventBusService).
   * This method returns the events and their metadata for replay.
   *
   * @see Requirements 6.4, 6.5
   */
  async replay(eventName: string, filters: ReplayFilters): Promise<ReplayResult> {
    const where: FindOptionsWhere<EventAuditLog> = {
      eventName,
    };

    if (filters.tenantId) {
      where.tenantId = filters.tenantId;
    }

    if (filters.status) {
      where.status = filters.status;
    }

    if (filters.startDate && filters.endDate) {
      where.publishedAt = Between(filters.startDate, filters.endDate);
    } else if (filters.startDate) {
      where.publishedAt = MoreThanOrEqual(filters.startDate);
    } else if (filters.endDate) {
      where.publishedAt = LessThanOrEqual(filters.endDate);
    }

    const entries = await this.auditRepo.find({
      where,
      order: { publishedAt: 'ASC' },
    });

    const correlationIds = entries.map((entry) => entry.correlationId);

    this.logger.log(
      `Replay query: ${eventName} matched ${entries.length} events ` +
        `filters=${JSON.stringify(filters)}`,
    );

    return {
      replayed: entries.length,
      correlationIds,
    };
  }

  /**
   * Retrieves audit log entries for replay, returning full event data
   * so that the caller can republish them with isReplay: true.
   *
   * @see Requirements 6.4, 6.5
   */
  async getEventsForReplay(
    eventName: string,
    filters: ReplayFilters,
  ): Promise<EventAuditLog[]> {
    const where: FindOptionsWhere<EventAuditLog> = {
      eventName,
    };

    if (filters.tenantId) {
      where.tenantId = filters.tenantId;
    }

    if (filters.status) {
      where.status = filters.status;
    }

    if (filters.startDate && filters.endDate) {
      where.publishedAt = Between(filters.startDate, filters.endDate);
    } else if (filters.startDate) {
      where.publishedAt = MoreThanOrEqual(filters.startDate);
    } else if (filters.endDate) {
      where.publishedAt = LessThanOrEqual(filters.endDate);
    }

    return this.auditRepo.find({
      where,
      order: { publishedAt: 'ASC' },
    });
  }
}
