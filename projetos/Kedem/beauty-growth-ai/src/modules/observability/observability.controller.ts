import {
  Body,
  Controller,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import { ObservabilityService } from './services/observability.service';
import { LogAgentActionDto } from './dto/log-agent-action.dto';
import { LogUserActionDto } from './dto/log-user-action.dto';
import { LogRAGQueryDto } from './dto/log-rag-query.dto';
import { QueryLogsDto } from './dto/query-logs.dto';
import { DashboardMetricsDto } from './dto/dashboard-metrics.dto';
import { ExportLogsDto } from './dto/export-logs.dto';
import { CurrentTenant } from '@shared/decorators';
import { TenantContext } from '@shared/interfaces';
import {
  PaginatedLogs,
  DashboardMetrics,
  Alert,
  ExportResult,
} from './interfaces/observability-service.interface';

@Controller('observability')
export class ObservabilityController {
  constructor(private readonly observabilityService: ObservabilityService) {}

  /**
   * POST /observability/logs/agent
   * Log a structured agent action.
   */
  @Post('logs/agent')
  async logAgentAction(
    @Body() dto: LogAgentActionDto,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<{ traceId: string }> {
    const traceId = dto.traceId || this.observabilityService.generateTraceId();

    await this.observabilityService.logAgentAction({
      traceId,
      tenantId: tenant.tenantId,
      agentId: dto.agentId,
      actionType: dto.actionType,
      input: dto.input,
      output: dto.output,
      durationMs: dto.durationMs,
      status: dto.status,
      tokensUsed: dto.tokensUsed
        ? {
            inputTokens: dto.tokensUsed.inputTokens,
            outputTokens: dto.tokensUsed.outputTokens,
            modelId: dto.tokensUsed.modelId,
            agentId: dto.tokensUsed.agentId,
            timestamp: new Date(),
          }
        : undefined,
      guardrailViolations: dto.guardrailViolations,
      timestamp: dto.timestamp ? new Date(dto.timestamp) : new Date(),
    });

    return { traceId };
  }

  /**
   * POST /observability/logs/user
   * Log a structured user action.
   */
  @Post('logs/user')
  async logUserAction(
    @Body() dto: LogUserActionDto,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<{ traceId: string }> {
    const traceId = dto.traceId || this.observabilityService.generateTraceId();

    await this.observabilityService.logUserAction({
      traceId,
      tenantId: tenant.tenantId,
      userId: tenant.userId,
      actionType: dto.actionType,
      resource: dto.resource,
      result: dto.result,
      timestamp: dto.timestamp ? new Date(dto.timestamp) : new Date(),
    });

    return { traceId };
  }

  /**
   * POST /observability/logs/rag
   * Log a RAG query with chunks, scores, and prompt.
   */
  @Post('logs/rag')
  async logRAGQuery(
    @Body() dto: LogRAGQueryDto,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<{ traceId: string }> {
    const traceId = dto.traceId || this.observabilityService.generateTraceId();

    await this.observabilityService.logRAGQuery({
      traceId,
      tenantId: tenant.tenantId,
      agentId: dto.agentId,
      query: dto.query,
      chunksReturned: dto.chunksReturned,
      finalPrompt: dto.finalPrompt,
      response: dto.response,
      durationMs: dto.durationMs,
      timestamp: dto.timestamp ? new Date(dto.timestamp) : new Date(),
    });

    return { traceId };
  }

  /**
   * GET /observability/logs
   * Query logs with filters (period, agent, action, status). SLA: 10s for 30-day queries.
   */
  @Get('logs')
  async queryLogs(
    @Query() dto: QueryLogsDto,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<PaginatedLogs> {
    return this.observabilityService.queryLogs(
      {
        tenantId: tenant.tenantId,
        agentId: dto.agentId,
        userId: dto.userId,
        actionType: dto.actionType,
        status: dto.status,
        period: {
          start: new Date(dto.startDate),
          end: new Date(dto.endDate),
        },
        traceId: dto.traceId,
      },
      dto.page ?? 1,
      dto.limit ?? 50,
    );
  }

  /**
   * GET /observability/metrics
   * Get dashboard metrics: executions, avg response time, error rate, tokens, violations.
   */
  @Get('metrics')
  async getDashboardMetrics(
    @Query() dto: DashboardMetricsDto,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<DashboardMetrics> {
    return this.observabilityService.getDashboardMetrics(tenant.tenantId, {
      start: new Date(dto.startDate),
      end: new Date(dto.endDate),
    });
  }

  /**
   * GET /observability/alerts
   * Check alert thresholds and return any triggered alerts.
   */
  @Get('alerts')
  async checkAlerts(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<Alert[]> {
    return this.observabilityService.checkAlertThresholds(tenant.tenantId);
  }

  /**
   * POST /observability/logs/export
   * Export logs in JSON or CSV format. Supports minimum 12 months retention.
   */
  @Post('logs/export')
  async exportLogs(
    @Body() dto: ExportLogsDto,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<ExportResult> {
    return this.observabilityService.exportLogs(
      tenant.tenantId,
      {
        tenantId: tenant.tenantId,
        agentId: dto.agentId,
        actionType: dto.actionType,
        status: dto.status,
        period: {
          start: new Date(dto.startDate),
          end: new Date(dto.endDate),
        },
      },
      dto.format,
    );
  }
}
