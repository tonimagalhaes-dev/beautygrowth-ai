import { Module } from '@nestjs/common';

import { TenantProvisioningListener } from './tenant-provisioning.listener';
import { BrandSyncListener } from './brand-sync.listener';
import { KnowledgeHubModule } from '../knowledge-hub/knowledge-hub.module';
import { BusinessMemoryModule } from '../business-memory/business-memory.module';
import { AgentMemoryModule } from '../agent-memory/agent-memory.module';
import { AgentConfigModule } from '../agent-config/agent-config.module';
import { BrandModule } from '../brand/brand.module';

/**
 * Integration Module
 *
 * Wires cross-module event listeners that orchestrate multi-step flows.
 * This module contains listeners that respond to domain events and coordinate
 * provisioning across multiple bounded contexts.
 *
 * Flows:
 * - tenant.created → Knowledge Hub + Business Memory + Agent Memory provisioning
 * - brand.updated → Business Memory sync (Requirements 6.2, 6.3)
 *
 * Requirements: 4.2, 5.1
 */
@Module({
  imports: [
    KnowledgeHubModule,
    BusinessMemoryModule,
    AgentMemoryModule,
    AgentConfigModule,
    BrandModule,
  ],
  providers: [TenantProvisioningListener, BrandSyncListener],
  exports: [TenantProvisioningListener, BrandSyncListener],
})
export class IntegrationModule {}
