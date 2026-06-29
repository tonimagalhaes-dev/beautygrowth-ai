import { Injectable, Logger } from '@nestjs/common';
import { OnDistributedEvent } from '../decorators/on-distributed-event.decorator';
import { GuardrailsViolationPayloadDto } from '../dto/guardrails-violation-payload.dto';

/**
 * Distributed consumer for guardrails violation events.
 * Handles guardrails.violation events for asynchronous processing by the Observability module.
 *
 * @see Requirements 2.4
 */
@Injectable()
export class GuardrailsViolationConsumer {
  private readonly logger = new Logger(GuardrailsViolationConsumer.name);

  @OnDistributedEvent('guardrails.violation')
  async handleViolationLogging(payload: GuardrailsViolationPayloadDto): Promise<void> {
    this.logger.warn(
      `Guardrails violation detected: tenant=${payload.tenantId}, agent=${payload.agentId}, ` +
      `rule=${payload.guardrailName}, type=${payload.violationType} (correlationId: ${payload.correlationId})`,
    );
    // TODO: Connect to ObservabilityService for violation processing
    // await this.observabilityService.recordViolation(payload);
  }
}
