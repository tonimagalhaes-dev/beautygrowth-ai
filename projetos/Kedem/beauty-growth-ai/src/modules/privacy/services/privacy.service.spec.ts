import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { PrivacyService } from './privacy.service';
import { Consent } from '../entities/consent.entity';
import { RetentionPolicyEntity } from '../entities/retention-policy.entity';
import { DeletionRequest } from '../entities/deletion-request.entity';
import { ROPARecordEntity } from '../entities/ropa-record.entity';
import { DPOContactEntity } from '../entities/dpo-contact.entity';

describe('PrivacyService', () => {
  let service: PrivacyService;
  let consentRepository: any;
  let retentionRepository: any;
  let deletionRepository: any;
  let ropaRepository: any;
  let dpoRepository: any;
  let eventEmitter: any;

  const tenantId = '11111111-1111-1111-1111-111111111111';
  const subjectId = 'subject-001';

  const mockConsentRepository = {
    create: jest.fn((dto) => ({ ...dto, id: 'consent-id-1', grantedAt: new Date() })),
    save: jest.fn((entity) => Promise.resolve({ ...entity, id: entity.id || 'consent-id-1' })),
    findOne: jest.fn(),
    find: jest.fn(),
    delete: jest.fn(),
  };

  const mockRetentionRepository = {
    create: jest.fn((dto) => ({ ...dto, id: 'retention-id-1', updatedAt: new Date() })),
    save: jest.fn((entity) => Promise.resolve({ ...entity, id: entity.id || 'retention-id-1', updatedAt: new Date() })),
    findOne: jest.fn(),
  };

  const mockDeletionRepository = {
    create: jest.fn((dto) => ({ ...dto, id: 'deletion-id-1', requestedAt: new Date() })),
    save: jest.fn((entity) => Promise.resolve({ ...entity, id: entity.id || 'deletion-id-1' })),
    find: jest.fn(),
  };

  const mockRopaRepository = {
    create: jest.fn((dto) => ({ ...dto, id: 'ropa-id-1', createdAt: new Date(), updatedAt: new Date() })),
    save: jest.fn((entity) => Promise.resolve({ ...entity, id: entity.id || 'ropa-id-1' })),
    find: jest.fn(),
  };

  const mockDpoRepository = {
    create: jest.fn((dto) => ({ ...dto, id: 'dpo-id-1', updatedAt: new Date() })),
    save: jest.fn((entity) => Promise.resolve({ ...entity, id: entity.id || 'dpo-id-1', updatedAt: new Date() })),
    findOne: jest.fn(),
  };

  const mockEventEmitter = {
    emit: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PrivacyService,
        { provide: getRepositoryToken(Consent), useValue: mockConsentRepository },
        { provide: getRepositoryToken(RetentionPolicyEntity), useValue: mockRetentionRepository },
        { provide: getRepositoryToken(DeletionRequest), useValue: mockDeletionRepository },
        { provide: getRepositoryToken(ROPARecordEntity), useValue: mockRopaRepository },
        { provide: getRepositoryToken(DPOContactEntity), useValue: mockDpoRepository },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get<PrivacyService>(PrivacyService);
    consentRepository = module.get(getRepositoryToken(Consent));
    retentionRepository = module.get(getRepositoryToken(RetentionPolicyEntity));
    deletionRepository = module.get(getRepositoryToken(DeletionRequest));
    ropaRepository = module.get(getRepositoryToken(ROPARecordEntity));
    dpoRepository = module.get(getRepositoryToken(DPOContactEntity));
    eventEmitter = module.get(EventEmitter2);

    jest.clearAllMocks();
  });

  // ===========================================================================
  // CONSENT MANAGEMENT
  // ===========================================================================

  describe('recordConsent', () => {
    it('should record consent with all required fields', async () => {
      const result = await service.recordConsent({
        tenantId,
        subjectId,
        purpose: 'marketing',
        collectionMethod: 'web_form',
      });

      expect(result).toBeDefined();
      expect(result.id).toBe('consent-id-1');
      expect(result.tenantId).toBe(tenantId);
      expect(result.subjectId).toBe(subjectId);
      expect(result.purpose).toBe('marketing');
      expect(result.collectionMethod).toBe('web_form');
      expect(result.status).toBe('active');
      expect(consentRepository.save).toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'privacy.consent.recorded',
        expect.objectContaining({ tenantId, subjectId }),
      );
    });

    it('should record consent with expiration date', async () => {
      const expiresAt = new Date('2025-12-31');

      const result = await service.recordConsent({
        tenantId,
        subjectId,
        purpose: 'data_analysis',
        collectionMethod: 'in_person',
        expiresAt,
      });

      expect(result).toBeDefined();
      expect(consentRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          expiresAt: expect.any(Date),
        }),
      );
    });
  });

  describe('revokeConsent', () => {
    it('should revoke an active consent', async () => {
      consentRepository.findOne.mockResolvedValue({
        id: 'consent-id-1',
        tenantId,
        subjectId,
        purpose: 'marketing',
        status: 'active',
      });

      await service.revokeConsent('consent-id-1');

      expect(consentRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'revoked',
          revokedAt: expect.any(Date),
        }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'privacy.consent.revoked',
        expect.objectContaining({ consentId: 'consent-id-1' }),
      );
    });

    it('should be idempotent for already revoked consent', async () => {
      consentRepository.findOne.mockResolvedValue({
        id: 'consent-id-1',
        status: 'revoked',
        revokedAt: new Date(),
      });

      await service.revokeConsent('consent-id-1');

      expect(consentRepository.save).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException for non-existent consent', async () => {
      consentRepository.findOne.mockResolvedValue(null);

      await expect(service.revokeConsent('non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('checkConsent', () => {
    it('should return true for active non-expired consent', async () => {
      consentRepository.findOne.mockResolvedValue({
        id: 'consent-id-1',
        status: 'active',
        expiresAt: null,
      });

      const result = await service.checkConsent(subjectId, 'marketing', tenantId);

      expect(result).toBe(true);
    });

    it('should return false when no consent exists', async () => {
      consentRepository.findOne.mockResolvedValue(null);

      const result = await service.checkConsent(subjectId, 'marketing', tenantId);

      expect(result).toBe(false);
    });

    it('should return false and mark as expired when consent has expired', async () => {
      const pastDate = new Date('2020-01-01');
      consentRepository.findOne.mockResolvedValue({
        id: 'consent-id-1',
        status: 'active',
        expiresAt: pastDate,
      });

      const result = await service.checkConsent(subjectId, 'marketing', tenantId);

      expect(result).toBe(false);
      expect(consentRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'expired' }),
      );
    });

    it('should return true for active consent with future expiration', async () => {
      const futureDate = new Date('2099-12-31');
      consentRepository.findOne.mockResolvedValue({
        id: 'consent-id-1',
        status: 'active',
        expiresAt: futureDate,
      });

      const result = await service.checkConsent(subjectId, 'marketing', tenantId);

      expect(result).toBe(true);
    });
  });

  // ===========================================================================
  // DATA DELETION
  // ===========================================================================

  describe('handleDeletionRequest', () => {
    it('should create a deletion request with 15-day deadline', async () => {
      consentRepository.delete.mockResolvedValue({ affected: 2 });

      const result = await service.handleDeletionRequest(subjectId, tenantId);

      expect(result).toBeDefined();
      expect(result.subjectId).toBe(subjectId);
      expect(result.tenantId).toBe(tenantId);
      expect(result.status).toBe('completed');
      expect(result.deletedFrom).toContain('consents');

      // Check deadline is ~15 days from now
      const now = new Date();
      const expectedDeadline = new Date(now);
      expectedDeadline.setDate(expectedDeadline.getDate() + 15);
      expect(result.deadline.getDate()).toBe(expectedDeadline.getDate());
    });

    it('should emit deletion event for other modules', async () => {
      consentRepository.delete.mockResolvedValue({ affected: 0 });

      await service.handleDeletionRequest(subjectId, tenantId);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'privacy.deletion.requested',
        expect.objectContaining({ tenantId, subjectId }),
      );
    });
  });

  // ===========================================================================
  // DATA EXPORT
  // ===========================================================================

  describe('exportData', () => {
    it('should export all personal data in JSON format', async () => {
      consentRepository.find.mockResolvedValue([
        {
          id: 'c1',
          purpose: 'marketing',
          collectionMethod: 'form',
          grantedAt: new Date(),
          expiresAt: null,
          revokedAt: null,
          status: 'active',
        },
      ]);
      deletionRepository.find.mockResolvedValue([]);

      const result = await service.exportData(subjectId, tenantId, 'json');

      expect(result.subjectId).toBe(subjectId);
      expect(result.tenantId).toBe(tenantId);
      expect(result.format).toBe('json');
      expect(result.data.consents).toHaveLength(1);
      expect(result.generatedAt).toBeDefined();
      expect(result.expiresAt).toBeDefined();
    });

    it('should export data in CSV format', async () => {
      consentRepository.find.mockResolvedValue([]);
      deletionRepository.find.mockResolvedValue([]);

      const result = await service.exportData(subjectId, tenantId, 'csv');

      expect(result.format).toBe('csv');
    });

    it('should include subject data only (no other subjects)', async () => {
      consentRepository.find.mockResolvedValue([]);
      deletionRepository.find.mockResolvedValue([]);

      const result = await service.exportData(subjectId, tenantId, 'json');

      expect(result.data.subjectId).toBe(subjectId);
    });
  });

  // ===========================================================================
  // RETENTION POLICIES
  // ===========================================================================

  describe('getRetentionPolicy', () => {
    it('should return existing retention policy', async () => {
      retentionRepository.findOne.mockResolvedValue({
        id: 'rp-1',
        tenantId,
        leadDataMonths: 12,
        financialDataYears: 5,
        auditLogMonths: 12,
        customRules: [],
        updatedAt: new Date(),
      });

      const result = await service.getRetentionPolicy(tenantId);

      expect(result.leadDataMonths).toBe(12);
      expect(result.financialDataYears).toBe(5);
      expect(result.auditLogMonths).toBe(12);
    });

    it('should create default policy if none exists', async () => {
      retentionRepository.findOne.mockResolvedValue(null);

      const result = await service.getRetentionPolicy(tenantId);

      expect(result.leadDataMonths).toBe(12);
      expect(result.financialDataYears).toBe(5);
      expect(retentionRepository.save).toHaveBeenCalled();
    });
  });

  describe('updateRetentionPolicy', () => {
    it('should update retention policy fields', async () => {
      retentionRepository.findOne.mockResolvedValue({
        id: 'rp-1',
        tenantId,
        leadDataMonths: 12,
        financialDataYears: 5,
        auditLogMonths: 12,
        customRules: [],
      });

      const result = await service.updateRetentionPolicy(tenantId, {
        leadDataMonths: 24,
        financialDataYears: 7,
      });

      expect(retentionRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          leadDataMonths: 24,
          financialDataYears: 7,
        }),
      );
    });

    it('should reject audit log months below 12', async () => {
      await expect(
        service.updateRetentionPolicy(tenantId, { auditLogMonths: 6 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should create policy if none exists when updating', async () => {
      retentionRepository.findOne.mockResolvedValue(null);

      const result = await service.updateRetentionPolicy(tenantId, {
        leadDataMonths: 18,
      });

      expect(retentionRepository.create).toHaveBeenCalled();
      expect(retentionRepository.save).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // ANONYMIZATION
  // ===========================================================================

  describe('anonymize', () => {
    it('should replace subject_id with irreversible hash', async () => {
      consentRepository.find.mockResolvedValue([
        {
          id: 'c1',
          tenantId,
          subjectId,
          collectionMethod: 'form',
          purpose: 'marketing',
          status: 'active',
        },
      ]);

      await service.anonymize(subjectId, tenantId, 'full');

      expect(consentRepository.save).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            subjectId: expect.stringMatching(/^anon_[a-f0-9]{16}$/),
            collectionMethod: 'anonymized',
          }),
        ]),
      );
    });

    it('should emit anonymization event', async () => {
      consentRepository.find.mockResolvedValue([]);

      await service.anonymize(subjectId, tenantId, 'full');

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'privacy.anonymization.requested',
        expect.objectContaining({
          tenantId,
          originalSubjectId: subjectId,
          scope: 'full',
        }),
      );
    });

    it('should preserve collection method in partial anonymization', async () => {
      consentRepository.find.mockResolvedValue([
        {
          id: 'c1',
          tenantId,
          subjectId,
          collectionMethod: 'form',
          purpose: 'marketing',
          status: 'active',
        },
      ]);

      await service.anonymize(subjectId, tenantId, 'partial');

      expect(consentRepository.save).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            collectionMethod: 'form', // preserved in partial
          }),
        ]),
      );
    });
  });

  // ===========================================================================
  // ROPA
  // ===========================================================================

  describe('getROPA', () => {
    it('should return all ROPA records for a tenant', async () => {
      ropaRepository.find.mockResolvedValue([
        {
          id: 'r1',
          tenantId,
          processingActivity: 'Lead Management',
          purpose: 'Marketing',
          dataCategories: ['name', 'email'],
          dataSubjects: ['leads'],
          recipients: ['internal'],
          retentionPeriod: '12 months',
          securityMeasures: ['encryption'],
          legalBasis: 'consent',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const result = await service.getROPA(tenantId);

      expect(result).toHaveLength(1);
      expect(result[0].processingActivity).toBe('Lead Management');
    });
  });

  describe('createROPARecord', () => {
    it('should create a new ROPA record', async () => {
      const dto = {
        processingActivity: 'Customer Communication',
        purpose: 'Appointment Reminders',
        dataCategories: ['name', 'phone'],
        dataSubjects: ['patients'],
        recipients: ['sms_provider'],
        retentionPeriod: '24 months',
        securityMeasures: ['encryption', 'access_control'],
        legalBasis: 'legitimate_interest',
      };

      const result = await service.createROPARecord(tenantId, dto);

      expect(result).toBeDefined();
      expect(ropaRepository.save).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // DPO CONTACT
  // ===========================================================================

  describe('getDPOContact', () => {
    it('should return DPO contact when configured', async () => {
      dpoRepository.findOne.mockResolvedValue({
        id: 'dpo-1',
        tenantId,
        name: 'Jane DPO',
        email: 'dpo@clinic.com',
        phone: '11999999999',
        address: null,
        updatedAt: new Date(),
      });

      const result = await service.getDPOContact(tenantId);

      expect(result.name).toBe('Jane DPO');
      expect(result.email).toBe('dpo@clinic.com');
    });

    it('should throw NotFoundException when DPO not configured', async () => {
      dpoRepository.findOne.mockResolvedValue(null);

      await expect(service.getDPOContact(tenantId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateDPOContact', () => {
    it('should create DPO contact when none exists', async () => {
      dpoRepository.findOne.mockResolvedValue(null);

      const result = await service.updateDPOContact(tenantId, {
        name: 'New DPO',
        email: 'newdpo@clinic.com',
      });

      expect(dpoRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId,
          name: 'New DPO',
          email: 'newdpo@clinic.com',
        }),
      );
    });

    it('should update existing DPO contact', async () => {
      dpoRepository.findOne.mockResolvedValue({
        id: 'dpo-1',
        tenantId,
        name: 'Old DPO',
        email: 'old@clinic.com',
        phone: null,
        address: null,
      });

      await service.updateDPOContact(tenantId, {
        name: 'Updated DPO',
        phone: '11888888888',
      });

      expect(dpoRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Updated DPO',
          phone: '11888888888',
        }),
      );
    });

    it('should require name and email when creating', async () => {
      dpoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.updateDPOContact(tenantId, { phone: '11999' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ===========================================================================
  // CONSENT-GATED PROCESSING
  // ===========================================================================

  describe('isProcessingAllowed', () => {
    it('should return true when active consent exists', async () => {
      consentRepository.findOne.mockResolvedValue({
        id: 'c1',
        status: 'active',
        expiresAt: null,
      });

      const result = await service.isProcessingAllowed(
        subjectId,
        'marketing',
        tenantId,
      );

      expect(result).toBe(true);
    });

    it('should return false when consent is revoked', async () => {
      consentRepository.findOne.mockResolvedValue(null); // revoked consent won't match status='active'

      const result = await service.isProcessingAllowed(
        subjectId,
        'marketing',
        tenantId,
      );

      expect(result).toBe(false);
    });

    it('should return false when consent has expired', async () => {
      consentRepository.findOne.mockResolvedValue({
        id: 'c1',
        status: 'active',
        expiresAt: new Date('2020-01-01'),
      });

      const result = await service.isProcessingAllowed(
        subjectId,
        'marketing',
        tenantId,
      );

      expect(result).toBe(false);
    });
  });
});
