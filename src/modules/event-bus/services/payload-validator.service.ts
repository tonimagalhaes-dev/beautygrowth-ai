import { Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';

import { EVENT_REGISTRY } from '../config/event-registry';

/**
 * Validates event payloads against their registered class-validator schema.
 *
 * Looks up the EventConfig for a given eventName in EVENT_REGISTRY,
 * transforms the plain payload into the DTO instance, and runs
 * class-validator constraints. Throws a descriptive error listing
 * all invalid fields when validation fails.
 *
 * @see Requirements 9.3, 5.1
 */
@Injectable()
export class PayloadValidator {
  /**
   * Validates a payload against the schema defined in EVENT_REGISTRY for the given event.
   *
   * @param eventName - The event name to look up in the registry (e.g., 'tenant.created')
   * @param payload - The plain object payload to validate
   * @throws Error with descriptive message listing invalid fields and their constraints
   */
  async validatePayload(
    eventName: string,
    payload: Record<string, any>,
  ): Promise<void> {
    const eventConfig = EVENT_REGISTRY.find((e) => e.name === eventName);
    if (!eventConfig) {
      throw new Error(`Event '${eventName}' not found in registry`);
    }

    const instance = plainToInstance(eventConfig.payloadSchema, payload);
    const errors = await validate(instance as object, {
      whitelist: true,
      forbidNonWhitelisted: false,
    });

    if (errors.length > 0) {
      const errorMessages = this.formatErrors(errors);
      throw new Error(
        `Payload validation failed for '${eventName}': ${errorMessages.join('; ')}`,
      );
    }
  }

  /**
   * Formats ValidationError[] into human-readable messages.
   * Each message shows the field name and the constraints that failed.
   */
  private formatErrors(errors: ValidationError[], parentPath = ''): string[] {
    const messages: string[] = [];

    for (const error of errors) {
      const fieldPath = parentPath
        ? `${parentPath}.${error.property}`
        : error.property;

      if (error.constraints) {
        const constraintMessages = Object.values(error.constraints);
        messages.push(`${fieldPath}: ${constraintMessages.join(', ')}`);
      }

      // Handle nested validation errors
      if (error.children && error.children.length > 0) {
        messages.push(...this.formatErrors(error.children, fieldPath));
      }
    }

    return messages;
  }
}
