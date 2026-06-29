import { Module } from '@nestjs/common';

import { TenantProvisioningListener } from './tenant-provisioning.listener';
import { BrandSyncListener } from './brand-sync.listener';
import { KnowledgeHubModule } from '../knowledge-hub/knowledge-hub.module';
import { BusinessMemoryModule } from '../business-memory/business-memory.module';
import { BrandModule } from '../brand/brand.module';

/**
 * Integration Module
 *
 * Wires cross-module event listeners that orchestrate multi-step flows.
 * This module contains listeners that respond to domain events and coordinate
 * provisioning across multiple bounded contexts.
 *
 * Flows:
 * - tenant.created → Knowledge Hub + Business Memory provisioning
 * - brand.updated → Business Memory sync (Requirements 6.2, 6.3)
 */
@Module({
  imports: [KnowledgeHubModule, BusinessMemoryModule, BrandModule],
  providers: [TenantProvisioningListener, BrandSyncListener],
  exports: [TenantProvisioningListener, BrandSyncListener],
})
export class IntegrationModule {}
