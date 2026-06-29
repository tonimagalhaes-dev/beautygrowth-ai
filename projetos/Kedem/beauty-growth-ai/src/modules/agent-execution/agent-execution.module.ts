import { Module } from '@nestjs/common';

import { AgentConfigModule } from '../agent-config/agent-config.module';
import { PromptRegistryModule } from '../prompt-registry/prompt-registry.module';
import { GuardrailsModule } from '../guardrails/guardrails.module';
import { AgentMemoryModule } from '../agent-memory/agent-memory.module';
import { ObservabilityModule } from '../observability/observability.module';
import { ModelRegistryModule } from '../model-registry/model-registry.module';

import { AgentExecutionService } from './services/agent-execution.service';

/**
 * AgentExecutionModule wires the full agent execution pipeline by importing
 * all necessary domain modules and providing the orchestration service.
 *
 * Pipeline: config → prompt resolution → guardrails → model → memory → observability
 */
@Module({
  imports: [
    AgentConfigModule,
    PromptRegistryModule,
    GuardrailsModule,
    AgentMemoryModule,
    ObservabilityModule,
    ModelRegistryModule,
  ],
  providers: [AgentExecutionService],
  exports: [AgentExecutionService],
})
export class AgentExecutionModule {}
