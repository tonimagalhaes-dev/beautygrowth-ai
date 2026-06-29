import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './services/auth.service';

describe('AuthController', () => {
  let controller: AuthController;
  let authService: jest.Mocked<AuthService>;

  const mockTokenPair = {
    accessToken: 'mock-access-token',
    refreshToken: 'mock-refresh-token',
  };

  const mockAuthResponse = {
    user: {
      id: 'user-uuid-1',
      email: 'test@example.com',
      role: 'admin' as const,
      tenantId: 'tenant-uuid-1',
    },
    tokens: mockTokenPair,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: {
            register: jest.fn().mockResolvedValue(mockAuthResponse),
            login: jest.fn().mockResolvedValue(mockTokenPair),
            verifyEmail: jest.fn().mockResolvedValue(undefined),
            refreshToken: jest.fn().mockResolvedValue(mockTokenPair),
            requestPasswordReset: jest.fn().mockResolvedValue(undefined),
            resetPassword: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
    authService = module.get(AuthService) as jest.Mocked<AuthService>;
  });

  describe('POST /auth/register', () => {
    it('should call authService.register and return AuthResponse', async () => {
      const dto = {
        email: 'new@example.com',
        password: 'StrongPass1!',
        clinicName: 'My Clinic',
      };

      const result = await controller.register(dto);

      expect(authService.register).toHaveBeenCalledWith(dto);
      expect(result).toEqual(mockAuthResponse);
    });
  });

  describe('POST /auth/login', () => {
    it('should call authService.login and return TokenPair', async () => {
      const dto = { email: 'test@example.com', password: 'StrongPass1!' };

      const result = await controller.login(dto);

      expect(authService.login).toHaveBeenCalledWith(dto);
      expect(result).toEqual(mockTokenPair);
    });
  });

  describe('POST /auth/verify-email', () => {
    it('should call authService.verifyEmail and return success message', async () => {
      const result = await controller.verifyEmail('valid-token');

      expect(authService.verifyEmail).toHaveBeenCalledWith('valid-token');
      expect(result).toEqual({ message: 'Email verified successfully' });
    });
  });

  describe('POST /auth/refresh-token', () => {
    it('should call authService.refreshToken and return new TokenPair', async () => {
      const dto = { refreshToken: 'valid-refresh-token' };

      const result = await controller.refreshToken(dto);

      expect(authService.refreshToken).toHaveBeenCalledWith('valid-refresh-token');
      expect(result).toEqual(mockTokenPair);
    });
  });

  describe('POST /auth/request-password-reset', () => {
    it('should call authService.requestPasswordReset and return generic message', async () => {
      const dto = { email: 'test@example.com' };

      const result = await controller.requestPasswordReset(dto);

      expect(authService.requestPasswordReset).toHaveBeenCalledWith('test@example.com');
      expect(result.message).toContain('reset link has been sent');
    });
  });

  describe('POST /auth/reset-password', () => {
    it('should call authService.resetPassword and return success message', async () => {
      const dto = { token: 'reset-token', newPassword: 'NewPass1!' };

      const result = await controller.resetPassword(dto);

      expect(authService.resetPassword).toHaveBeenCalledWith(dto);
      expect(result).toEqual({ message: 'Password reset successfully' });
    });
  });
});
