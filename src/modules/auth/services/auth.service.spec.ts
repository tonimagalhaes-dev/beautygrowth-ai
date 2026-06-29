import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  ConflictException,
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { AuthService } from './auth.service';
import { User } from '../entities/user.entity';
import { Tenant } from '../entities/tenant.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { EmailVerificationToken } from '../entities/email-verification-token.entity';
import { PasswordResetToken } from '../entities/password-reset-token.entity';
import { EMAIL_SERVICE } from '../interfaces/email-service.interface';

// Mock bcrypt
jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('$2b$12$hashedpassword'),
  compare: jest.fn().mockResolvedValue(true),
}));

describe('AuthService', () => {
  let service: AuthService;
  let userRepository: jest.Mocked<Repository<User>>;
  let tenantRepository: jest.Mocked<Repository<Tenant>>;
  let refreshTokenRepository: jest.Mocked<Repository<RefreshToken>>;
  let emailVerificationTokenRepository: jest.Mocked<Repository<EmailVerificationToken>>;
  let passwordResetTokenRepository: jest.Mocked<Repository<PasswordResetToken>>;
  let jwtService: jest.Mocked<JwtService>;
  let dataSource: jest.Mocked<DataSource>;
  let emailService: any;

  const mockUser: Partial<User> = {
    id: 'user-uuid-1',
    tenantId: 'tenant-uuid-1',
    email: 'test@example.com',
    passwordHash: '$2b$12$hashedpassword',
    role: 'admin',
    emailVerified: false,
    failedLoginAttempts: 0,
    lockedUntil: null,
    createdAt: new Date(),
  };

  const mockTenant: Partial<Tenant> = {
    id: 'tenant-uuid-1',
    slug: 'test-clinic-abc12345',
    status: 'active',
    settings: {},
    createdAt: new Date(),
  };

  beforeEach(async () => {
    const mockTransactionManager = {
      create: jest.fn().mockImplementation((_entity, data) => data),
      save: jest.fn().mockImplementation((_entity, data) => {
        if (_entity === Tenant) return { ...mockTenant, ...data };
        if (_entity === User) return { ...mockUser, ...data };
        return data;
      }),
      update: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: jest.fn(),
            update: jest.fn().mockResolvedValue(undefined),
            save: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Tenant),
          useValue: {
            findOne: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(RefreshToken),
          useValue: {
            findOne: jest.fn(),
            save: jest.fn().mockResolvedValue({}),
            update: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: getRepositoryToken(EmailVerificationToken),
          useValue: {
            findOne: jest.fn(),
            save: jest.fn().mockResolvedValue({}),
          },
        },
        {
          provide: getRepositoryToken(PasswordResetToken),
          useValue: {
            findOne: jest.fn(),
            save: jest.fn().mockResolvedValue({}),
          },
        },
        {
          provide: JwtService,
          useValue: {
            sign: jest.fn().mockReturnValue('mock-access-token'),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string, defaultValue?: any) => {
              const config: Record<string, any> = {
                JWT_SECRET: 'test-secret',
                JWT_ACCESS_TTL_SECONDS: 900,
                JWT_REFRESH_TTL_DAYS: 7,
                EMAIL_VERIFICATION_TTL_HOURS: 24,
                PASSWORD_RESET_TTL_HOURS: 1,
                MAX_FAILED_LOGIN_ATTEMPTS: 5,
                LOCKOUT_DURATION_MINUTES: 15,
              };
              return config[key] ?? defaultValue;
            }),
          },
        },
        {
          provide: DataSource,
          useValue: {
            transaction: jest.fn().mockImplementation(async (cb) => cb(mockTransactionManager)),
            query: jest.fn(),
          },
        },
        {
          provide: EMAIL_SERVICE,
          useValue: {
            sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
            sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
            sendAccountLockedEmail: jest.fn().mockResolvedValue(undefined),
            sendAccountLockedAdminNotification: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: EventEmitter2,
          useValue: {
            emit: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    userRepository = module.get(getRepositoryToken(User));
    tenantRepository = module.get(getRepositoryToken(Tenant));
    refreshTokenRepository = module.get(getRepositoryToken(RefreshToken));
    emailVerificationTokenRepository = module.get(getRepositoryToken(EmailVerificationToken));
    passwordResetTokenRepository = module.get(getRepositoryToken(PasswordResetToken));
    jwtService = module.get(JwtService) as jest.Mocked<JwtService>;
    dataSource = module.get(DataSource) as jest.Mocked<DataSource>;
    emailService = module.get(EMAIL_SERVICE);
  });

  describe('register', () => {
    const registerDto = {
      email: 'new@example.com',
      password: 'StrongPass1!',
      clinicName: 'My Clinic',
    };

    it('should register a new user and tenant successfully', async () => {
      userRepository.findOne.mockResolvedValue(null);

      const result = await service.register(registerDto);

      expect(result).toBeDefined();
      expect(result.user.email).toBe('new@example.com');
      expect(result.user.role).toBe('admin');
      expect(result.tokens.accessToken).toBe('mock-access-token');
      expect(result.tokens.refreshToken).toBeDefined();
      expect(result.tokens.refreshToken.length).toBeGreaterThan(0);
    });

    it('should throw ConflictException if email already exists', async () => {
      userRepository.findOne.mockResolvedValue(mockUser as User);

      await expect(service.register(registerDto)).rejects.toThrow(ConflictException);
    });

    it('should send verification email after registration', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await service.register(registerDto);

      // Give async email sending time to fire
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(emailService.sendVerificationEmail).toHaveBeenCalled();
    });

    it('should normalize email to lowercase', async () => {
      userRepository.findOne.mockResolvedValue(null);

      const dto = { ...registerDto, email: 'NEW@EXAMPLE.COM' };
      await service.register(dto);

      expect(userRepository.findOne).toHaveBeenCalledWith({
        where: { email: 'new@example.com' },
      });
    });
  });

  describe('login', () => {
    const loginDto = { email: 'test@example.com', password: 'StrongPass1!' };

    it('should return token pair on successful login', async () => {
      userRepository.findOne.mockResolvedValue(mockUser as User);
      const bcrypt = require('bcrypt');
      bcrypt.compare.mockResolvedValue(true);

      const result = await service.login(loginDto);

      expect(result.accessToken).toBe('mock-access-token');
      expect(result.refreshToken).toBeDefined();
    });

    it('should throw UnauthorizedException if user not found', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(service.login(loginDto)).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException on wrong password', async () => {
      userRepository.findOne.mockResolvedValue(mockUser as User);
      const bcrypt = require('bcrypt');
      bcrypt.compare.mockResolvedValue(false);

      await expect(service.login(loginDto)).rejects.toThrow(UnauthorizedException);
    });

    it('should throw ForbiddenException if account is locked', async () => {
      const lockedUser = {
        ...mockUser,
        lockedUntil: new Date(Date.now() + 15 * 60 * 1000), // 15 min from now
      };
      userRepository.findOne.mockResolvedValue(lockedUser as User);

      await expect(service.login(loginDto)).rejects.toThrow(ForbiddenException);
    });

    it('should increment failed login attempts on wrong password', async () => {
      userRepository.findOne.mockResolvedValue(mockUser as User);
      const bcrypt = require('bcrypt');
      bcrypt.compare.mockResolvedValue(false);

      await expect(service.login(loginDto)).rejects.toThrow(UnauthorizedException);

      expect(userRepository.update).toHaveBeenCalledWith(mockUser.id, {
        failedLoginAttempts: 1,
      });
    });

    it('should lock account after 5 failed attempts', async () => {
      const userWith4Failures = {
        ...mockUser,
        failedLoginAttempts: 4,
      };
      userRepository.findOne.mockResolvedValue(userWith4Failures as User);
      const bcrypt = require('bcrypt');
      bcrypt.compare.mockResolvedValue(false);

      await expect(service.login(loginDto)).rejects.toThrow(UnauthorizedException);

      expect(userRepository.update).toHaveBeenCalledWith(
        mockUser.id,
        expect.objectContaining({
          failedLoginAttempts: 5,
          lockedUntil: expect.any(Date),
        }),
      );
    });

    it('should send lockout email notification when account is locked', async () => {
      const userWith4Failures = {
        ...mockUser,
        failedLoginAttempts: 4,
      };
      userRepository.findOne.mockResolvedValue(userWith4Failures as User);
      const bcrypt = require('bcrypt');
      bcrypt.compare.mockResolvedValue(false);

      await expect(service.login(loginDto)).rejects.toThrow(UnauthorizedException);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(emailService.sendAccountLockedEmail).toHaveBeenCalledWith(mockUser.email);
    });

    it('should reset failed attempts on successful login', async () => {
      const userWithFailures = {
        ...mockUser,
        failedLoginAttempts: 3,
      };
      userRepository.findOne.mockResolvedValue(userWithFailures as User);
      const bcrypt = require('bcrypt');
      bcrypt.compare.mockResolvedValue(true);

      await service.login(loginDto);

      expect(userRepository.update).toHaveBeenCalledWith(mockUser.id, {
        failedLoginAttempts: 0,
        lockedUntil: null,
      });
    });
  });

  describe('verifyEmail', () => {
    it('should verify email with valid token', async () => {
      const token = 'valid-token-hex';
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const mockVerification = {
        id: 'verification-uuid',
        userId: 'user-uuid-1',
        tokenHash,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        used: false,
      };

      emailVerificationTokenRepository.findOne.mockResolvedValue(
        mockVerification as EmailVerificationToken,
      );

      await expect(service.verifyEmail(token)).resolves.toBeUndefined();
    });

    it('should throw BadRequestException for invalid token', async () => {
      emailVerificationTokenRepository.findOne.mockResolvedValue(null);

      await expect(service.verifyEmail('invalid-token')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for expired token', async () => {
      const token = 'expired-token-hex';
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const mockVerification = {
        id: 'verification-uuid',
        userId: 'user-uuid-1',
        tokenHash,
        expiresAt: new Date(Date.now() - 1000), // expired
        used: false,
      };

      emailVerificationTokenRepository.findOne.mockResolvedValue(
        mockVerification as EmailVerificationToken,
      );

      await expect(service.verifyEmail(token)).rejects.toThrow(BadRequestException);
    });
  });

  describe('refreshToken', () => {
    it('should return new token pair with valid refresh token', async () => {
      const refreshTokenValue = 'valid-refresh-token';
      const tokenHash = crypto.createHash('sha256').update(refreshTokenValue).digest('hex');
      const mockStoredToken = {
        id: 'refresh-uuid',
        userId: 'user-uuid-1',
        tokenHash,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        revoked: false,
      };

      refreshTokenRepository.findOne.mockResolvedValue(mockStoredToken as RefreshToken);
      userRepository.findOne.mockResolvedValue(mockUser as User);

      const result = await service.refreshToken(refreshTokenValue);

      expect(result.accessToken).toBe('mock-access-token');
      expect(result.refreshToken).toBeDefined();
      expect(refreshTokenRepository.update).toHaveBeenCalledWith(
        mockStoredToken.id,
        { revoked: true },
      );
    });

    it('should throw UnauthorizedException for invalid refresh token', async () => {
      refreshTokenRepository.findOne.mockResolvedValue(null);

      await expect(service.refreshToken('invalid-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('should throw UnauthorizedException for expired refresh token', async () => {
      const refreshTokenValue = 'expired-refresh-token';
      const tokenHash = crypto.createHash('sha256').update(refreshTokenValue).digest('hex');
      const mockStoredToken = {
        id: 'refresh-uuid',
        userId: 'user-uuid-1',
        tokenHash,
        expiresAt: new Date(Date.now() - 1000), // expired
        revoked: false,
      };

      refreshTokenRepository.findOne.mockResolvedValue(mockStoredToken as RefreshToken);

      await expect(service.refreshToken(refreshTokenValue)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('requestPasswordReset', () => {
    it('should send reset email for existing user', async () => {
      userRepository.findOne.mockResolvedValue(mockUser as User);

      await service.requestPasswordReset('test@example.com');

      expect(emailService.sendPasswordResetEmail).toHaveBeenCalledWith(
        mockUser.email,
        expect.any(String),
      );
    });

    it('should not throw for non-existing user (prevents email enumeration)', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(
        service.requestPasswordReset('unknown@example.com'),
      ).resolves.toBeUndefined();
    });
  });

  describe('resetPassword', () => {
    it('should reset password with valid token', async () => {
      const token = 'valid-reset-token';
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const mockResetToken = {
        id: 'reset-uuid',
        userId: 'user-uuid-1',
        tokenHash,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1h from now
        used: false,
      };

      passwordResetTokenRepository.findOne.mockResolvedValue(
        mockResetToken as PasswordResetToken,
      );

      await expect(
        service.resetPassword({ token, newPassword: 'NewPass1!' }),
      ).resolves.toBeUndefined();
    });

    it('should throw BadRequestException for invalid reset token', async () => {
      passwordResetTokenRepository.findOne.mockResolvedValue(null);

      await expect(
        service.resetPassword({ token: 'bad-token', newPassword: 'NewPass1!' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for expired reset token', async () => {
      const token = 'expired-reset-token';
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const mockResetToken = {
        id: 'reset-uuid',
        userId: 'user-uuid-1',
        tokenHash,
        expiresAt: new Date(Date.now() - 1000), // expired
        used: false,
      };

      passwordResetTokenRepository.findOne.mockResolvedValue(
        mockResetToken as PasswordResetToken,
      );

      await expect(
        service.resetPassword({ token, newPassword: 'NewPass1!' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should revoke all refresh tokens after password reset', async () => {
      const token = 'valid-reset-token';
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const mockResetToken = {
        id: 'reset-uuid',
        userId: 'user-uuid-1',
        tokenHash,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        used: false,
      };

      passwordResetTokenRepository.findOne.mockResolvedValue(
        mockResetToken as PasswordResetToken,
      );

      await service.resetPassword({ token, newPassword: 'NewPass1!' });

      expect(refreshTokenRepository.update).toHaveBeenCalledWith(
        { userId: 'user-uuid-1', revoked: false },
        { revoked: true },
      );
    });
  });

  describe('lockAccount', () => {
    it('should lock user account with future lockedUntil date', async () => {
      await service.lockAccount('user-uuid-1', 'Too many failed attempts');

      expect(userRepository.update).toHaveBeenCalledWith(
        'user-uuid-1',
        expect.objectContaining({
          lockedUntil: expect.any(Date),
        }),
      );

      const updateCall = userRepository.update.mock.calls[0];
      const lockedUntil = (updateCall[1] as any).lockedUntil as Date;
      expect(lockedUntil.getTime()).toBeGreaterThan(Date.now());
    });
  });
});
