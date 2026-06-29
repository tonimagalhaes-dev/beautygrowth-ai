/**
 * @module EventBusModule
 *
 * Distributed Event Bus based on BullMQ for the BeautyGrowth AI platform.
 * Provides reliable event publishing, consuming with retry/DLQ, and observability.
 *
 * Barrel exports will be populated as implementation tasks are completed.
 */

// Interfaces
export * from './interfaces';

// Module
export * from './event-bus.module';

// Config
export * from './config/event-bus.constants';
export * from './config/event-registry';

// Decorators
export * from './decorators/on-distributed-event.decorator';

// DTOs
export * from './dto';

// Entities
export * from './entities';

// Services
export * from './services/event-bus.service';
export * from './services/audit.service';
export * from './services/metrics-collector.service';
export * from './services/connection-buffer.service';
export * from './services/payload-validator.service';

// Consumers
export * from './consumers/tenant-provisioning.consumer';
export * from './consumers/brand-sync.consumer';
export * from './consumers/guardrails-cache.consumer';
export * from './consumers/guardrails-violation.consumer';

// Controllers
export * from './controllers/event-bus-health.controller';
