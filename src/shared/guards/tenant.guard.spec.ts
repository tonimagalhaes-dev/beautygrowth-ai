import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { TenantGuard, TokenPayload } from './tenant.guard';

describe('TenantGuard', () => {
  let guard: TenantGuard;
  let jwtService: JwtService;

  const mockJwtService = {
    verifyAsync: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn().mockReturnValue('test-jwt-secret'),
  };

  function createMockExecutionContext(headers: Record<string, string> = {}): ExecutionContext {
    const mockRequest = {
      headers,
      ip: '127.0.0.1',
      path: '/test',
      method: 'GET',
    };

    return {
      switchToHttp: () => ({
        getRequest: () => mockRequest,
      }),
    } as unknown as ExecutionContext;
  }

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantGuard,
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    guard = module.get<TenantGuard>(TenantGuard);
    jwtService = module.get<JwtService>(JwtService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(guard).toBeDefined();
  });

  describe('canActivate', () => {
    it('should throw UnauthorizedException when no authorization header is present', async () => {
      const context = createMockExecutionContext({});
      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException when authorization header has wrong format', async () => {
      const context = createMockExecutionContext({ authorization: 'Basic abc123' });
      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException when token is invalid', async () => {
      mockJwtService.verifyAsync.mockRejectedValue(new Error('invalid token'));
      const context = createMockExecutionContext({ authorization: 'Bearer invalid-token' });
      await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    });

    it('should throw ForbiddenException when tenantId is missing from payload', async () => {
      const payload: Partial<TokenPayload> = {
        userId: 'user-123',
        role: 'admin',
        iat: 1000,
        exp: 2000,
      };
      mockJwtService.verifyAsync.mockResolvedValue(payload);
      const context = createMockExecutionContext({ authorization: 'Bearer valid-token' });
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('should throw ForbiddenException when userId is missing from payload', async () => {
      const payload: Partial<TokenPayload> = {
        tenantId: 'tenant-123',
        role: 'admin',
        iat: 1000,
        exp: 2000,
      };
      mockJwtService.verifyAsync.mockResolvedValue(payload);
      const context = createMockExecutionContext({ authorization: 'Bearer valid-token' });
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('should throw ForbiddenException when role is missing from payload', async () => {
      const payload: Partial<TokenPayload> = {
        userId: 'user-123',
        tenantId: 'tenant-123',
        iat: 1000,
        exp: 2000,
      };
      mockJwtService.verifyAsync.mockResolvedValue(payload);
      const context = createMockExecutionContext({ authorization: 'Bearer valid-token' });
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    });

    it('should return true and attach tenantContext for valid token with all fields', async () => {
      const payload: TokenPayload = {
        userId: 'user-123',
        tenantId: 'tenant-456',
        role: 'admin',
        iat: 1000,
        exp: 2000,
      };
      mockJwtService.verifyAsync.mockResolvedValue(payload);

      const mockRequest: any = {
        headers: { authorization: 'Bearer valid-token' },
        ip: '127.0.0.1',
        path: '/test',
        method: 'GET',
      };

      const context = {
        switchToHttp: () => ({
          getRequest: () => mockRequest,
        }),
      } as unknown as ExecutionContext;

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(mockRequest.tenantContext).toEqual({
        tenantId: 'tenant-456',
        userId: 'user-123',
        role: 'admin',
      });
    });

    it('should work with operator role', async () => {
      const payload: TokenPayload = {
        userId: 'user-789',
        tenantId: 'tenant-001',
        role: 'operator',
        iat: 1000,
        exp: 2000,
      };
      mockJwtService.verifyAsync.mockResolvedValue(payload);

      const mockRequest: any = {
        headers: { authorization: 'Bearer valid-token' },
        ip: '127.0.0.1',
        path: '/api/clinics',
        method: 'POST',
      };

      const context = {
        switchToHttp: () => ({
          getRequest: () => mockRequest,
        }),
      } as unknown as ExecutionContext;

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(mockRequest.tenantContext).toEqual({
        tenantId: 'tenant-001',
        userId: 'user-789',
        role: 'operator',
      });
    });

    it('should work with viewer role', async () => {
      const payload: TokenPayload = {
        userId: 'user-viewer',
        tenantId: 'tenant-view',
        role: 'viewer',
        iat: 1000,
        exp: 2000,
      };
      mockJwtService.verifyAsync.mockResolvedValue(payload);

      const mockRequest: any = {
        headers: { authorization: 'Bearer viewer-token' },
        ip: '127.0.0.1',
        path: '/api/reports',
        method: 'GET',
      };

      const context = {
        switchToHttp: () => ({
          getRequest: () => mockRequest,
        }),
      } as unknown as ExecutionContext;

      const result = await guard.canActivate(context);

      expect(result).toBe(true);
      expect(mockRequest.tenantContext.role).toBe('viewer');
    });

    it('should use JWT_SECRET from ConfigService', async () => {
      const payload: TokenPayload = {
        userId: 'user-123',
        tenantId: 'tenant-456',
        role: 'admin',
        iat: 1000,
        exp: 2000,
      };
      mockJwtService.verifyAsync.mockResolvedValue(payload);

      const mockRequest: any = {
        headers: { authorization: 'Bearer some-token' },
        ip: '127.0.0.1',
        path: '/test',
        method: 'GET',
      };

      const context = {
        switchToHttp: () => ({
          getRequest: () => mockRequest,
        }),
      } as unknown as ExecutionContext;

      await guard.canActivate(context);

      expect(mockJwtService.verifyAsync).toHaveBeenCalledWith('some-token', {
        secret: 'test-jwt-secret',
      });
    });
  });
});
