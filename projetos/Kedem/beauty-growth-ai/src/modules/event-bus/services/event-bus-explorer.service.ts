import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';

import {
  ON_DISTRIBUTED_EVENT_KEY,
  OnDistributedEventMetadata,
} from '../decorators/on-distributed-event.decorator';
import { EventBusService } from './event-bus.service';

/**
 * Discovers and auto-registers all @OnDistributedEvent-decorated handlers
 * by scanning registered providers at module initialization.
 *
 * Uses NestJS DiscoveryService to iterate providers and Reflect metadata
 * to identify decorated methods, then calls EventBusService.subscribe()
 * for each handler found.
 *
 * @see Requirements 8.3, 9.2
 */
@Injectable()
export class EventBusExplorer implements OnModuleInit {
  private readonly logger = new Logger(EventBusExplorer.name);

  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly eventBusService: EventBusService,
  ) {}

  onModuleInit(): void {
    const providers = this.discoveryService.getProviders();

    for (const wrapper of providers) {
      const { instance } = wrapper;
      if (!instance || !instance.constructor) continue;

      const metadata: OnDistributedEventMetadata[] =
        Reflect.getMetadata(ON_DISTRIBUTED_EVENT_KEY, instance.constructor) ||
        [];

      for (const { eventName, methodName, options } of metadata) {
        const handler = instance[methodName as string].bind(instance);
        this.eventBusService.subscribe(eventName, handler, options);
        this.logger.log(
          `Registered consumer: ${instance.constructor.name}.${String(methodName)} → ${eventName}`,
        );
      }
    }
  }
}
