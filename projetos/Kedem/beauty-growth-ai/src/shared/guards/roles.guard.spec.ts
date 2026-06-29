import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { PermissionsService } from '../services/permissions.service';
import { ROLES_KEY } from '../decorators/roles.decorator';

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: Reflector;

  const mockReflector = {
    getAllAndOverride: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RolesGuard,
        PermissionsService,
        { provide: Reflector, useValue: mockReflector },
      ],
    }).compile();

    guard = module.get<RolesGuard>(RolesGuard);
    reflector = module.get<Reflector>(Reflector);

    jest.clearAllMocks();
  });

  function createMockExecutionContext(tenantContext?: any): ExecutionContext {
    const mockRequest: any = {
      headers: { authorization: 'Bearer valid-token' },
      ip: '127.0.0.1',
      path: '/test',
      method: 'GET',
    };

    if (tenantContext !== undefined) {
      mockRequest.tenantContext = tenantContext;
    }

    return {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
      }),
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
    } as unknown as ExecutionContext;
  }

  it('should be defined', () => {
    expect(guard).toBeDefined();
  });

  describe('No @Roles() decorator', () => {
    it('should allow access when no roles are required (no decorator)', () => {
      mockReflector.getAllAndOverride.mockReturnValue(undefined);
      const context = createMockExecutionContext({ tenantId: 't1', userId: 'u1', role: 'viewer' });
      expect(guard.canActivate(context)).toBe(true);
    });

    it('should allow access when roles array is empty', () => {
      mockReflector.getAllAndOverride.mockReturnValue([]);
      const context = createMockExecutionContext({ tenantId: 't1', userId: 'u1', role: 'viewer' });
      expect(guard.canActivate(context)).toBe(true);
    });
  });

  describe('Missing tenant context', () => {
    it('should throw ForbiddenException when tenantContext is missing', () => {
      mockReflector.getAllAndOverride.mockReturnValue(['admin']);
      const context = createMockExecutionContext(undefined);
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('should throw with specific message about missing context', () => {
      mockReflector.getAllAndOverride.mockReturnValue(['admin']);
      const context = createMockExecutionContext(undefined);
      expect(() => guard.canActivate(context)).toThrow(
        'Access denied: missing authentication context',
      );
    });
  });

  describe('Role-based access control', () => {
    it('should allow admin when admin role is required', () => {
      mockReflector.getAllAndOverride.mockReturnValue(['admin']);
      const context = createMockExecutionContext({
        tenantId: 'tenant-1',
        userId: 'user-1',
        role: 'admin',
      });
      expect(guard.canActivate(context)).toBe(true);
    });

    it('should allow operator when operator or admin roles are required', () => {
      mockReflector.getAllAndOverride.mockReturnValue(['admin', 'operator']);
      const context = createMockExecutionContext({
        tenantId: 'tenant-1',
        userId: 'user-1',
        role: 'operator',
      });
      expect(guard.canActivate(context)).toBe(true);
    });

    it('should allow viewer when all roles are required', () => {
      mockReflector.getAllAndOverride.mockReturnValue(['admin', 'operator', 'viewer']);
      const context = createMockExecutionContext({
        tenantId: 'tenant-1',
        userId: 'user-1',
        role: 'viewer',
      });
      expect(guard.canActivate(context)).toBe(true);
    });

    it('should deny viewer when only admin is required', () => {
      mockReflector.getAllAndOverride.mockReturnValue(['admin']);
      const context = createMockExecutionContext({
        tenantId: 'tenant-1',
        userId: 'user-1',
        role: 'viewer',
      });
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('should deny operator when only admin is required', () => {
      mockReflector.getAllAndOverride.mockReturnValue(['admin']);
      const context = createMockExecutionContext({
        tenantId: 'tenant-1',
        userId: 'user-1',
        role: 'operator',
      });
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('should deny viewer when admin and operator are required', () => {
      mockReflector.getAllAndOverride.mockReturnValue(['admin', 'operator']);
      const context = createMockExecutionContext({
        tenantId: 'tenant-1',
        userId: 'user-1',
        role: 'viewer',
      });
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('should throw with insufficient permissions message', () => {
      mockReflector.getAllAndOverride.mockReturnValue(['admin']);
      const context = createMockExecutionContext({
        tenantId: 'tenant-1',
        userId: 'user-1',
        role: 'viewer',
      });
      expect(() => guard.canActivate(context)).toThrow(
        'Access denied: insufficient permissions',
      );
    });
  });

  describe('Reflector usage', () => {
    it('should read metadata using ROLES_KEY from handler and class', () => {
      mockReflector.getAllAndOverride.mockReturnValue(['admin']);
      const context = createMockExecutionContext({
        tenantId: 'tenant-1',
        userId: 'user-1',
        role: 'admin',
      });
      guard.canActivate(context);

      expect(mockReflector.getAllAndOverride).toHaveBeenCalledWith(
        ROLES_KEY,
        expect.arrayContaining([expect.any(Function), expect.any(Function)]),
      );
    });
  });
});
