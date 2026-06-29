import * as fc from 'fast-check';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { PrivacyService } from '../services/privacy.service';
import { Consent } from '../entities/consent.entity';

/**
 * Property 22: Consentimento Controla Processamento
 *
 * For any personal data processing operation for a data subject, the system MUST
 * verify the consent status. If consent is 'active', processing is allowed.
 * If 'revoked' or 'expired', processing MUST be blocked immediately.
 * If no consent exists, processing MUST be blocked.
 *
 * **Validates: Requirements 12.1, 12.8, 12.9**
 */
describe('Property 22: Consentimento Controla Processamento', () => {
  const mockTenantId = '11111111-1111-1111-1111-111111111111';

  // =========================================================================
  // Helpers
  // =========================================================================

  /**
   * Creates a fresh PrivacyService instance with a mocked consent repository.
   * The `findOneBehavior` determines how `consentRepository.findOne` will respond.
   */
  function createService(findOneBehavior: jest.Mock): PrivacyService {
    const consentRepository = {
      create: jest.fn((dto) => ({ ...dto, id: 'consent-id', grantedAt: new Date() })),
      save: jest.fn((entity) => Promise.resolve(entity)),
      findOne: findOneBehavior,
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
    };

    const retentionRepository = {
      create: jest.fn((dto) => dto),
      save: jest.fn((entity) => Promise.resolve(entity)),
      findOne: jest.fn().mockResolvedValue(null),
    };

    const deletionRepository = {
      create: jest.fn((dto) => ({ ...dto, id: 'del-id', requestedAt: new Date() })),
      save: jest.fn((entity) => Promise.resolve(entity)),
      find: jest.fn().mockResolvedValue([]),
    };

    const ropaRepository = {
      create: jest.fn((dto) => dto),
      save: jest.fn((entity) => Promise.resolve(entity)),
      find: jest.fn().mockResolvedValue([]),
    };

    const dpoRepository = {
      create: jest.fn((dto) => dto),
      save: jest.fn((entity) => Promise.resolve(entity)),
      findOne: jest.fn().mockResolvedValue(null),
    };

    const eventEmitter = { emit: jest.fn() };

    return new PrivacyService(
      consentRepository as any,
      retentionRepository as any,
      deletionRepository as any,
      ropaRepository as any,
      dpoRepository as any,
      eventEmitter as any,
    );
  }

  // =========================================================================
  // Arbitraries (generators)
  // =========================================================================

  /** Generates a valid UUID-like tenant ID */
  const tenantIdArb = fc.uuid();

  /** Generates a non-empty subject ID */
  const subjectIdArb = fc.stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')),
    { minLength: 3, maxLength: 50 },
  );

  /** Generates a consent purpose */
  const purposeArb = fc.constantFrom(
    'marketing',
    'data_analysis',
    'appointment_reminders',
    'treatment_records',
    'billing',
    'research',
    'communication',
    'profiling',
    'third_party_sharing',
    'newsletter',
  );

  /** Generates a collection method */
  const collectionMethodArb = fc.constantFrom(
    'web_form',
    'in_person',
    'verbal',
    'mobile_app',
    'email_confirmation',
  );

  /** Generates a future date (active expiration) */
  const futureDateArb = fc.date({
    min: new Date(Date.now() + 24 * 60 * 60 * 1000), // at least 1 day from now
    max: new Date('2099-12-31'),
  });

  /** Generates a past date (expired) */
  const pastDateArb = fc.date({
    min: new Date('2000-01-01'),
    max: new Date(Date.now() - 24 * 60 * 60 * 1000), // at least 1 day ago
  });

  // =========================================================================
  // Property Tests
  // =========================================================================

  describe('Active consent → processing IS allowed', () => {
    it('checkConsent returns true for active consent without expiration', async () => {
      await fc.assert(
        fc.asyncProperty(
          subjectIdArb,
          purposeArb,
          tenantIdArb,
          collectionMethodArb,
          async (subjectId, purpose, tenantId, collectionMethod) => {
            // Simulate an active consent record with no expiration
            const findOneMock = jest.fn().mockResolvedValue({
              id: 'consent-active-1',
              tenantId,
              subjectId,
              purpose,
              collectionMethod,
              status: 'active',
              grantedAt: new Date(),
              expiresAt: null,
              revokedAt: null,
            } as Partial<Consent>);

            const service = createService(findOneMock);

            const result = await service.checkConsent(subjectId, purpose, tenantId);
            expect(result).toBe(true);

            // isProcessingAllowed delegates to checkConsent — same result
            const processingResult = await service.isProcessingAllowed(
              subjectId,
              purpose,
              tenantId,
            );
            expect(processingResult).toBe(true);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('checkConsent returns true for active consent with future expiration', async () => {
      await fc.assert(
        fc.asyncProperty(
          subjectIdArb,
          purposeArb,
          tenantIdArb,
          futureDateArb,
          async (subjectId, purpose, tenantId, expiresAt) => {
            const findOneMock = jest.fn().mockResolvedValue({
              id: 'consent-active-future',
              tenantId,
              subjectId,
              purpose,
              collectionMethod: 'web_form',
              status: 'active',
              grantedAt: new Date(),
              expiresAt,
              revokedAt: null,
            } as Partial<Consent>);

            const service = createService(findOneMock);

            const result = await service.checkConsent(subjectId, purpose, tenantId);
            expect(result).toBe(true);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('Revoked consent → processing IS BLOCKED', () => {
    it('checkConsent returns false when consent is revoked (no active record found)', async () => {
      await fc.assert(
        fc.asyncProperty(
          subjectIdArb,
          purposeArb,
          tenantIdArb,
          async (subjectId, purpose, tenantId) => {
            // When consent is revoked, findOne with status='active' returns null
            // because the query filters by status='active'
            const findOneMock = jest.fn().mockResolvedValue(null);

            const service = createService(findOneMock);

            const result = await service.checkConsent(subjectId, purpose, tenantId);
            expect(result).toBe(false);

            const processingResult = await service.isProcessingAllowed(
              subjectId,
              purpose,
              tenantId,
            );
            expect(processingResult).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('Expired consent → processing IS BLOCKED', () => {
    it('checkConsent returns false when consent expiresAt is in the past', async () => {
      await fc.assert(
        fc.asyncProperty(
          subjectIdArb,
          purposeArb,
          tenantIdArb,
          pastDateArb,
          async (subjectId, purpose, tenantId, expiresAt) => {
            // Consent record is still marked 'active' in DB but has expired
            const consentRecord = {
              id: 'consent-expired-1',
              tenantId,
              subjectId,
              purpose,
              collectionMethod: 'web_form',
              status: 'active' as const,
              grantedAt: new Date('2020-01-01'),
              expiresAt,
              revokedAt: null,
            };

            const findOneMock = jest.fn().mockResolvedValue(consentRecord);

            const service = createService(findOneMock);

            const result = await service.checkConsent(subjectId, purpose, tenantId);
            expect(result).toBe(false);

            // Verify the consent was marked as expired in the save call
            const consentRepo = (service as any).consentRepository;
            expect(consentRepo.save).toHaveBeenCalledWith(
              expect.objectContaining({ status: 'expired' }),
            );
          },
        ),
        { numRuns: 100 },
      );
    });

    it('isProcessingAllowed returns false for expired consent', async () => {
      await fc.assert(
        fc.asyncProperty(
          subjectIdArb,
          purposeArb,
          tenantIdArb,
          pastDateArb,
          async (subjectId, purpose, tenantId, expiresAt) => {
            const consentRecord = {
              id: 'consent-expired-2',
              tenantId,
              subjectId,
              purpose,
              collectionMethod: 'in_person',
              status: 'active' as const,
              grantedAt: new Date('2019-06-15'),
              expiresAt,
              revokedAt: null,
            };

            const findOneMock = jest.fn().mockResolvedValue(consentRecord);

            const service = createService(findOneMock);

            const processingResult = await service.isProcessingAllowed(
              subjectId,
              purpose,
              tenantId,
            );
            expect(processingResult).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('Non-existent consent → processing IS BLOCKED', () => {
    it('checkConsent returns false when no consent record exists', async () => {
      await fc.assert(
        fc.asyncProperty(
          subjectIdArb,
          purposeArb,
          tenantIdArb,
          async (subjectId, purpose, tenantId) => {
            // No consent record found at all
            const findOneMock = jest.fn().mockResolvedValue(null);

            const service = createService(findOneMock);

            const result = await service.checkConsent(subjectId, purpose, tenantId);
            expect(result).toBe(false);

            const processingResult = await service.isProcessingAllowed(
              subjectId,
              purpose,
              tenantId,
            );
            expect(processingResult).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
