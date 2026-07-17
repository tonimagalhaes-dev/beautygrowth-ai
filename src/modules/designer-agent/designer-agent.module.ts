import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';

import { AuthModule } from '../auth/auth.module';
import { AgentExecutionModule } from '../agent-execution/agent-execution.module';
import { AgentMemoryModule } from '../agent-memory/agent-memory.module';
import { ObservabilityModule } from '../observability/observability.module';
import { PromptCacheModule } from '../prompt-cache/prompt-cache.module';

import { DesignerAgentController } from './designer-agent.controller';
import { DesignerAgentService } from './services/designer-agent.service';
import { DesignerExecution } from './entities/designer-execution.entity';
import { DesignerImage } from './entities/designer-image.entity';
import { DesignerEditHistory } from './entities/designer-edit-history.entity';

/**
 * DesignerAgentModule provides the REST API and orchestration logic
 * for the Designer Agent — responsible for generating social media images
 * via the LangGraph Designer Agent workflow.
 *
 * Imports:
 * - AuthModule: provides JwtModule (needed by TenantGuard)
 * - AgentExecutionModule: provides LangGraphClientService (gRPC) and CircuitBreakerService
 * - AgentMemoryModule: provides AgentMemoryService for execution tracking
 * - ObservabilityModule: provides ObservabilityService for trace_id and logging
 * - PromptCacheModule: provides PromptCacheService for associating images with cache entries
 * - TypeOrmModule: provides repositories for DesignerExecution and DesignerImage
 * - ConfigModule: provides ConfigService for S3/MinIO configuration
 *
 * Requirements: 1.1, 1.2, 1.5, 8.1, 8.4
 */
@Module({
  imports: [
    AuthModule,
    AgentExecutionModule,
    AgentMemoryModule,
    ObservabilityModule,
    PromptCacheModule,
    ConfigModule,
    TypeOrmModule.forFeature([DesignerExecution, DesignerImage, DesignerEditHistory]),
  ],
  controllers: [DesignerAgentController],
  providers: [DesignerAgentService],
  exports: [DesignerAgentService],
})
export class DesignerAgentModule {}
