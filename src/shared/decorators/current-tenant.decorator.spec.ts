import { ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { CurrentTenant } from './current-tenant.decorator';

/**
 * Helper to test NestJS param decorators.
 * Extracts the factory function from the decorator metadata.
 */
function getParamDecoratorFactory(decorator: Function) {
  class TestController {
    testMethod(_param: any) {}
  }

  // Apply the decorator to a test method
  decorator()(TestController.prototype, 'testMethod', 0);

  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, TestController, 'testMethod');
  return args[Object.keys(args)[0]].factory;
}

describe('CurrentTenant Decorator', () => {
  function createMockExecutionContext(tenantContext?: any): ExecutionContext {
    const mockRequest = { tenantContext };
    return {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
      }),
    } as unknown as ExecutionContext;
  }

  it('should return the full tenantContext when no data key is specified', () => {
    const factory = getParamDecoratorFactory(CurrentTenant);
    const tenantContext = {
      tenantId: 'tenant-123',
      userId: 'user-456',
      role: 'admin' as const,
    };
    const ctx = createMockExecutionContext(tenantContext);

    const result = factory(undefined, ctx);

    expect(result).toEqual(tenantContext);
  });

  it('should return tenantId when "tenantId" is passed as data', () => {
    const factory = getParamDecoratorFactory(CurrentTenant);
    const tenantContext = {
      tenantId: 'tenant-789',
      userId: 'user-101',
      role: 'operator' as const,
    };
    const ctx = createMockExecutionContext(tenantContext);

    const result = factory('tenantId', ctx);

    expect(result).toBe('tenant-789');
  });

  it('should return userId when "userId" is passed as data', () => {
    const factory = getParamDecoratorFactory(CurrentTenant);
    const tenantContext = {
      tenantId: 'tenant-789',
      userId: 'user-101',
      role: 'viewer' as const,
    };
    const ctx = createMockExecutionContext(tenantContext);

    const result = factory('userId', ctx);

    expect(result).toBe('user-101');
  });

  it('should return role when "role" is passed as data', () => {
    const factory = getParamDecoratorFactory(CurrentTenant);
    const tenantContext = {
      tenantId: 'tenant-789',
      userId: 'user-101',
      role: 'viewer' as const,
    };
    const ctx = createMockExecutionContext(tenantContext);

    const result = factory('role', ctx);

    expect(result).toBe('viewer');
  });

  it('should return undefined when tenantContext is not present on request', () => {
    const factory = getParamDecoratorFactory(CurrentTenant);
    const ctx = createMockExecutionContext(undefined);

    const result = factory(undefined, ctx);

    expect(result).toBeUndefined();
  });

  it('should return undefined when tenantContext is not set and a key is requested', () => {
    const factory = getParamDecoratorFactory(CurrentTenant);
    const ctx = createMockExecutionContext(undefined);

    const result = factory('tenantId', ctx);

    expect(result).toBeUndefined();
  });
});
