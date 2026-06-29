import { Injectable, Logger } from '@nestjs/common';
import { OnDistributedEvent } from '../decorators/on-distributed-event.decorator';
import { GuardrailsChangedPayloadDto } from '../dto/guardrails-changed-payload.dto';

/**
 * Distributed consumer for guardrails cache invalidation.
 * Handles guardrails.changed events to invalidate guardrails cache.
 *
 * @see Requirements 2.3
 */
@Injectable()
export class GuardrailsCacheConsumer {
  private readonly logger = new Logger(GuardrailsCacheConsumer.name);

  @OnDistributedEvent('guardrails.changed')
  async handleCacheInvalidation(
    payload: GuardrailsChangedPayloadDto,
  ): Promise<void> {
    this.logger.log(
      `Invalidating guardrails cache for tenant ${payload.tenantId}, ` +
        `guardrail ${payload.guardrailId} (action: ${payload.action}, correlationId: ${payload.correlationId})`,
    );
    // TODO: Connect to cache service for invalidation
    // await this.cacheService.invalidateGuardrails(payload.tenantId, payload.guardrailId);
  }
}
