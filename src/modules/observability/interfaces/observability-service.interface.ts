/**
 * Observability service interface — audit, logs, metrics, and alerting.
 * Audit logs are immutable (append-only via DB trigger).
 */

export interface DateRange {
  start: Date;
  end: Date;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  modelId: string;
  agentId: string;
  timestamp: Date;
}

export interface AgentLogEntry {
  traceId: string;
  tenantId: string;
  agentId: string;
  actionType: string;
  input: string;
  output: string;
  durationMs: number;
  status: 'success' | 'error';
  tokensUsed?: TokenUsage;
  guardrailViolations?: string[];
  timestamp: Date;
}

export interface UserLogEntry {
  traceId: string;
  tenantId: string;
  userId: string;
  actionType: string;
  resource: string;
  result: string;
  timestamp: Date;
}

export interface RAGLogEntry {
  traceId: string;
  tenantId: string;
  agentId: string;
  query: string;
  chunksReturned: RAGChunkInfo[];
  finalPrompt: string;
  response: string;
  durationMs: number;
  timestamp: Date;
}

export interface RAGChunkInfo {
  chunkId: string;
  documentId: string;
  score: number;
}

export interface LogFilters {
  tenantId: string;
  agentId?: string;
  userId?: string;
  actionType?: string;
  status?: 'success' | 'error';
  period: DateRange;
  traceId?: string;
}

export interface PaginatedLogs {
  data: AuditLogRecord[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface AuditLogRecord {
  id: string;
  traceId: string;
  tenantId: string;
  agentId: string | null;
  userId: string | null;
  actionType: string;
  input: string;
  output: string;
  durationMs: number;
  status: 'success' | 'error';
  metadata: Record<string, any>;
  createdAt: Date;
}

export interface ErrorSummary {
  actionType: string;
  count: number;
  lastOccurred: Date;
}

export interface DashboardMetrics {
  totalExecutions: number;
  avgResponseTimeMs: number;
  errorRate: number;
  tokensByModel: Record<string, { inputTokens: number; outputTokens: number }>;
  tokensByAgent: Record<string, { inputTokens: number; outputTokens: number }>;
  guardrailViolations: number;
  topErrors: ErrorSummary[];
}

export interface Alert {
  id: string;
  tenantId: string;
  agentId: string;
  alertType: 'error_rate_high';
  threshold: number;
  currentValue: number;
  message: string;
  triggeredAt: Date;
}

export type ExportFormat = 'json' | 'csv';

export interface ExportResult {
  format: ExportFormat;
  data: string;
  recordCount: number;
  generatedAt: Date;
}

export interface IObservabilityService {
  logAgentAction(entry: AgentLogEntry): Promise<void>;
  logUserAction(entry: UserLogEntry): Promise<void>;
  logRAGQuery(entry: RAGLogEntry): Promise<void>;
  queryLogs(filters: LogFilters, page?: number, limit?: number): Promise<PaginatedLogs>;
  getDashboardMetrics(tenantId: string, period: DateRange): Promise<DashboardMetrics>;
  checkAlertThresholds(tenantId: string): Promise<Alert[]>;
  exportLogs(tenantId: string, filters: LogFilters, format: ExportFormat): Promise<ExportResult>;
}
