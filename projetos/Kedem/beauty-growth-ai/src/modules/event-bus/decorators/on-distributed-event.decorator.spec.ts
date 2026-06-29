import 'reflect-metadata';

import {
  ON_DISTRIBUTED_EVENT_KEY,
  OnDistributedEvent,
  OnDistributedEventMetadata,
} from './on-distributed-event.decorator';

describe('@OnDistributedEvent', () => {
  it('should store metadata on the decorated method', () => {
    class TestConsumer {
      @OnDistributedEvent('tenant.created')
      async handleTenantCreated() {}
    }

    const metadata = Reflect.getMetadata(
      ON_DISTRIBUTED_EVENT_KEY,
      TestConsumer.prototype,
      'handleTenantCreated',
    );

    expect(metadata).toBeDefined();
    expect(metadata.eventName).toBe('tenant.created');
    expect(metadata.options).toBeUndefined();
  });

  it('should store metadata with options on the decorated method', () => {
    class TestConsumer {
      @OnDistributedEvent('brand.updated', {
        concurrency: 5,
        groupByTenant: true,
      })
      async handleBrandUpdated() {}
    }

    const metadata = Reflect.getMetadata(
      ON_DISTRIBUTED_EVENT_KEY,
      TestConsumer.prototype,
      'handleBrandUpdated',
    );

    expect(metadata).toBeDefined();
    expect(metadata.eventName).toBe('brand.updated');
    expect(metadata.options).toEqual({
      concurrency: 5,
      groupByTenant: true,
    });
  });

  it('should accumulate metadata on the class for multiple decorated methods', () => {
    class TestConsumer {
      @OnDistributedEvent('tenant.created')
      async handleTenantCreated() {}

      @OnDistributedEvent('brand.updated', { concurrency: 3 })
      async handleBrandUpdated() {}
    }

    const classMetadata: OnDistributedEventMetadata[] = Reflect.getMetadata(
      ON_DISTRIBUTED_EVENT_KEY,
      TestConsumer,
    );

    expect(classMetadata).toBeDefined();
    expect(classMetadata).toHaveLength(2);

    expect(classMetadata[0]).toEqual({
      eventName: 'tenant.created',
      methodName: 'handleTenantCreated',
      options: undefined,
    });

    expect(classMetadata[1]).toEqual({
      eventName: 'brand.updated',
      methodName: 'handleBrandUpdated',
      options: { concurrency: 3 },
    });
  });

  it('should support multiple decorators for the same event on different methods', () => {
    class TestConsumer {
      @OnDistributedEvent('tenant.created')
      async handleKnowledgeHubInit() {}

      @OnDistributedEvent('tenant.created')
      async handleBusinessMemoryInit() {}
    }

    const classMetadata: OnDistributedEventMetadata[] = Reflect.getMetadata(
      ON_DISTRIBUTED_EVENT_KEY,
      TestConsumer,
    );

    expect(classMetadata).toHaveLength(2);
    expect(classMetadata[0].eventName).toBe('tenant.created');
    expect(classMetadata[0].methodName).toBe('handleKnowledgeHubInit');
    expect(classMetadata[1].eventName).toBe('tenant.created');
    expect(classMetadata[1].methodName).toBe('handleBusinessMemoryInit');
  });

  it('should store ConsumerOptions with only concurrency', () => {
    class TestConsumer {
      @OnDistributedEvent('guardrails.violation', { concurrency: 10 })
      async handleViolation() {}
    }

    const metadata = Reflect.getMetadata(
      ON_DISTRIBUTED_EVENT_KEY,
      TestConsumer.prototype,
      'handleViolation',
    );

    expect(metadata.options).toEqual({ concurrency: 10 });
  });

  it('should store ConsumerOptions with only groupByTenant', () => {
    class TestConsumer {
      @OnDistributedEvent('guardrails.changed', { groupByTenant: false })
      async handleGuardrailsChanged() {}
    }

    const metadata = Reflect.getMetadata(
      ON_DISTRIBUTED_EVENT_KEY,
      TestConsumer.prototype,
      'handleGuardrailsChanged',
    );

    expect(metadata.options).toEqual({ groupByTenant: false });
  });

  it('should not mutate class metadata across different classes', () => {
    class ConsumerA {
      @OnDistributedEvent('tenant.created')
      async handle() {}
    }

    class ConsumerB {
      @OnDistributedEvent('brand.updated')
      async handle() {}
    }

    const metadataA: OnDistributedEventMetadata[] = Reflect.getMetadata(
      ON_DISTRIBUTED_EVENT_KEY,
      ConsumerA,
    );
    const metadataB: OnDistributedEventMetadata[] = Reflect.getMetadata(
      ON_DISTRIBUTED_EVENT_KEY,
      ConsumerB,
    );

    expect(metadataA).toHaveLength(1);
    expect(metadataA[0].eventName).toBe('tenant.created');

    expect(metadataB).toHaveLength(1);
    expect(metadataB[0].eventName).toBe('brand.updated');
  });

  it('should preserve the method descriptor', () => {
    class TestConsumer {
      @OnDistributedEvent('tenant.created')
      async handleTenantCreated(): Promise<string> {
        return 'done';
      }
    }

    const instance = new TestConsumer();
    return expect(instance.handleTenantCreated()).resolves.toBe('done');
  });
});
