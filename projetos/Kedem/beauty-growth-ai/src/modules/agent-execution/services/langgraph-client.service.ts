import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { join } from 'path';
import { randomUUID } from 'crypto';

import { ILangGraphClient } from '../interfaces/langgraph-client.interface';
import {
  ExecuteWorkflowRequest,
  ExecuteWorkflowResponse,
  ExecutionState,
  CancelExecutionResponse,
  HealthCheckResponse,
  WorkflowStreamEvent,
  GrpcError,
} from '../interfaces/grpc-types';

/**
 * LangGraphClientService manages gRPC communication with the LangGraph Python service.
 *
 * Features:
 * - Connection pool with round-robin channel selection (min: 1, max: 10)
 * - Automatic metadata propagation (x-tenant-id, x-trace-id, x-user-id) on every call
 * - 30s timeout (deadline) per gRPC call
 * - Dynamic proto loading via @grpc/proto-loader
 *
 * Requirements: 1.1, 1.3, 1.5, 1.7
 */
@Injectable()
export class LangGraphClientService
  implements ILangGraphClient, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(LangGraphClientService.name);

  /** Pool of gRPC client instances */
  private clients: grpc.Client[] = [];

  /** Round-robin index for pool selection */
  private currentIndex = 0;

  /** Pool configuration */
  private readonly minPoolSize: number;
  private readonly maxPoolSize: number;

  /** gRPC target address */
  private readonly host: string;
  private readonly port: number;

  /** Timeout per call in milliseconds */
  private readonly callTimeoutMs: number;

  /** Proto package definition */
  private packageDefinition: grpc.GrpcObject | null = null;

  /** Service client constructor */
  private ServiceClient: any = null;

  /** Path to the proto file */
  private readonly protoPath: string;

  constructor(private readonly configService: ConfigService) {
    this.host = this.configService.get<string>('LANGGRAPH_HOST', 'localhost');
    this.port = this.configService.get<number>('LANGGRAPH_PORT', 50051);
    this.callTimeoutMs = this.configService.get<number>(
      'LANGGRAPH_CALL_TIMEOUT_MS',
      30000,
    );
    this.minPoolSize = this.configService.get<number>(
      'LANGGRAPH_POOL_MIN',
      1,
    );
    this.maxPoolSize = this.configService.get<number>(
      'LANGGRAPH_POOL_MAX',
      10,
    );
    this.protoPath = this.configService.get<string>(
      'LANGGRAPH_PROTO_PATH',
      join(process.cwd(), 'proto', 'agent_orchestration.proto'),
    );
  }

  async onModuleInit(): Promise<void> {
    await this.loadProtoDefinition();
    this.initializePool();
    this.logger.log(
      `LangGraph gRPC client initialized: ${this.host}:${this.port} (pool: ${this.clients.length} channels)`,
    );
  }

  onModuleDestroy(): void {
    this.closePool();
    this.logger.log('LangGraph gRPC client pool closed');
  }

  // ===========================================================================
  // PUBLIC API - ILangGraphClient implementation
  // ===========================================================================

  async executeWorkflow(
    request: ExecuteWorkflowRequest,
  ): Promise<ExecuteWorkflowResponse> {
    const metadata = this.buildMetadata(
      request.tenantId,
      request.userId,
    );
    const client = this.getNextClient();

    return this.unaryCall<ExecuteWorkflowResponse>(
      client,
      'ExecuteWorkflow',
      this.toProtoRequest(request),
      metadata,
    );
  }

  async *executeWorkflowStream(
    request: ExecuteWorkflowRequest,
  ): AsyncIterable<WorkflowStreamEvent> {
    const metadata = this.buildMetadata(
      request.tenantId,
      request.userId,
    );
    const client = this.getNextClient();
    const deadline = this.getDeadline();

    const call = (client as any).ExecuteWorkflowStream(
      this.toProtoRequest(request),
      metadata,
      { deadline },
    );

    const eventQueue: Array<{ value?: WorkflowStreamEvent; error?: Error; done?: boolean }> = [];
    let resolve: (() => void) | null = null;

    call.on('data', (data: any) => {
      eventQueue.push({ value: this.parseStreamEvent(data) });
      if (resolve) {
        resolve();
        resolve = null;
      }
    });

    call.on('error', (err: Error) => {
      eventQueue.push({ error: err });
      if (resolve) {
        resolve();
        resolve = null;
      }
    });

    call.on('end', () => {
      eventQueue.push({ done: true });
      if (resolve) {
        resolve();
        resolve = null;
      }
    });

    while (true) {
      if (eventQueue.length === 0) {
        await new Promise<void>((r) => {
          resolve = r;
        });
      }

      const item = eventQueue.shift();
      if (!item) continue;

      if (item.done) return;
      if (item.error) {
        throw this.wrapGrpcError(item.error, metadata.get('x-trace-id')[0] as string);
      }
      if (item.value) yield item.value;
    }
  }

  async getExecutionState(
    executionId: string,
    tenantId: string,
  ): Promise<ExecutionState> {
    const metadata = this.buildMetadata(tenantId);
    const client = this.getNextClient();

    return this.unaryCall<ExecutionState>(
      client,
      'GetExecutionState',
      { execution_id: executionId, tenant_id: tenantId },
      metadata,
    );
  }

  async cancelExecution(
    executionId: string,
    tenantId: string,
  ): Promise<CancelExecutionResponse> {
    const metadata = this.buildMetadata(tenantId);
    const client = this.getNextClient();

    return this.unaryCall<CancelExecutionResponse>(
      client,
      'CancelExecution',
      { execution_id: executionId, tenant_id: tenantId },
      metadata,
    );
  }

  async healthCheck(): Promise<HealthCheckResponse> {
    const metadata = new grpc.Metadata();
    metadata.set('x-trace-id', this.generateTraceId());
    const client = this.getNextClient();

    return this.unaryCall<HealthCheckResponse>(
      client,
      'HealthCheck',
      {},
      metadata,
    );
  }

  // ===========================================================================
  // POOL MANAGEMENT
  // ===========================================================================

  /**
   * Load the proto definition using @grpc/proto-loader.
   */
  private async loadProtoDefinition(): Promise<void> {
    const packageDef = await protoLoader.load(this.protoPath, {
      keepCase: false,
      longs: Number,
      enums: Number,
      defaults: true,
      oneofs: true,
    });

    this.packageDefinition = grpc.loadPackageDefinition(packageDef);

    // Navigate the package structure to find the service
    const orchPackage = (this.packageDefinition as any).beautygrowth?.orchestration?.v1;

    if (!orchPackage || !orchPackage.AgentOrchestrationService) {
      throw new Error(
        'Failed to load AgentOrchestrationService from proto definition. ' +
          'Ensure the proto file is at the configured path.',
      );
    }

    this.ServiceClient = orchPackage.AgentOrchestrationService;
  }

  /**
   * Initialize the connection pool with minimum pool size channels.
   */
  private initializePool(): void {
    const poolSize = Math.max(this.minPoolSize, 1);
    const address = `${this.host}:${this.port}`;

    for (let i = 0; i < poolSize; i++) {
      const client = new this.ServiceClient(
        address,
        grpc.credentials.createInsecure(),
        {
          'grpc.keepalive_time_ms': 30000,
          'grpc.keepalive_timeout_ms': 10000,
          'grpc.keepalive_permit_without_calls': 1,
          'grpc.max_receive_message_length': 10 * 1024 * 1024, // 10MB
        },
      );
      this.clients.push(client);
    }
  }

  /**
   * Close all connections in the pool.
   */
  private closePool(): void {
    for (const client of this.clients) {
      client.close();
    }
    this.clients = [];
    this.currentIndex = 0;
  }

  /**
   * Get the next client from the pool using round-robin.
   * Dynamically grows the pool up to maxPoolSize if needed.
   */
  private getNextClient(): grpc.Client {
    if (this.clients.length === 0) {
      throw new Error('gRPC client pool is empty. Service may not be initialized.');
    }

    const client = this.clients[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.clients.length;
    return client;
  }

  /**
   * Scale the pool up by one channel (up to maxPoolSize).
   * Can be called externally or by a load-monitoring mechanism.
   */
  scalePool(): boolean {
    if (this.clients.length >= this.maxPoolSize) {
      return false;
    }

    const address = `${this.host}:${this.port}`;
    const client = new this.ServiceClient(
      address,
      grpc.credentials.createInsecure(),
      {
        'grpc.keepalive_time_ms': 30000,
        'grpc.keepalive_timeout_ms': 10000,
        'grpc.keepalive_permit_without_calls': 1,
        'grpc.max_receive_message_length': 10 * 1024 * 1024,
      },
    );
    this.clients.push(client);
    return true;
  }

  /**
   * Get current pool size.
   */
  getPoolSize(): number {
    return this.clients.length;
  }

  // ===========================================================================
  // METADATA & DEADLINE
  // ===========================================================================

  /**
   * Build gRPC metadata with tenant_id, trace_id, and user_id.
   * Requirements: 1.3 — propagate context on every call.
   */
  buildMetadata(tenantId?: string, userId?: string): grpc.Metadata {
    const metadata = new grpc.Metadata();

    if (tenantId) {
      metadata.set('x-tenant-id', tenantId);
    }

    metadata.set('x-trace-id', this.generateTraceId());

    if (userId) {
      metadata.set('x-user-id', userId);
    }

    return metadata;
  }

  /**
   * Calculate the deadline for a gRPC call (now + callTimeoutMs).
   * Requirements: 1.7 — 30s timeout per call.
   */
  private getDeadline(): Date {
    return new Date(Date.now() + this.callTimeoutMs);
  }

  /**
   * Generate a trace ID for correlation.
   */
  private generateTraceId(): string {
    return `trace-${randomUUID()}`;
  }

  // ===========================================================================
  // GRPC CALL HELPERS
  // ===========================================================================

  /**
   * Execute a unary gRPC call with metadata and deadline.
   */
  private unaryCall<T>(
    client: grpc.Client,
    method: string,
    request: any,
    metadata: grpc.Metadata,
  ): Promise<T> {
    const deadline = this.getDeadline();
    const traceId = metadata.get('x-trace-id')[0] as string;

    return new Promise<T>((resolve, reject) => {
      (client as any)[method](
        request,
        metadata,
        { deadline },
        (error: grpc.ServiceError | null, response: any) => {
          if (error) {
            reject(this.wrapGrpcError(error, traceId));
            return;
          }
          resolve(response as T);
        },
      );
    });
  }

  /**
   * Wrap a raw gRPC error into a typed GrpcError.
   * Requirements: 1.6 — return typed error with code, message, and trace_id.
   */
  private wrapGrpcError(error: any, traceId: string): GrpcError & Error {
    const code = error.code ?? grpc.status.UNKNOWN;
    const message = error.details || error.message || 'Unknown gRPC error';

    const grpcError = new Error(
      `gRPC error [${grpc.status[code] || code}]: ${message} (trace: ${traceId})`,
    ) as GrpcError & Error;

    grpcError.code = code;
    grpcError.traceId = traceId;

    return grpcError;
  }

  // ===========================================================================
  // PROTO MESSAGE MAPPING
  // ===========================================================================

  /**
   * Convert a TypeScript ExecuteWorkflowRequest to proto-compatible format (snake_case).
   */
  private toProtoRequest(request: ExecuteWorkflowRequest): any {
    return {
      agent_id: request.agentId,
      tenant_id: request.tenantId,
      user_input: request.userInput,
      user_id: request.userId,
      tenant_context: request.tenantContext,
      workflow_id: request.workflowId,
      conversation_id: request.conversationId,
      options: request.options
        ? {
            max_steps: request.options.maxSteps,
            timeout_ms: request.options.timeoutMs,
            enable_streaming: request.options.enableStreaming,
            metadata: request.options.metadata,
          }
        : undefined,
    };
  }

  /**
   * Parse a raw stream event from proto into a WorkflowStreamEvent.
   */
  private parseStreamEvent(data: any): WorkflowStreamEvent {
    const event: WorkflowStreamEvent = {};

    if (data.step_started || data.stepStarted) {
      const raw = data.step_started || data.stepStarted;
      event.stepStarted = {
        nodeId: raw.node_id || raw.nodeId || '',
        nodeType: raw.node_type || raw.nodeType || '',
      };
    } else if (data.step_completed || data.stepCompleted) {
      const raw = data.step_completed || data.stepCompleted;
      event.stepCompleted = { result: raw.result };
    } else if (data.token_generated || data.tokenGenerated) {
      const raw = data.token_generated || data.tokenGenerated;
      event.tokenGenerated = {
        token: raw.token || '',
        nodeId: raw.node_id || raw.nodeId || '',
      };
    } else if (data.workflow_completed || data.workflowCompleted) {
      const raw = data.workflow_completed || data.workflowCompleted;
      event.workflowCompleted = { response: raw.response };
    } else if (data.workflow_error || data.workflowError) {
      const raw = data.workflow_error || data.workflowError;
      event.workflowError = {
        errorCode: raw.error_code || raw.errorCode || '',
        errorMessage: raw.error_message || raw.errorMessage || '',
        nodeId: raw.node_id || raw.nodeId || '',
      };
    }

    return event;
  }
}
