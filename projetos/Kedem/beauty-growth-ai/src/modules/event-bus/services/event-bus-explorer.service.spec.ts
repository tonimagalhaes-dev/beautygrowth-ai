import { DiscoveryService } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';

import {
  ON_DISTRIBUTED_EVENT_KEY,
  OnDistributedEvent,
} from '../decorators/on-distributed-event.decorator';
import { EventBusService } from './event-bus.service';
import { EventBusExplorer } from './event-bus-explorer.service';

// ─── Test fixtures: providers with and without decorator ─────────────────────

class DecoratedProvider {
  @OnDistributedEvent('tenant.created')
  async handleTenantCreated(payload: any): Promise<void> {
    // handler logic
  }

  @OnDistributedEvent('brand.updated', { concurrency: 5 })
  async handleBrandUpdated(payload: any): Promise<void> {
    // handler logic
  }
}

class AnotherDecoratedProvider {
  @OnDistributedEvent('guardrails.changed', { groupByTenant: true })
  async handleGuardrailsChanged(payload: any): Promise<void> {
    // handler logic
  }
}

class PlainProvider {
  async doSomething(): Promise<void> {
    // no decorator
  }
}

describe('EventBusExplorer', () => {
  let explorer: EventBusExplorer;
  let eventBusService: jest.Mocked<EventBusService>;
  let discoveryService: jest.Mocked<DiscoveryService>;

  beforeEach(async () => {
    const decoratedInstance = new DecoratedProvider();
    const anotherDecoratedInstance = new AnotherDecoratedProvider();
    const plainInstance = new PlainProvider();

    const mockDiscoveryService = {
      getProviders: jest.fn().mockReturnValue([
        { instance: decoratedInstance },
        { instance: anotherDecoratedInstance },
        { instance: plainInstance },
        { instance: null }, // edge case: null instance
        { instance: undefined }, // edge case: undefined instance
      ]),
    };

    const mockEventBusService = {
      subscribe: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventBusExplorer,
        {
          provide: DiscoveryService,
          useValue: mockDiscoveryService,
        },
        {
          provide: EventBusService,
          useValue: mockEventBusService,
        },
      ],
    }).compile();

    explorer = module.get<EventBusExplorer>(EventBusExplorer);
    eventBusService = module.get(EventBusService);
    discoveryService = module.get(DiscoveryService);
  });

  describe('onModuleInit()', () => {
    it('should discover decorated methods and call subscribe for each', () => {
      explorer.onModuleInit();

      expect(eventBusService.subscribe).toHaveBeenCalledTimes(3);
    });

    it('should subscribe tenant.created handler from DecoratedProvider', () => {
      explorer.onModuleInit();

      expect(eventBusService.subscribe).toHaveBeenCalledWith(
        'tenant.created',
        expect.any(Function),
        undefined,
      );
    });

    it('should subscribe brand.updated handler with concurrency option', () => {
      explorer.onModuleInit();

      expect(eventBusService.subscribe).toHaveBeenCalledWith(
        'brand.updated',
        expect.any(Function),
        { concurrency: 5 },
      );
    });

    it('should subscribe guardrails.changed handler with groupByTenant option', () => {
      explorer.onModuleInit();

      expect(eventBusService.subscribe).toHaveBeenCalledWith(
        'guardrails.changed',
        expect.any(Function),
        { groupByTenant: true },
      );
    });

    it('should skip providers without @OnDistributedEvent decorators', () => {
      explorer.onModuleInit();

      // Only 3 calls: 2 from DecoratedProvider + 1 from AnotherDecoratedProvider
      // PlainProvider has no decorators → no subscribe calls for it
      expect(eventBusService.subscribe).toHaveBeenCalledTimes(3);
      expect(eventBusService.subscribe).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Function),
        expect.objectContaining({ eventName: 'doSomething' }),
      );
    });

    it('should skip null or undefined provider instances', () => {
      explorer.onModuleInit();

      // Should not throw and should still register the 3 valid handlers
      expect(eventBusService.subscribe).toHaveBeenCalledTimes(3);
    });

    it('should bind handler to the provider instance', () => {
      explorer.onModuleInit();

      // Verify the handler is a function (bound method)
      const firstCall = eventBusService.subscribe.mock.calls[0];
      const boundHandler = firstCall[1];
      expect(typeof boundHandler).toBe('function');
    });

    it('should call subscribe with the correct handler binding', async () => {
      const decoratedInstance = new DecoratedProvider();
      const spy = jest.spyOn(decoratedInstance, 'handleTenantCreated');

      // Override discovery to return our spied instance
      discoveryService.getProviders.mockReturnValue([
        { instance: decoratedInstance } as any,
      ]);

      explorer.onModuleInit();

      // Get the bound handler that was passed to subscribe
      const boundHandler = eventBusService.subscribe.mock.calls[0][1];

      // Call the bound handler and verify it delegates to the original method
      const testPayload = { tenantId: 'test-tenant-id' };
      await boundHandler(testPayload);

      expect(spy).toHaveBeenCalledWith(testPayload);
    });
  });
});
