import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AgentExecutionModule } from '../agent-execution/agent-execution.module';
import { AgentMemoryModule } from '../agent-memory/agent-memory.module';
import { ObservabilityModule } from '../observability/observability.module';

import { ContentAgentController } from './content-agent.controller';
import { ContentAgentService } from './services/content-agent.service';

/**
 * ContentAgentModule provides the REST API and orchestration logic
 * for the Content Agent MVP — the first functional AI agent in BeautyGrowth AI.
 *
 * Imports:
 * - AuthModule: provides JwtModule (needed by TenantGuard)
 * - AgentExecutionModule: provides LangGraphClientService (gRPC) and CircuitBreakerService
 * - AgentMemoryModule: provides AgentMemoryService for refinement tracking
 * - ObservabilityModule: provides ObservabilityService for trace_id generation
 *
 * Requirements: 1.1
 */
@Module({
  imports: [AuthModule, AgentExecutionModule, AgentMemoryModule, ObservabilityModule],
  controllers: [ContentAgentController],
  providers: [ContentAgentService],
  exports: [ContentAgentService],
})
export class ContentAgentModule {}
