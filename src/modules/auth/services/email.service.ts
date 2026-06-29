import { Injectable, Logger } from '@nestjs/common';
import { IEmailService } from '../interfaces/email-service.interface';

/**
 * Mock email service for development.
 * Logs all emails to console instead of sending them.
 * Replace with a real implementation (SES, SendGrid, etc.) in production.
 */
@Injectable()
export class MockEmailService implements IEmailService {
  private readonly logger = new Logger(MockEmailService.name);

  async sendVerificationEmail(email: string, token: string): Promise<void> {
    this.logger.log(`[MOCK] Verification email to ${email} with token: ${token}`);
  }

  async sendPasswordResetEmail(email: string, token: string): Promise<void> {
    this.logger.log(`[MOCK] Password reset email to ${email} with token: ${token}`);
  }

  async sendAccountLockedEmail(email: string): Promise<void> {
    this.logger.log(`[MOCK] Account locked notification to ${email}`);
  }

  async sendAccountLockedAdminNotification(adminEmail: string, lockedUserEmail: string): Promise<void> {
    this.logger.log(`[MOCK] Admin notification to ${adminEmail} about locked account: ${lockedUserEmail}`);
  }

  async sendInvitationEmail(email: string, token: string, tenantId: string): Promise<void> {
    this.logger.log(`[MOCK] Invitation email to ${email} for tenant ${tenantId} with token: ${token}`);
  }
}
