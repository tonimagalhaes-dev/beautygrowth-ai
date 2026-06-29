/**
 * Event Bus Constants
 *
 * Central configuration values for the distributed event bus module.
 * All Redis keys are prefixed with REDIS_PREFIX to avoid collisions.
 */

/** Namespace prefix for all Redis keys used by the Event Bus */
export const REDIS_PREFIX = 'beautygrowth:events:';

/** Maximum time (ms) to buffer events locally when Redis is disconnected */
export const CONNECTION_BUFFER_TTL_MS = 30_000;

/** Maximum delay (ms) between reconnection attempts */
export const MAX_RECONNECT_DELAY_MS = 16_000;

/** Base delay (ms) for exponential backoff calculations */
export const BASE_RETRY_DELAY_MS = 1_000;

/** Maximum concurrent jobs per tenant to prevent monopolization */
export const MAX_CONCURRENT_PER_TENANT = 5;

/** Default job TTL in milliseconds (24 hours) */
export const DEFAULT_JOB_TTL_MS = 86_400_000;

/** Reduced job TTL for low-priority events (12 hours) */
export const REDUCED_JOB_TTL_MS = 43_200_000;

/**
 * Priority levels for event processing.
 * Lower numeric values = higher processing priority.
 */
export enum EventPriorityLevel {
  HIGH = 1,
  MEDIUM = 5,
  LOW = 10,
}
