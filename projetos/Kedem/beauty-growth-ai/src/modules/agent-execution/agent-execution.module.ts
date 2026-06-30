import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { AgentConfigModule } from '../agent-config/agent-config.module';
import { PromptRegistryModule } from '../prompt-registry/prompt-registry.module';
import { GuardrailsModule } from '../guardrails/guardrails.module';
import { AgentMemoryModule } from '../agent-memory/agent-memory.module';
import { ObservabilityModule } from '../observability/observability.module';
import { ModelRegistryModule } from '../model-registry/model-registry.module';

import { AgentExecutionService } from './services/agent-execution.service';
import { LangGraphClientService } from './services/langgraph-client.service';
import { CircuitBreakerService } from './services/circuit-breaker.service';
import { FallbackHandlerService } from './services/fallback-handler.service';
import { GrpcErrorHandler } from './services/grpc-error-handler';

/**
 * AgentExecutionModule wires the full agent execution pipeline by importing
 * all necessary domain modules and providing the orchestration service.
 *
 * Pipeline: config → prompt resolution → guardrails → LangGraph (gRPC) → memory → observability
 *
 * Includes:
 * - LangGraphClientService: gRPC client for LangGraph Python service (env: LANGGRAPH_HOST, LANGGRAPH_PORT)
 * - CircuitBreakerService: resilience layer with fallback (env: CIRCUIT_BREAKER_*)
 * - FallbackHandlerService: local pipeline when LangGraph is unavailable
 * - GrpcErrorHandler: typed error handling for gRPC failures
 *
 * Environment variables:
 * - LANGGRAPH_HOST: gRPC server host (default: localhost)
 * - LANGGRAPH_PORT: gRPC server port (default: 50051)
 * - LANGGRAPH_CALL_TIMEOUT_MS: timeout per gRPC call (default: 30000)
 * - LANGGRAPH_POOL_MIN: minimum connection pool size (default: 1)
 * - LANGGRAPH_POOL_MAX: maximum connection pool size (default: 10)
 * - CIRCUIT_BREAKER_FAILURE_THRESHOLD: failures before opening (default: 5)
 * - CIRCUIT_BREAKER_SUCCESS_THRESHOLD: successes to close from half-open (default: 3)
 * - CIRCUIT_BREAKER_TIMEOUT: timeout per request in ms (default: 30000)
 * - CIRCUIT_BREAKER_RESET_TIMEOUT: time before attempting half-open in ms (default: 60000)
 */
@Module({
  imports: [
    ConfigModule,
    AgentConfigModule,
    PromptRegistryModule,
    GuardrailsModule,
    AgentMemoryModule,
    ObservabilityModule,
    ModelRegistryModule,
  ],
  providers: [
    AgentExecutionService,
    LangGraphClientService,
    {
      provide: CircuitBreakerService,
      useFactory: (configService: ConfigService) => {
        return new CircuitBreakerService({
          failureThreshold: configService.get<number>('CIRCUIT_BREAKER_FAILURE_THRESHOLD', 5),
          successThreshold: configService.get<number>('CIRCUIT_BREAKER_SUCCESS_THRESHOLD', 3),
          timeout: configService.get<number>('CIRCUIT_BREAKER_TIMEOUT', 30000),
          resetTimeout: configService.get<number>('CIRCUIT_BREAKER_RESET_TIMEOUT', 60000),
        });
      },
      inject: [ConfigService],
    },
    FallbackHandlerService,
    GrpcErrorHandler,
  ],
  exports: [AgentExecutionService, LangGraphClientService, CircuitBreakerService],
})
export class AgentExecutionModule {}
