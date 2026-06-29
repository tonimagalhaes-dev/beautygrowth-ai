import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscoveryModule } from '@nestjs/core';

import { EventBusModuleOptions } from './interfaces';
import { EventAuditLog } from './entities/event-audit-log.entity';
import { EventBusService } from './services/event-bus.service';
import { AuditService } from './services/audit.service';
import { MetricsCollector } from './services/metrics-collector.service';
import { ConnectionBuffer } from './services/connection-buffer.service';
import { PayloadValidator } from './services/payload-validator.service';
import { EventBusExplorer } from './services/event-bus-explorer.service';
import { EventBusHealthController } from './controllers/event-bus-health.controller';

// Consumers
import { TenantProvisioningConsumer } from './consumers/tenant-provisioning.consumer';
import { BrandSyncConsumer } from './consumers/brand-sync.consumer';
import { GuardrailsCacheConsumer } from './consumers/guardrails-cache.consumer';
import { GuardrailsViolationConsumer } from './consumers/guardrails-violation.consumer';

/**
 * EventBusModule — Distributed Event Bus based on BullMQ.
 *
 * Use `EventBusModule.forRoot()` to register the module with optional configuration.
 * The module is global — EventBusService is available app-wide without re-importing.
 *
 * Registers all core services (publish, audit, metrics, connection buffer, validation,
 * explorer) and all domain event consumers as providers.
 *
 * @see Requirements 1.4, 9.2
 */
@Module({})
export class EventBusModule {
  static forRoot(options?: EventBusModuleOptions): DynamicModule {
    return {
      module: EventBusModule,
      imports: [
        ConfigModule,
        DiscoveryModule,
        TypeOrmModule.forFeature([EventAuditLog]),
      ],
      controllers: [EventBusHealthController],
      providers: [
        EventBusService,
        AuditService,
        MetricsCollector,
        ConnectionBuffer,
        PayloadValidator,
        EventBusExplorer,
        // Consumers
        TenantProvisioningConsumer,
        BrandSyncConsumer,
        GuardrailsCacheConsumer,
        GuardrailsViolationConsumer,
        // Module options provider
        {
          provide: 'EVENT_BUS_OPTIONS',
          useValue: options ?? {},
        },
      ],
      exports: [EventBusService, EventBusExplorer],
      global: true,
    };
  }
}
