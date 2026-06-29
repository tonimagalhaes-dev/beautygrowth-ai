import { ConsumerOptions } from '../interfaces';

/**
 * Metadata key used to store @OnDistributedEvent handler bindings.
 * Used by the discovery mechanism (EventBusModule.onModuleInit) to auto-register workers.
 */
export const ON_DISTRIBUTED_EVENT_KEY = 'ON_DISTRIBUTED_EVENT';

/**
 * Metadata stored by the @OnDistributedEvent decorator.
 */
export interface OnDistributedEventMetadata {
  eventName: string;
  methodName: string | symbol;
  options?: ConsumerOptions;
}

/**
 * Decorator that registers a method as a consumer of a distributed domain event.
 * Equivalent to @OnEvent() from EventEmitter2 but for the distributed Event Bus.
 *
 * Usage:
 *   @OnDistributedEvent('tenant.created')
 *   async handleTenantCreated(payload: TenantCreatedPayload) { ... }
 *
 *   @OnDistributedEvent('brand.updated', { concurrency: 5, groupByTenant: true })
 *   async handleBrandUpdated(payload: BrandUpdatedPayload) { ... }
 *
 * @see Requirements 8.2, 8.3
 */
export function OnDistributedEvent(
  eventName: string,
  options?: ConsumerOptions,
): MethodDecorator {
  return (target, propertyKey, descriptor) => {
    // Accumulate metadata on the class (array of all handlers)
    const existingMetadata: OnDistributedEventMetadata[] =
      Reflect.getMetadata(ON_DISTRIBUTED_EVENT_KEY, target.constructor) || [];

    existingMetadata.push({
      eventName,
      methodName: propertyKey,
      options,
    });

    Reflect.defineMetadata(
      ON_DISTRIBUTED_EVENT_KEY,
      existingMetadata,
      target.constructor,
    );

    // Also store on the specific method for direct lookup
    Reflect.defineMetadata(
      ON_DISTRIBUTED_EVENT_KEY,
      { eventName, options } as Omit<OnDistributedEventMetadata, 'methodName'>,
      target,
      propertyKey,
    );

    return descriptor;
  };
}
