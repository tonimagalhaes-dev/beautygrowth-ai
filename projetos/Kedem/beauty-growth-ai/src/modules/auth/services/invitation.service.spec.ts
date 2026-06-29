import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'crypto';

import { InvitationService } from './invitation.service';
import { Invitation } from '../entities/invitation.entity';
import { User } from '../entities/user.entity';
import { EMAIL_SERVICE } from '../interfaces/email-service.interface';

// Mock bcrypt
jest.mock('bcrypt', () => ({
  hash: jest.fn().mockResolvedValue('$2b$12$hashedpassword'),
}));

describe('InvitationService', () => {
  let service: InvitationService;
  let invitationRepository: jest.Mocked<Repository<Invitation>>;
  let userRepository: jest.Mocked<Repository<User>>;
  let dataSource: jest.Mocked<DataSource>;
  let emailService: any;

  const mockTenantId = 'tenant-uuid-1';
  const mockAdminId = 'admin-uuid-1';

  const mockInvitation: Partial<Invitation> = {
    id: 'invitation-uuid-1',
    tenantId: mockTenantId,
    email: 'newmember@example.com',
    role: 'operator',
    tokenHash: 'hashed-token',
    expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
    status: 'pending',
    invitedBy: mockAdminId,
    createdAt: new Date(),
  };

  beforeEach(async () => {
    const mockTransactionManager = {
      create: jest.fn().mockImplementation((_entity, data) => ({ id: 'new-uuid', ...data })),
      save: jest.fn().mockImplementation((_entity, data) => ({ id: 'new-uuid', ...data })),
      update: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvitationService,
        {
          provide: getRepositoryToken(Invitation),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn(),
            create: jest.fn().mockImplementation((data) => ({ id: 'new-uuid', ...data })),
            save: jest.fn().mockImplementation((data) => ({ id: 'new-uuid', ...data })),
            update: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: DataSource,
          useValue: {
            transaction: jest.fn().mockImplementation(async (cb) => cb(mockTransactionManager)),
          },
        },
        {
          provide: EMAIL_SERVICE,
          useValue: {
            sendInvitationEmail: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<InvitationService>(InvitationService);
    invitationRepository = module.get(getRepositoryToken(Invitation));
    userRepository = module.get(getRepositoryToken(User));
    dataSource = module.get(DataSource) as jest.Mocked<DataSource>;
    emailService = module.get(EMAIL_SERVICE);
  });

  describe('inviteMember', () => {
    const inviteDto = { email: 'newmember@example.com', role: 'operator' as const };

    it('should create an invitation and return it with a token', async () => {
      userRepository.findOne.mockResolvedValue(null);
      invitationRepository.findOne.mockResolvedValue(null);

      const result = await service.inviteMember(mockTenantId, mockAdminId, inviteDto);

      expect(result.invitation).toBeDefined();
      expect(result.invitation.email).toBe('newmember@example.com');
      expect(result.invitation.role).toBe('operator');
      expect(result.invitation.tenantId).toBe(mockTenantId);
      expect(result.invitation.status).toBe('pending');
      expect(result.token).toBeDefined();
      expect(result.token.length).toBeGreaterThan(0);
    });

    it('should normalize email to lowercase', async () => {
      userRepository.findOne.mockResolvedValue(null);
      invitationRepository.findOne.mockResolvedValue(null);

      const dto = { email: 'NewMember@EXAMPLE.COM', role: 'operator' as const };
      const result = await service.inviteMember(mockTenantId, mockAdminId, dto);

      expect(result.invitation.email).toBe('newmember@example.com');
    });

    it('should throw ConflictException if user already exists in tenant', async () => {
      userRepository.findOne.mockResolvedValue({
        id: 'existing-user',
        email: 'newmember@example.com',
        tenantId: mockTenantId,
      } as User);

      await expect(
        service.inviteMember(mockTenantId, mockAdminId, inviteDto),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw ConflictException if pending invitation already exists', async () => {
      userRepository.findOne.mockResolvedValue(null);
      invitationRepository.findOne.mockResolvedValue(mockInvitation as Invitation);

      await expect(
        service.inviteMember(mockTenantId, mockAdminId, inviteDto),
      ).rejects.toThrow(ConflictException);
    });

    it('should send invitation email after creating invitation', async () => {
      userRepository.findOne.mockResolvedValue(null);
      invitationRepository.findOne.mockResolvedValue(null);

      await service.inviteMember(mockTenantId, mockAdminId, inviteDto);

      // Give async email sending time to fire
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(emailService.sendInvitationEmail).toHaveBeenCalledWith(
        'newmember@example.com',
        expect.any(String),
        mockTenantId,
      );
    });

    it('should set expiration to 72 hours from now', async () => {
      userRepository.findOne.mockResolvedValue(null);
      invitationRepository.findOne.mockResolvedValue(null);

      const before = Date.now();
      const result = await service.inviteMember(mockTenantId, mockAdminId, inviteDto);
      const after = Date.now();

      const expiresAt = result.invitation.expiresAt;
      const expectedMin = before + 72 * 60 * 60 * 1000;
      const expectedMax = after + 72 * 60 * 60 * 1000;

      expect(expiresAt.getTime()).toBeGreaterThanOrEqual(expectedMin - 100);
      expect(expiresAt.getTime()).toBeLessThanOrEqual(expectedMax + 100);
    });

    it('should store hashed token, not the raw token', async () => {
      userRepository.findOne.mockResolvedValue(null);
      invitationRepository.findOne.mockResolvedValue(null);

      const result = await service.inviteMember(mockTenantId, mockAdminId, inviteDto);

      // The tokenHash stored should not equal the raw token
      expect(result.invitation.tokenHash).not.toBe(result.token);
      // Verify the hash matches
      const expectedHash = crypto.createHash('sha256').update(result.token).digest('hex');
      expect(result.invitation.tokenHash).toBe(expectedHash);
    });

    it('should set invitedBy to the admin user id', async () => {
      userRepository.findOne.mockResolvedValue(null);
      invitationRepository.findOne.mockResolvedValue(null);

      const result = await service.inviteMember(mockTenantId, mockAdminId, inviteDto);

      expect(result.invitation.invitedBy).toBe(mockAdminId);
    });
  });

  describe('acceptInvitation', () => {
    const token = 'valid-invitation-token';
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const pendingInvitation: Partial<Invitation> = {
      id: 'invitation-uuid-1',
      tenantId: mockTenantId,
      email: 'newmember@example.com',
      role: 'operator',
      tokenHash,
      expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
      status: 'pending',
      invitedBy: mockAdminId,
    };

    it('should create a user and mark invitation as accepted', async () => {
      invitationRepository.findOne.mockResolvedValue(pendingInvitation as Invitation);
      userRepository.findOne.mockResolvedValue(null);

      const result = await service.acceptInvitation({
        token,
        password: 'NewPass1!',
        name: 'New Member',
      });

      expect(result).toBeDefined();
      expect(result.email).toBe('newmember@example.com');
      expect(result.tenantId).toBe(mockTenantId);
      expect(result.role).toBe('operator');
    });

    it('should set emailVerified to true for invited users', async () => {
      invitationRepository.findOne.mockResolvedValue(pendingInvitation as Invitation);
      userRepository.findOne.mockResolvedValue(null);

      const mockTransactionManager = {
        create: jest.fn().mockImplementation((_entity, data) => data),
        save: jest.fn().mockImplementation((_entity, data) => data),
        update: jest.fn().mockResolvedValue(undefined),
      };
      dataSource.transaction.mockImplementation(async (cb: any) => cb(mockTransactionManager));

      const result = await service.acceptInvitation({
        token,
        password: 'NewPass1!',
      });

      expect(result.emailVerified).toBe(true);
    });

    it('should throw BadRequestException for invalid token', async () => {
      invitationRepository.findOne.mockResolvedValue(null);

      await expect(
        service.acceptInvitation({ token: 'invalid-token', password: 'NewPass1!' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for expired invitation', async () => {
      const expiredInvitation = {
        ...pendingInvitation,
        expiresAt: new Date(Date.now() - 1000), // expired
      };
      invitationRepository.findOne.mockResolvedValue(expiredInvitation as Invitation);

      await expect(
        service.acceptInvitation({ token, password: 'NewPass1!' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should mark invitation as expired when token is expired', async () => {
      const expiredInvitation = {
        ...pendingInvitation,
        expiresAt: new Date(Date.now() - 1000),
      };
      invitationRepository.findOne.mockResolvedValue(expiredInvitation as Invitation);

      await expect(
        service.acceptInvitation({ token, password: 'NewPass1!' }),
      ).rejects.toThrow(BadRequestException);

      expect(invitationRepository.update).toHaveBeenCalledWith(
        pendingInvitation.id,
        { status: 'expired' },
      );
    });

    it('should throw ConflictException if user with email already exists', async () => {
      invitationRepository.findOne.mockResolvedValue(pendingInvitation as Invitation);
      userRepository.findOne.mockResolvedValue({
        id: 'existing-user',
        email: 'newmember@example.com',
      } as User);

      await expect(
        service.acceptInvitation({ token, password: 'NewPass1!' }),
      ).rejects.toThrow(ConflictException);
    });

    it('should hash the password before storing', async () => {
      invitationRepository.findOne.mockResolvedValue(pendingInvitation as Invitation);
      userRepository.findOne.mockResolvedValue(null);

      const mockTransactionManager = {
        create: jest.fn().mockImplementation((_entity, data) => data),
        save: jest.fn().mockImplementation((_entity, data) => data),
        update: jest.fn().mockResolvedValue(undefined),
      };
      dataSource.transaction.mockImplementation(async (cb: any) => cb(mockTransactionManager));

      await service.acceptInvitation({ token, password: 'NewPass1!' });

      expect(mockTransactionManager.create).toHaveBeenCalledWith(
        User,
        expect.objectContaining({
          passwordHash: '$2b$12$hashedpassword',
        }),
      );
    });

    it('should use the invitation role for the new user', async () => {
      const adminInvitation = { ...pendingInvitation, role: 'admin' as const };
      invitationRepository.findOne.mockResolvedValue(adminInvitation as Invitation);
      userRepository.findOne.mockResolvedValue(null);

      const mockTransactionManager = {
        create: jest.fn().mockImplementation((_entity, data) => data),
        save: jest.fn().mockImplementation((_entity, data) => data),
        update: jest.fn().mockResolvedValue(undefined),
      };
      dataSource.transaction.mockImplementation(async (cb: any) => cb(mockTransactionManager));

      const result = await service.acceptInvitation({ token, password: 'NewPass1!' });

      expect(result.role).toBe('admin');
    });
  });

  describe('resendInvitation', () => {
    it('should cancel old invitation and create a new one', async () => {
      invitationRepository.findOne.mockResolvedValue(mockInvitation as Invitation);

      const mockTransactionManager = {
        create: jest.fn().mockImplementation((_entity, data) => data),
        save: jest.fn().mockImplementation((_entity, data) => ({ id: 'new-invitation-uuid', ...data })),
        update: jest.fn().mockResolvedValue(undefined),
      };
      dataSource.transaction.mockImplementation(async (cb: any) => cb(mockTransactionManager));

      const result = await service.resendInvitation('invitation-uuid-1', mockTenantId);

      expect(result.invitation).toBeDefined();
      expect(result.token).toBeDefined();
      expect(result.token.length).toBeGreaterThan(0);

      // Old invitation should be cancelled
      expect(mockTransactionManager.update).toHaveBeenCalledWith(
        Invitation,
        'invitation-uuid-1',
        { status: 'cancelled' },
      );
    });

    it('should create new invitation with same email and role', async () => {
      invitationRepository.findOne.mockResolvedValue(mockInvitation as Invitation);

      const mockTransactionManager = {
        create: jest.fn().mockImplementation((_entity, data) => data),
        save: jest.fn().mockImplementation((_entity, data) => ({ id: 'new-invitation-uuid', ...data })),
        update: jest.fn().mockResolvedValue(undefined),
      };
      dataSource.transaction.mockImplementation(async (cb: any) => cb(mockTransactionManager));

      const result = await service.resendInvitation('invitation-uuid-1', mockTenantId);

      expect(result.invitation.email).toBe(mockInvitation.email);
      expect(result.invitation.role).toBe(mockInvitation.role);
      expect(result.invitation.tenantId).toBe(mockTenantId);
      expect(result.invitation.status).toBe('pending');
    });

    it('should throw NotFoundException if invitation does not exist', async () => {
      invitationRepository.findOne.mockResolvedValue(null);

      await expect(
        service.resendInvitation('non-existent-id', mockTenantId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException for already accepted invitation', async () => {
      const acceptedInvitation = { ...mockInvitation, status: 'accepted' as const };
      invitationRepository.findOne.mockResolvedValue(acceptedInvitation as Invitation);

      await expect(
        service.resendInvitation('invitation-uuid-1', mockTenantId),
      ).rejects.toThrow(BadRequestException);
    });

    it('should send invitation email after resending', async () => {
      invitationRepository.findOne.mockResolvedValue(mockInvitation as Invitation);

      const mockTransactionManager = {
        create: jest.fn().mockImplementation((_entity, data) => data),
        save: jest.fn().mockImplementation((_entity, data) => ({ id: 'new-uuid', ...data })),
        update: jest.fn().mockResolvedValue(undefined),
      };
      dataSource.transaction.mockImplementation(async (cb: any) => cb(mockTransactionManager));

      await service.resendInvitation('invitation-uuid-1', mockTenantId);

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(emailService.sendInvitationEmail).toHaveBeenCalledWith(
        mockInvitation.email,
        expect.any(String),
        mockTenantId,
      );
    });

    it('should generate a fresh token with new 72h expiry', async () => {
      invitationRepository.findOne.mockResolvedValue(mockInvitation as Invitation);

      const mockTransactionManager = {
        create: jest.fn().mockImplementation((_entity, data) => data),
        save: jest.fn().mockImplementation((_entity, data) => ({ id: 'new-uuid', ...data })),
        update: jest.fn().mockResolvedValue(undefined),
      };
      dataSource.transaction.mockImplementation(async (cb: any) => cb(mockTransactionManager));

      const before = Date.now();
      const result = await service.resendInvitation('invitation-uuid-1', mockTenantId);
      const after = Date.now();

      const expiresAt = result.invitation.expiresAt;
      const expectedMin = before + 72 * 60 * 60 * 1000;
      const expectedMax = after + 72 * 60 * 60 * 1000;

      expect(expiresAt.getTime()).toBeGreaterThanOrEqual(expectedMin - 100);
      expect(expiresAt.getTime()).toBeLessThanOrEqual(expectedMax + 100);
    });

    it('should allow resend for expired invitations', async () => {
      const expiredInvitation = { ...mockInvitation, status: 'expired' as const };
      invitationRepository.findOne.mockResolvedValue(expiredInvitation as Invitation);

      const mockTransactionManager = {
        create: jest.fn().mockImplementation((_entity, data) => data),
        save: jest.fn().mockImplementation((_entity, data) => ({ id: 'new-uuid', ...data })),
        update: jest.fn().mockResolvedValue(undefined),
      };
      dataSource.transaction.mockImplementation(async (cb: any) => cb(mockTransactionManager));

      const result = await service.resendInvitation('invitation-uuid-1', mockTenantId);

      expect(result.invitation).toBeDefined();
      expect(result.invitation.status).toBe('pending');
    });
  });

  describe('listInvitations', () => {
    it('should return all invitations for a tenant ordered by createdAt DESC', async () => {
      const invitations = [
        { ...mockInvitation, id: 'inv-1', createdAt: new Date('2024-01-02') },
        { ...mockInvitation, id: 'inv-2', createdAt: new Date('2024-01-01') },
      ];
      invitationRepository.find.mockResolvedValue(invitations as Invitation[]);

      const result = await service.listInvitations(mockTenantId);

      expect(result).toHaveLength(2);
      expect(invitationRepository.find).toHaveBeenCalledWith({
        where: { tenantId: mockTenantId },
        order: { createdAt: 'DESC' },
      });
    });

    it('should return empty array when no invitations exist', async () => {
      invitationRepository.find.mockResolvedValue([]);

      const result = await service.listInvitations(mockTenantId);

      expect(result).toHaveLength(0);
    });
  });

  describe('cancelInvitation', () => {
    it('should cancel a pending invitation', async () => {
      invitationRepository.findOne.mockResolvedValue(mockInvitation as Invitation);

      await service.cancelInvitation('invitation-uuid-1', mockTenantId);

      expect(invitationRepository.update).toHaveBeenCalledWith('invitation-uuid-1', {
        status: 'cancelled',
      });
    });

    it('should throw NotFoundException if invitation does not exist', async () => {
      invitationRepository.findOne.mockResolvedValue(null);

      await expect(
        service.cancelInvitation('non-existent-id', mockTenantId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if invitation is not pending', async () => {
      const acceptedInvitation = { ...mockInvitation, status: 'accepted' as const };
      invitationRepository.findOne.mockResolvedValue(acceptedInvitation as Invitation);

      await expect(
        service.cancelInvitation('invitation-uuid-1', mockTenantId),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for expired invitations', async () => {
      const expiredInvitation = { ...mockInvitation, status: 'expired' as const };
      invitationRepository.findOne.mockResolvedValue(expiredInvitation as Invitation);

      await expect(
        service.cancelInvitation('invitation-uuid-1', mockTenantId),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for cancelled invitations', async () => {
      const cancelledInvitation = { ...mockInvitation, status: 'cancelled' as const };
      invitationRepository.findOne.mockResolvedValue(cancelledInvitation as Invitation);

      await expect(
        service.cancelInvitation('invitation-uuid-1', mockTenantId),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
