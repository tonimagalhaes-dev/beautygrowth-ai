/**
 * Interface for email service. A mock implementation is provided
 * for development; a real implementation (e.g., SES, SendGrid) can be swapped in.
 */
export interface IEmailService {
  sendVerificationEmail(email: string, token: string): Promise<void>;
  sendPasswordResetEmail(email: string, token: string): Promise<void>;
  sendAccountLockedEmail(email: string): Promise<void>;
  sendAccountLockedAdminNotification(adminEmail: string, lockedUserEmail: string): Promise<void>;
  sendInvitationEmail(email: string, token: string, tenantId: string): Promise<void>;
}

export const EMAIL_SERVICE = 'EMAIL_SERVICE';
