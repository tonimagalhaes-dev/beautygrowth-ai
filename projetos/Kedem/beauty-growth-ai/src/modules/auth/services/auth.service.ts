import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, Repository } from 'typeorm';
import * as crypto from 'crypto';

import { User } from '../entities/user.entity';
import { Tenant } from '../entities/tenant.entity';
import { RefreshToken } from '../entities/refresh-token.entity';
import { EmailVerificationToken } from '../entities/email-verification-token.entity';
import { PasswordResetToken } from '../entities/password-reset-token.entity';
import { RegisterDto } from '../dto/register.dto';
import { LoginDto } from '../dto/login.dto';
import { ResetPasswordDto } from '../dto/reset-password.dto';
import { AuthResponse, TokenPair, TokenPayload } from '../interfaces/auth.interface';
import { EMAIL_SERVICE, IEmailService } from '../interfaces/email-service.interface';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  private readonly ACCESS_TOKEN_TTL_SECONDS: number;
  private readonly REFRESH_TOKEN_TTL_DAYS: number;
  private readonly EMAIL_VERIFICATION_TTL_HOURS: number;
  private readonly PASSWORD_RESET_TTL_HOURS: number;
  private readonly MAX_FAILED_ATTEMPTS: number;
  private readonly LOCKOUT_DURATION_MINUTES: number;

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,
    @InjectRepository(EmailVerificationToken)
    private readonly emailVerificationTokenRepository: Repository<EmailVerificationToken>,
    @InjectRepository(PasswordResetToken)
    private readonly passwordResetTokenRepository: Repository<PasswordResetToken>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
    @Inject(EMAIL_SERVICE)
    private readonly emailService: IEmailService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.ACCESS_TOKEN_TTL_SECONDS = this.configService.get<number>('JWT_ACCESS_TTL_SECONDS', 900); // 15 min
    this.REFRESH_TOKEN_TTL_DAYS = this.configService.get<number>('JWT_REFRESH_TTL_DAYS', 7);
    this.EMAIL_VERIFICATION_TTL_HOURS = this.configService.get<number>('EMAIL_VERIFICATION_TTL_HOURS', 24);
    this.PASSWORD_RESET_TTL_HOURS = this.configService.get<number>('PASSWORD_RESET_TTL_HOURS', 1);
    this.MAX_FAILED_ATTEMPTS = this.configService.get<number>('MAX_FAILED_LOGIN_ATTEMPTS', 5);
    this.LOCKOUT_DURATION_MINUTES = this.configService.get<number>('LOCKOUT_DURATION_MINUTES', 15);
  }

  /**
   * Register a new user + tenant in a single transaction.
   */
  async register(dto: RegisterDto): Promise<AuthResponse> {
    // Check if email already exists
    const existingUser = await this.userRepository.findOne({
      where: { email: dto.email.toLowerCase() },
    });
    if (existingUser) {
      throw new ConflictException('Email already registered');
    }

    // Create tenant + user in transaction
    const result = await this.dataSource.transaction(async (manager) => {
      // Create tenant
      const slug = this.generateSlug(dto.clinicName);
      const tenant = manager.create(Tenant, {
        slug,
        status: 'active',
        settings: {},
      });
      const savedTenant = await manager.save(Tenant, tenant);

      // Hash password
      const passwordHash = await this.hashPassword(dto.password);

      // Create user as admin of the tenant
      const user = manager.create(User, {
        tenantId: savedTenant.id,
        email: dto.email.toLowerCase(),
        passwordHash,
        role: 'admin',
        emailVerified: false,
        failedLoginAttempts: 0,
      });
      const savedUser = await manager.save(User, user);

      return { tenant: savedTenant, user: savedUser };
    });

    // Send verification email (non-blocking)
    const verificationToken = await this.createEmailVerificationToken(result.user.id);
    this.emailService
      .sendVerificationEmail(result.user.email, verificationToken)
      .catch((err) => this.logger.error('Failed to send verification email', err));

    // Emit tenant.created event for downstream provisioning
    this.eventEmitter.emit('tenant.created', { tenantId: result.tenant.id });
    this.logger.log(`Emitted tenant.created event for tenant ${result.tenant.id}`);

    // Generate tokens
    const tokens = await this.generateTokenPair(result.user);

    return {
      user: {
        id: result.user.id,
        email: result.user.email,
        role: result.user.role,
        tenantId: result.user.tenantId,
      },
      tokens,
    };
  }

  /**
   * Login with email + password. Returns JWT token pair.
   */
  async login(dto: LoginDto): Promise<TokenPair> {
    const user = await this.userRepository.findOne({
      where: { email: dto.email.toLowerCase() },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Check account lockout
    if (this.isAccountLocked(user)) {
      throw new ForbiddenException(
        'Account is locked due to too many failed login attempts. Please try again later.',
      );
    }

    // Verify password
    const isPasswordValid = await this.verifyPassword(dto.password, user.passwordHash);
    if (!isPasswordValid) {
      await this.handleFailedLogin(user);
      throw new UnauthorizedException('Invalid credentials');
    }

    // Reset failed attempts on successful login
    if (user.failedLoginAttempts > 0) {
      await this.userRepository.update(user.id, {
        failedLoginAttempts: 0,
        lockedUntil: null,
      });
    }

    return this.generateTokenPair(user);
  }

  /**
   * Verify user's email with the verification token.
   */
  async verifyEmail(token: string): Promise<void> {
    const tokenHash = this.hashToken(token);
    const verificationToken = await this.emailVerificationTokenRepository.findOne({
      where: { tokenHash, used: false },
    });

    if (!verificationToken) {
      throw new BadRequestException('Invalid or expired verification token');
    }

    if (new Date() > verificationToken.expiresAt) {
      throw new BadRequestException('Verification token has expired');
    }

    // Mark token as used and verify user's email
    await this.dataSource.transaction(async (manager) => {
      await manager.update(EmailVerificationToken, verificationToken.id, { used: true });
      await manager.update(User, verificationToken.userId, { emailVerified: true });
    });
  }

  /**
   * Refresh the access token using a valid refresh token.
   */
  async refreshToken(refreshTokenValue: string): Promise<TokenPair> {
    const tokenHash = this.hashToken(refreshTokenValue);
    const storedToken = await this.refreshTokenRepository.findOne({
      where: { tokenHash, revoked: false },
    });

    if (!storedToken) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (new Date() > storedToken.expiresAt) {
      // Revoke expired token
      await this.refreshTokenRepository.update(storedToken.id, { revoked: true });
      throw new UnauthorizedException('Refresh token has expired');
    }

    // Revoke old token
    await this.refreshTokenRepository.update(storedToken.id, { revoked: true });

    // Get user and generate new pair
    const user = await this.userRepository.findOne({
      where: { id: storedToken.userId },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return this.generateTokenPair(user);
  }

  /**
   * Request a password reset. Sends token via email.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.userRepository.findOne({
      where: { email: email.toLowerCase() },
    });

    // Don't reveal whether user exists
    if (!user) {
      return;
    }

    const token = this.generateSecureToken();
    const tokenHash = this.hashToken(token);
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + this.PASSWORD_RESET_TTL_HOURS);

    await this.passwordResetTokenRepository.save({
      userId: user.id,
      tokenHash,
      expiresAt,
      used: false,
    });

    await this.emailService.sendPasswordResetEmail(user.email, token);
  }

  /**
   * Reset password using the reset token.
   */
  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    const tokenHash = this.hashToken(dto.token);
    const resetToken = await this.passwordResetTokenRepository.findOne({
      where: { tokenHash, used: false },
    });

    if (!resetToken) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    if (new Date() > resetToken.expiresAt) {
      throw new BadRequestException('Reset token has expired');
    }

    const passwordHash = await this.hashPassword(dto.newPassword);

    await this.dataSource.transaction(async (manager) => {
      await manager.update(PasswordResetToken, resetToken.id, { used: true });
      await manager.update(User, resetToken.userId, {
        passwordHash,
        failedLoginAttempts: 0,
        lockedUntil: null,
      });
    });

    // Revoke all refresh tokens for this user (force re-login)
    await this.refreshTokenRepository.update(
      { userId: resetToken.userId, revoked: false },
      { revoked: true },
    );
  }

  /**
   * Lock a user account.
   */
  async lockAccount(userId: string, reason: string): Promise<void> {
    const lockedUntil = new Date();
    lockedUntil.setMinutes(lockedUntil.getMinutes() + this.LOCKOUT_DURATION_MINUTES);

    await this.userRepository.update(userId, { lockedUntil });
    this.logger.warn(`Account locked: userId=${userId}, reason=${reason}`);
  }

  // =========================================================================
  // PRIVATE HELPERS
  // =========================================================================

  private isAccountLocked(user: User): boolean {
    if (!user.lockedUntil) return false;
    return new Date() < user.lockedUntil;
  }

  private async handleFailedLogin(user: User): Promise<void> {
    const attempts = user.failedLoginAttempts + 1;

    if (attempts >= this.MAX_FAILED_ATTEMPTS) {
      const lockedUntil = new Date();
      lockedUntil.setMinutes(lockedUntil.getMinutes() + this.LOCKOUT_DURATION_MINUTES);

      await this.userRepository.update(user.id, {
        failedLoginAttempts: attempts,
        lockedUntil,
      });

      // Send lockout notifications
      this.emailService
        .sendAccountLockedEmail(user.email)
        .catch((err) => this.logger.error('Failed to send lock email to user', err));

      this.logger.warn(`Account locked after ${attempts} failed attempts: ${user.email}`);
    } else {
      await this.userRepository.update(user.id, {
        failedLoginAttempts: attempts,
      });
    }
  }

  private async generateTokenPair(user: User): Promise<TokenPair> {
    const payload: Omit<TokenPayload, 'iat' | 'exp'> = {
      userId: user.id,
      tenantId: user.tenantId,
      role: user.role,
    };

    const accessToken = this.jwtService.sign(payload, {
      expiresIn: this.ACCESS_TOKEN_TTL_SECONDS,
    });

    const refreshTokenValue = this.generateSecureToken();
    const tokenHash = this.hashToken(refreshTokenValue);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + this.REFRESH_TOKEN_TTL_DAYS);

    await this.refreshTokenRepository.save({
      userId: user.id,
      tokenHash,
      expiresAt,
      revoked: false,
    });

    return {
      accessToken,
      refreshToken: refreshTokenValue,
    };
  }

  private async createEmailVerificationToken(userId: string): Promise<string> {
    const token = this.generateSecureToken();
    const tokenHash = this.hashToken(token);
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + this.EMAIL_VERIFICATION_TTL_HOURS);

    await this.emailVerificationTokenRepository.save({
      userId,
      tokenHash,
      expiresAt,
      used: false,
    });

    return token;
  }

  private generateSecureToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private async hashPassword(password: string): Promise<string> {
    const bcrypt = await import('bcrypt');
    const saltRounds = 12;
    return bcrypt.hash(password, saltRounds);
  }

  private async verifyPassword(password: string, hash: string): Promise<boolean> {
    const bcrypt = await import('bcrypt');
    return bcrypt.compare(password, hash);
  }

  private generateSlug(clinicName: string): string {
    const baseSlug = clinicName
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    // Add random suffix to ensure uniqueness
    const suffix = crypto.randomBytes(4).toString('hex');
    return `${baseSlug}-${suffix}`;
  }
}
