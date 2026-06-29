import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';
import { randomUUID } from 'crypto';

import { AuditLog } from '../entities/audit-log.entity';
import { AlertEntity } from '../entities/alert.entity';
import {
  IObservabilityService,
  AgentLogEntry,
  UserLogEntry,
  RAGLogEntry,
  LogFilters,
  PaginatedLogs,
  DashboardMetrics,
  Alert,
  ExportFormat,
  ExportResult,
  DateRange,
  ErrorSummary,
} from '../interfaces/observability-service.interface';

/**
 * Observability service implementing structured logging, metrics, alerting, and export.
 *
 * Key invariants:
 * - Audit logs are IMMUTABLE (append-only). The service NEVER issues UPDATE or DELETE on audit_logs.
 * - trace_id is generated if not provided, enabling end-to-end correlation.
 * - Alert threshold: auto-alert when agent error rate > 10% in 1-hour window.
 * - Log retention minimum 12 months (enforced by retention policy, not deletion).
 * - Export supports JSON and CSV formats.
 */
@Injectable()
export class ObservabilityService implements IObservabilityService {
  private readonly logger = new Logger(ObservabilityService.name);

  /** Error rate threshold for alerting (10%) */
  private readonly ERROR_RATE_THRESHOLD = 0.10;

  /** Alert window duration in milliseconds (1 hour) */
  private readonly ALERT_WINDOW_MS = 60 * 60 * 1000;

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepository: Repository<AuditLog>,
    @InjectRepository(AlertEntity)
    private readonly alertRepository: Repository<AlertEntity>,
  ) {}

  // =========================================================================
  // STRUCTURED LOGGING
  // =========================================================================

  /**
   * Log an agent action (structured logging for AI agent executions).
   * Fields: timestamp, tenant, agent, action, I/O, duration, status, tokens, guardrail violations.
   * Requirement 13.1
   */
  async logAgentAction(entry: AgentLogEntry): Promise<void> {
    const traceId = entry.traceId || this.generateTraceId();

    const metadata: Record<string, any> = {
      logType: 'agent_action',
    };

    if (entry.tokensUsed) {
      metadata.tokensUsed = {
        inputTokens: entry.tokensUsed.inputTokens,
        outputTokens: entry.tokensUsed.outputTokens,
        modelId: entry.tokensUsed.modelId,
      };
    }

    if (entry.guardrailViolations && entry.guardrailViolations.length > 0) {
      metadata.guardrailViolations = entry.guardrailViolations;
    }

    const auditLog = this.auditLogRepository.create({
      traceId,
      tenantId: entry.tenantId,
      agentId: entry.agentId,
      userId: null,
      actionType: entry.actionType,
      input: entry.input,
      output: entry.output,
      durationMs: entry.durationMs,
      status: entry.status,
      metadata,
    });

    await this.auditLogRepository.save(auditLog);

    this.logger.debug(
      `[agent_action] trace=${traceId} tenant=${entry.tenantId} agent=${entry.agentId} action=${entry.actionType} status=${entry.status} duration=${entry.durationMs}ms`,
    );
  }

  /**
   * Log a user action (structured logging for user activities).
   * Fields: timestamp, tenant, user, action, resource, result.
   * Requirement 13.2
   */
  async logUserAction(entry: UserLogEntry): Promise<void> {
    const traceId = entry.traceId || this.generateTraceId();

    const metadata: Record<string, any> = {
      logType: 'user_action',
      resource: entry.resource,
    };

    const auditLog = this.auditLogRepository.create({
      traceId,
      tenantId: entry.tenantId,
      agentId: null,
      userId: entry.userId,
      actionType: entry.actionType,
      input: entry.resource,
      output: entry.result,
      durationMs: 0,
      status: 'success',
      metadata,
    });

    await this.auditLogRepository.save(auditLog);

    this.logger.debug(
      `[user_action] trace=${traceId} tenant=${entry.tenantId} user=${entry.userId} action=${entry.actionType} resource=${entry.resource}`,
    );
  }

  /**
   * Log a RAG query (structured logging for retrieval-augmented generation).
   * Fields: query, chunks returned, scores, final prompt, response.
   * Requirement 13.3
   */
  async logRAGQuery(entry: RAGLogEntry): Promise<void> {
    const traceId = entry.traceId || this.generateTraceId();

    const metadata: Record<string, any> = {
      logType: 'rag_query',
      chunksReturned: entry.chunksReturned,
      finalPrompt: entry.finalPrompt,
    };

    const auditLog = this.auditLogRepository.create({
      traceId,
      tenantId: entry.tenantId,
      agentId: entry.agentId,
      userId: null,
      actionType: 'rag_query',
      input: entry.query,
      output: entry.response,
      durationMs: entry.durationMs,
      status: 'success',
      metadata,
    });

    await this.auditLogRepository.save(auditLog);

    this.logger.debug(
      `[rag_query] trace=${traceId} tenant=${entry.tenantId} agent=${entry.agentId} chunks=${entry.chunksReturned.length} duration=${entry.durationMs}ms`,
    );
  }

  // =========================================================================
  // LOG QUERY API
  // =========================================================================

  /**
   * Query logs with filters (period, agent, action, status).
   * SLA: 10s for 30-day queries.
   * Requirement 13.9
   */
  async queryLogs(
    filters: LogFilters,
    page: number = 1,
    limit: number = 50,
  ): Promise<PaginatedLogs> {
    const queryBuilder = this.auditLogRepository
      .createQueryBuilder('log')
      .where('log.tenant_id = :tenantId', { tenantId: filters.tenantId })
      .andWhere('log.created_at >= :start', { start: filters.period.start })
      .andWhere('log.created_at <= :end', { end: filters.period.end });

    if (filters.agentId) {
      queryBuilder.andWhere('log.agent_id = :agentId', { agentId: filters.agentId });
    }

    if (filters.userId) {
      queryBuilder.andWhere('log.user_id = :userId', { userId: filters.userId });
    }

    if (filters.actionType) {
      queryBuilder.andWhere('log.action_type = :actionType', {
        actionType: filters.actionType,
      });
    }

    if (filters.status) {
      queryBuilder.andWhere('log.status = :status', { status: filters.status });
    }

    if (filters.traceId) {
      queryBuilder.andWhere('log.trace_id = :traceId', { traceId: filters.traceId });
    }

    queryBuilder.orderBy('log.created_at', 'DESC');

    const total = await queryBuilder.getCount();
    const data = await queryBuilder
      .skip((page - 1) * limit)
      .take(limit)
      .getMany();

    return {
      data: data.map((log) => ({
        id: log.id,
        traceId: log.traceId,
        tenantId: log.tenantId,
        agentId: log.agentId,
        userId: log.userId,
        actionType: log.actionType,
        input: log.input,
        output: log.output,
        durationMs: log.durationMs,
        status: log.status,
        metadata: log.metadata,
        createdAt: log.createdAt,
      })),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // =========================================================================
  // DASHBOARD METRICS
  // =========================================================================

  /**
   * Get dashboard metrics: executions, avg response time, error rate, tokens by model/agent,
   * guardrail violations, top errors.
   * Requirement 13.8
   */
  async getDashboardMetrics(
    tenantId: string,
    period: DateRange,
  ): Promise<DashboardMetrics> {
    const logs = await this.auditLogRepository
      .createQueryBuilder('log')
      .where('log.tenant_id = :tenantId', { tenantId })
      .andWhere('log.created_at >= :start', { start: period.start })
      .andWhere('log.created_at <= :end', { end: period.end })
      .getMany();

    const agentLogs = logs.filter(
      (l) => l.metadata?.logType === 'agent_action',
    );

    const totalExecutions = agentLogs.length;
    const errorLogs = agentLogs.filter((l) => l.status === 'error');
    const errorRate = totalExecutions > 0 ? errorLogs.length / totalExecutions : 0;

    const avgResponseTimeMs =
      totalExecutions > 0
        ? agentLogs.reduce((sum, l) => sum + l.durationMs, 0) / totalExecutions
        : 0;

    // Tokens by model
    const tokensByModel: Record<string, { inputTokens: number; outputTokens: number }> = {};
    for (const log of agentLogs) {
      const tokens = log.metadata?.tokensUsed;
      if (tokens?.modelId) {
        if (!tokensByModel[tokens.modelId]) {
          tokensByModel[tokens.modelId] = { inputTokens: 0, outputTokens: 0 };
        }
        tokensByModel[tokens.modelId].inputTokens += tokens.inputTokens || 0;
        tokensByModel[tokens.modelId].outputTokens += tokens.outputTokens || 0;
      }
    }

    // Tokens by agent
    const tokensByAgent: Record<string, { inputTokens: number; outputTokens: number }> = {};
    for (const log of agentLogs) {
      const tokens = log.metadata?.tokensUsed;
      if (log.agentId) {
        if (!tokensByAgent[log.agentId]) {
          tokensByAgent[log.agentId] = { inputTokens: 0, outputTokens: 0 };
        }
        if (tokens) {
          tokensByAgent[log.agentId].inputTokens += tokens.inputTokens || 0;
          tokensByAgent[log.agentId].outputTokens += tokens.outputTokens || 0;
        }
      }
    }

    // Guardrail violations count
    let guardrailViolations = 0;
    for (const log of agentLogs) {
      const violations = log.metadata?.guardrailViolations;
      if (violations && Array.isArray(violations)) {
        guardrailViolations += violations.length;
      }
    }

    // Top errors
    const errorsByType = new Map<string, { count: number; lastOccurred: Date }>();
    for (const log of errorLogs) {
      const existing = errorsByType.get(log.actionType);
      if (existing) {
        existing.count++;
        if (log.createdAt > existing.lastOccurred) {
          existing.lastOccurred = log.createdAt;
        }
      } else {
        errorsByType.set(log.actionType, {
          count: 1,
          lastOccurred: log.createdAt,
        });
      }
    }

    const topErrors: ErrorSummary[] = Array.from(errorsByType.entries())
      .map(([actionType, data]) => ({
        actionType,
        count: data.count,
        lastOccurred: data.lastOccurred,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      totalExecutions,
      avgResponseTimeMs: Math.round(avgResponseTimeMs * 100) / 100,
      errorRate: Math.round(errorRate * 10000) / 10000,
      tokensByModel,
      tokensByAgent,
      guardrailViolations,
      topErrors,
    };
  }

  // =========================================================================
  // ALERT SYSTEM
  // =========================================================================

  /**
   * Check alert thresholds: auto-alert when agent error rate > 10% in 1-hour window.
   * Requirement 13.6
   */
  async checkAlertThresholds(tenantId: string): Promise<Alert[]> {
    const oneHourAgo = new Date(Date.now() - this.ALERT_WINDOW_MS);

    // Get all agent actions in the last hour
    const recentLogs = await this.auditLogRepository
      .createQueryBuilder('log')
      .where('log.tenant_id = :tenantId', { tenantId })
      .andWhere('log.created_at >= :since', { since: oneHourAgo })
      .andWhere("log.metadata->>'logType' = :logType", { logType: 'agent_action' })
      .getMany();

    // Group by agent
    const agentStats = new Map<
      string,
      { total: number; errors: number }
    >();

    for (const log of recentLogs) {
      const agentId = log.agentId;
      if (!agentId) continue;

      if (!agentStats.has(agentId)) {
        agentStats.set(agentId, { total: 0, errors: 0 });
      }

      const stats = agentStats.get(agentId)!;
      stats.total++;
      if (log.status === 'error') {
        stats.errors++;
      }
    }

    const alerts: Alert[] = [];

    for (const [agentId, stats] of agentStats) {
      if (stats.total === 0) continue;

      const errorRate = stats.errors / stats.total;

      if (errorRate > this.ERROR_RATE_THRESHOLD) {
        // Check if we already alerted for this agent in the last hour
        const existingAlert = await this.alertRepository
          .createQueryBuilder('alert')
          .where('alert.tenant_id = :tenantId', { tenantId })
          .andWhere('alert.agent_id = :agentId', { agentId })
          .andWhere('alert.triggered_at >= :since', { since: oneHourAgo })
          .getOne();

        if (!existingAlert) {
          const alert = this.alertRepository.create({
            tenantId,
            agentId,
            alertType: 'error_rate_high',
            threshold: this.ERROR_RATE_THRESHOLD,
            currentValue: Math.round(errorRate * 10000) / 10000,
            message: `Agent ${agentId} error rate is ${(errorRate * 100).toFixed(1)}% (threshold: ${this.ERROR_RATE_THRESHOLD * 100}%) in the last hour. Total: ${stats.total}, Errors: ${stats.errors}`,
          });

          const saved = await this.alertRepository.save(alert);

          alerts.push({
            id: saved.id,
            tenantId: saved.tenantId,
            agentId: saved.agentId,
            alertType: saved.alertType,
            threshold: saved.threshold,
            currentValue: saved.currentValue,
            message: saved.message,
            triggeredAt: saved.triggeredAt,
          });

          this.logger.warn(
            `[ALERT] Agent ${agentId} error rate ${(errorRate * 100).toFixed(1)}% exceeds threshold ${this.ERROR_RATE_THRESHOLD * 100}%`,
          );
        }
      }
    }

    return alerts;
  }

  // =========================================================================
  // EXPORT
  // =========================================================================

  /**
   * Export logs in JSON or CSV format.
   * Requirement 13.7 (log retention minimum 12 months with export capability)
   */
  async exportLogs(
    tenantId: string,
    filters: LogFilters,
    format: ExportFormat,
  ): Promise<ExportResult> {
    // Fetch all matching logs (no pagination for export)
    const queryBuilder = this.auditLogRepository
      .createQueryBuilder('log')
      .where('log.tenant_id = :tenantId', { tenantId })
      .andWhere('log.created_at >= :start', { start: filters.period.start })
      .andWhere('log.created_at <= :end', { end: filters.period.end });

    if (filters.agentId) {
      queryBuilder.andWhere('log.agent_id = :agentId', { agentId: filters.agentId });
    }

    if (filters.actionType) {
      queryBuilder.andWhere('log.action_type = :actionType', {
        actionType: filters.actionType,
      });
    }

    if (filters.status) {
      queryBuilder.andWhere('log.status = :status', { status: filters.status });
    }

    queryBuilder.orderBy('log.created_at', 'DESC');

    const logs = await queryBuilder.getMany();

    let data: string;

    if (format === 'json') {
      data = JSON.stringify(
        logs.map((log) => ({
          id: log.id,
          traceId: log.traceId,
          tenantId: log.tenantId,
          agentId: log.agentId,
          userId: log.userId,
          actionType: log.actionType,
          input: log.input,
          output: log.output,
          durationMs: log.durationMs,
          status: log.status,
          metadata: log.metadata,
          createdAt: log.createdAt,
        })),
        null,
        2,
      );
    } else {
      // CSV format
      const headers = [
        'id',
        'trace_id',
        'tenant_id',
        'agent_id',
        'user_id',
        'action_type',
        'input',
        'output',
        'duration_ms',
        'status',
        'metadata',
        'created_at',
      ];

      const rows = logs.map((log) =>
        [
          log.id,
          log.traceId,
          log.tenantId,
          log.agentId || '',
          log.userId || '',
          log.actionType,
          this.escapeCsvField(log.input),
          this.escapeCsvField(log.output),
          log.durationMs.toString(),
          log.status,
          this.escapeCsvField(JSON.stringify(log.metadata)),
          log.createdAt.toISOString(),
        ].join(','),
      );

      data = [headers.join(','), ...rows].join('\n');
    }

    return {
      format,
      data,
      recordCount: logs.length,
      generatedAt: new Date(),
    };
  }

  // =========================================================================
  // TRACE ID MANAGEMENT
  // =========================================================================

  /**
   * Generate a new trace_id for correlation across inter-component calls.
   * Requirement 13.4
   */
  generateTraceId(): string {
    return `trace-${randomUUID()}`;
  }

  // =========================================================================
  // PRIVATE HELPERS
  // =========================================================================

  /**
   * Escape a field value for CSV output.
   */
  private escapeCsvField(value: string): string {
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }
}
