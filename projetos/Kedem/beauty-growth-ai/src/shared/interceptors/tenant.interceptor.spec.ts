import { Test, TestingModule } from '@nestjs/testing';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { of, throwError } from 'rxjs';
import { TenantInterceptor } from './tenant.interceptor';

describe('TenantInterceptor', () => {
  let interceptor: TenantInterceptor;
  let dataSource: DataSource;

  const mockDataSource = {
    query: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantInterceptor,
        { provide: DataSource, useValue: mockDataSource },
      ],
    }).compile();

    interceptor = module.get<TenantInterceptor>(TenantInterceptor);
    dataSource = module.get<DataSource>(DataSource);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(interceptor).toBeDefined();
  });

  function createMockContext(tenantContext?: any): ExecutionContext {
    const mockRequest: any = {
      headers: {},
      tenantContext,
    };

    return {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
      }),
    } as unknown as ExecutionContext;
  }

  function createMockCallHandler(returnValue: any = { data: 'test' }): CallHandler {
    return {
      handle: () => of(returnValue),
    };
  }

  function createErrorCallHandler(error: Error): CallHandler {
    return {
      handle: () => throwError(() => error),
    };
  }

  describe('intercept', () => {
    it('should set PostgreSQL session variable when tenantContext is present', async () => {
      mockDataSource.query.mockResolvedValue(undefined);

      const context = createMockContext({
        tenantId: 'tenant-123',
        userId: 'user-456',
        role: 'admin',
      });
      const handler = createMockCallHandler();

      const observable = await interceptor.intercept(context, handler);

      await new Promise<void>((resolve) => {
        observable.subscribe({
          complete: () => resolve(),
        });
      });

      expect(mockDataSource.query).toHaveBeenCalledWith(
        `SELECT set_config('app.current_tenant', $1, false)`,
        ['tenant-123'],
      );
    });

    it('should not set session variable when tenantContext is missing', async () => {
      const context = createMockContext(undefined);
      const handler = createMockCallHandler();

      const observable = await interceptor.intercept(context, handler);

      await new Promise<void>((resolve) => {
        observable.subscribe({
          complete: () => resolve(),
        });
      });

      expect(mockDataSource.query).not.toHaveBeenCalled();
    });

    it('should not set session variable when tenantId is missing from context', async () => {
      const context = createMockContext({
        userId: 'user-456',
        role: 'admin',
      });
      const handler = createMockCallHandler();

      const observable = await interceptor.intercept(context, handler);

      await new Promise<void>((resolve) => {
        observable.subscribe({
          complete: () => resolve(),
        });
      });

      expect(mockDataSource.query).not.toHaveBeenCalled();
    });

    it('should pass through the response from the handler', async () => {
      mockDataSource.query.mockResolvedValue(undefined);

      const context = createMockContext({
        tenantId: 'tenant-123',
        userId: 'user-456',
        role: 'admin',
      });
      const expectedResponse = { id: 1, name: 'test' };
      const handler = createMockCallHandler(expectedResponse);

      const observable = await interceptor.intercept(context, handler);

      const result = await new Promise((resolve) => {
        observable.subscribe({
          next: (value) => resolve(value),
        });
      });

      expect(result).toEqual(expectedResponse);
    });

    it('should reset session variable on handler error', async () => {
      mockDataSource.query.mockResolvedValue(undefined);

      const context = createMockContext({
        tenantId: 'tenant-123',
        userId: 'user-456',
        role: 'admin',
      });
      const handler = createErrorCallHandler(new Error('DB Error'));

      const observable = await interceptor.intercept(context, handler);

      await new Promise<void>((resolve) => {
        observable.subscribe({
          error: () => resolve(),
        });
      });

      // First call is the set_config for tenant, second is the reset
      expect(mockDataSource.query).toHaveBeenCalledWith(
        `SELECT set_config('app.current_tenant', $1, false)`,
        ['tenant-123'],
      );
      expect(mockDataSource.query).toHaveBeenCalledWith(
        `SELECT set_config('app.current_tenant', '', false)`,
      );
    });

    it('should throw when setting session variable fails', async () => {
      mockDataSource.query.mockRejectedValue(new Error('Connection error'));

      const context = createMockContext({
        tenantId: 'tenant-123',
        userId: 'user-456',
        role: 'admin',
      });
      const handler = createMockCallHandler();

      await expect(interceptor.intercept(context, handler)).rejects.toThrow('Connection error');
    });

    it('should use parameterized query to prevent SQL injection', async () => {
      mockDataSource.query.mockResolvedValue(undefined);

      const maliciousTenantId = "'; DROP TABLE users; --";
      const context = createMockContext({
        tenantId: maliciousTenantId,
        userId: 'user-456',
        role: 'admin',
      });
      const handler = createMockCallHandler();

      const observable = await interceptor.intercept(context, handler);

      await new Promise<void>((resolve) => {
        observable.subscribe({ complete: () => resolve() });
      });

      // Should pass the value as a parameter, not inline
      expect(mockDataSource.query).toHaveBeenCalledWith(
        `SELECT set_config('app.current_tenant', $1, false)`,
        [maliciousTenantId],
      );
    });
  });
});
