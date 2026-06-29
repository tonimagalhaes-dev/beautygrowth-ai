import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as crypto from 'crypto';

import { Invitation } from '../entities/invitation.entity';
import { User } from '../entities/user.entity';
import { InviteMemberDto } from '../dto/invite-member.dto';
import { AcceptInvitationDto } from '../dto/accept-invitation.dto';
import { EMAIL_SERVICE, IEmailService } from '../interfaces/email-service.interface';

@Injectable()
export class InvitationService {
  private readonly logger = new Logger(InvitationService.name);
  private readonly INVITATION_TTL_HOURS = 72;

  constructor(
    @InjectRepository(Invitation)
    private readonly invitationRepository: Repository<Invitation>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly dataSource: DataSource,
    @Inject(EMAIL_SERVICE)
    private readonly emailService: IEmailService,
  ) {}

  /**
   * Admin invites a new member via email.
   * Creates an invitation with a 72h token and sends an email.
   */
  async inviteMember(
    tenantId: string,
    invitedBy: string,
    dto: InviteMemberDto,
  ): Promise<{ invitation: Invitation; token: string }> {
    const email = dto.email.toLowerCase();

    // Check if user already exists in the tenant
    const existingUser = await this.userRepository.findOne({
      where: { email, tenantId },
    });
    if (existingUser) {
      throw new ConflictException('User with this email already exists in the tenant');
    }

    // Check if there's already a pending invitation for this email in this tenant
    const existingInvitation = await this.invitationRepository.findOne({
      where: { email, tenantId, status: 'pending' },
    });
    if (existingInvitation) {
      throw new ConflictException('A pending invitation already exists for this email');
    }

    const token = this.generateSecureToken();
    const tokenHash = this.hashToken(token);
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + this.INVITATION_TTL_HOURS);

    const invitation = this.invitationRepository.create({
      tenantId,
      email,
      role: dto.role,
      tokenHash,
      expiresAt,
      status: 'pending',
      invitedBy,
    });

    const savedInvitation = await this.invitationRepository.save(invitation);

    // Send invitation email (non-blocking)
    this.emailService
      .sendInvitationEmail(email, token, tenantId)
      .catch((err) => this.logger.error('Failed to send invitation email', err));

    return { invitation: savedInvitation, token };
  }

  /**
   * Accept an invitation: validates token, creates user, marks invitation as accepted.
   */
  async acceptInvitation(dto: AcceptInvitationDto): Promise<User> {
    const tokenHash = this.hashToken(dto.token);

    const invitation = await this.invitationRepository.findOne({
      where: { tokenHash, status: 'pending' },
    });

    if (!invitation) {
      throw new BadRequestException('Invalid or expired invitation token');
    }

    if (new Date() > invitation.expiresAt) {
      // Mark as expired
      await this.invitationRepository.update(invitation.id, { status: 'expired' });
      throw new BadRequestException('Invitation has expired');
    }

    // Check if user with this email already exists
    const existingUser = await this.userRepository.findOne({
      where: { email: invitation.email },
    });
    if (existingUser) {
      throw new ConflictException('A user with this email already exists');
    }

    // Create user and update invitation in a transaction
    const user = await this.dataSource.transaction(async (manager) => {
      const passwordHash = await this.hashPassword(dto.password);

      const newUser = manager.create(User, {
        tenantId: invitation.tenantId,
        email: invitation.email,
        passwordHash,
        role: invitation.role,
        emailVerified: true, // Invited users have verified email by accepting
        failedLoginAttempts: 0,
      });

      const savedUser = await manager.save(User, newUser);

      await manager.update(Invitation, invitation.id, { status: 'accepted' });

      return savedUser;
    });

    return user;
  }

  /**
   * Resend invitation: cancels old invitation and creates a new one with fresh 72h token.
   */
  async resendInvitation(
    invitationId: string,
    tenantId: string,
  ): Promise<{ invitation: Invitation; token: string }> {
    const existingInvitation = await this.invitationRepository.findOne({
      where: { id: invitationId, tenantId },
    });

    if (!existingInvitation) {
      throw new NotFoundException('Invitation not found');
    }

    if (existingInvitation.status === 'accepted') {
      throw new BadRequestException('Cannot resend an already accepted invitation');
    }

    // Cancel old invitation and create new one
    const token = this.generateSecureToken();
    const tokenHash = this.hashToken(token);
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + this.INVITATION_TTL_HOURS);

    const newInvitation = await this.dataSource.transaction(async (manager) => {
      // Cancel existing invitation
      await manager.update(Invitation, existingInvitation.id, { status: 'cancelled' });

      // Create new invitation
      const invitation = manager.create(Invitation, {
        tenantId: existingInvitation.tenantId,
        email: existingInvitation.email,
        role: existingInvitation.role,
        tokenHash,
        expiresAt,
        status: 'pending',
        invitedBy: existingInvitation.invitedBy,
      });

      return manager.save(Invitation, invitation);
    });

    // Send invitation email (non-blocking)
    this.emailService
      .sendInvitationEmail(existingInvitation.email, token, tenantId)
      .catch((err) => this.logger.error('Failed to send invitation email', err));

    return { invitation: newInvitation, token };
  }

  /**
   * List all invitations for a tenant.
   */
  async listInvitations(tenantId: string): Promise<Invitation[]> {
    return this.invitationRepository.find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Cancel a pending invitation.
   */
  async cancelInvitation(invitationId: string, tenantId: string): Promise<void> {
    const invitation = await this.invitationRepository.findOne({
      where: { id: invitationId, tenantId },
    });

    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    if (invitation.status !== 'pending') {
      throw new BadRequestException('Only pending invitations can be cancelled');
    }

    await this.invitationRepository.update(invitationId, { status: 'cancelled' });
  }

  // =========================================================================
  // PRIVATE HELPERS
  // =========================================================================

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
}
