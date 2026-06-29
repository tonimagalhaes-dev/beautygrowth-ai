/**
 * Event Registry — Declarative configuration for all distributed domain events.
 *
 * New events are added here without modifying the Event Bus core.
 * The module reads this registry at startup to create BullMQ queues
 * with the appropriate configuration (priority, retries, TTL, concurrency).
 *
 * @see Requirements 1.7, 4.1, 4.2, 9.1, 9.2
 */

import { EventConfig } from '../interfaces';
import {
  DEFAULT_JOB_TTL_MS,
  EventPriorityLevel,
  REDUCED_JOB_TTL_MS,
} from './event-bus.constants';
import { TenantCreatedPayloadDto } from '../dto/tenant-created-payload.dto';
import { BrandUpdatedPayloadDto } from '../dto/brand-updated-payload.dto';
import { GuardrailsChangedPayloadDto } from '../dto/guardrails-changed-payload.dto';
import { GuardrailsViolationPayloadDto } from '../dto/guardrails-violation-payload.dto';

/**
 * Centralized registry of all domain events handled by the distributed Event Bus.
 *
 * Priority levels:
 *   HIGH (1)   — Critical provisioning events (tenant.created)
 *   MEDIUM (5) — Standard domain events (brand.updated, guardrails.changed)
 *   LOW (10)   — Informational events (guardrails.violation)
 */
export const EVENT_REGISTRY: EventConfig[] = [
  {
    name: 'tenant.created',
    priority: EventPriorityLevel.HIGH,
    maxRetries: 5,
    ttl: DEFAULT_JOB_TTL_MS,
    concurrency: 3,
    dualEmit: true,
    payloadSchema: TenantCreatedPayloadDto,
  },
  {
    name: 'brand.updated',
    priority: EventPriorityLevel.MEDIUM,
    maxRetries: 3,
    ttl: DEFAULT_JOB_TTL_MS,
    concurrency: 3,
    dualEmit: true,
    payloadSchema: BrandUpdatedPayloadDto,
  },
  {
    name: 'guardrails.changed',
    priority: EventPriorityLevel.MEDIUM,
    maxRetries: 3,
    ttl: DEFAULT_JOB_TTL_MS,
    concurrency: 2,
    dualEmit: true,
    payloadSchema: GuardrailsChangedPayloadDto,
  },
  {
    name: 'guardrails.violation',
    priority: EventPriorityLevel.LOW,
    maxRetries: 1,
    ttl: REDUCED_JOB_TTL_MS,
    concurrency: 5,
    dualEmit: false,
    payloadSchema: GuardrailsViolationPayloadDto,
  },
];
