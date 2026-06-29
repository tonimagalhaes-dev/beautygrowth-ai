import * as fc from 'fast-check';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { PrivacyService } from '../services/privacy.service';
import { Consent } from '../entities/consent.entity';
import { RetentionPolicyEntity } from '../entities/retention-policy.entity';
import { DeletionRequest } from '../entities/deletion-request.entity';
import { ROPARecordEntity } from '../entities/ropa-record.entity';
import { DPOContactEntity } from '../entities/dpo-contact.entity';
import { ExportFormat } from '../interfaces/privacy-service.interface';

/**
 * Property 24: Portabilidade de Dados Round-Trip
 *
 * For any titular de dados com dados pessoais armazenados, a exportação DEVE
 * produzir um arquivo (JSON ou CSV) contendo TODOS os dados pessoais do titular
 * associados ao tenant, sem incluir dados de outros titulares.
 *
 * **Validates: Requirements 12.6**
 */
describe('Property 24: Portabilidade de Dados Round-Trip', () => {
  let service: PrivacyService;

  // In-memory stores to simulate repository behavior per subject
  let consentStore: any[];
  let deletionStore: any[];

  const mockConsentRepository = {
    create: jest.fn((dto) => ({ ...dto, id: `consent-${Date.now()}-${Math.random()}`, grantedAt: new Date() })),
    save: jest.fn((entity) => Promise.resolve(Array.isArray(entity) ? entity : { ...entity, id: entity.id || `consent-${Date.now()}` })),
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
    create: jest.fn((dto) => ({ ...dto, id: `deletion-${Date.now()}-${Math.random()}`, requestedAt: new Date() })),
    save: jest.fn((entity) => Promise.resolve({ ...entity, id: entity.id || `deletion-${Date.now()}` })),
    find: jest.fn(),
  };

  const mockRopaRepository = {
    create: jest.fn((dto) => ({ ...dto, id: 'ropa-id-1', createdAt: new Date(), updatedAt: new Date() })),
    save: jest.fn((entity) => Promise.resolve({ ...entity })),
    find: jest.fn(),
  };

  const mockDpoRepository = {
    create: jest.fn((dto) => ({ ...dto, id: 'dpo-id-1', updatedAt: new Date() })),
    save: jest.fn((entity) => Promise.resolve({ ...entity })),
    findOne: jest.fn(),
  };

  const mockEventEmitter = {
    emit: jest.fn(),
  };

  beforeEach(async () => {
    consentStore = [];
    deletionStore = [];

    // Configure find to filter by tenantId and subjectId from the in-memory store
    mockConsentRepository.find.mockImplementation(({ where }) => {
      return Promise.resolve(
        consentStore.filter(
          (c) => c.tenantId === where.tenantId && c.subjectId === where.subjectId,
        ),
      );
    });

    mockDeletionRepository.find.mockImplementation(({ where }) => {
      return Promise.resolve(
        deletionStore.filter(
          (d) => d.tenantId === where.tenantId && d.subjectId === where.subjectId,
        ),
      );
    });

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

    jest.clearAllMocks();

    // Re-bind the mock implementations after clearAllMocks
    mockConsentRepository.find.mockImplementation(({ where }) => {
      return Promise.resolve(
        consentStore.filter(
          (c) => c.tenantId === where.tenantId && c.subjectId === where.subjectId,
        ),
      );
    });

    mockDeletionRepository.find.mockImplementation(({ where }) => {
      return Promise.resolve(
        deletionStore.filter(
          (d) => d.tenantId === where.tenantId && d.subjectId === where.subjectId,
        ),
      );
    });
  });

  // ==========================================================================
  // ARBITRARIES
  // ==========================================================================

  /** Alphanumeric characters for string generation */
  const ALPHANUM_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');

  /** Generates a random alphanumeric string */
  const alphanumStringArb = (minLength: number, maxLength: number) =>
    fc.stringOf(fc.constantFrom(...ALPHANUM_CHARS), { minLength, maxLength });

  /** Generates a random subject with personal data (consents and deletion requests). */
  const subjectDataArb = (tenantId: string) =>
    fc.record({
      subjectId: alphanumStringArb(5, 30),
      consents: fc.array(
        fc.record({
          purpose: alphanumStringArb(3, 30),
          collectionMethod: fc.constantFrom('web_form', 'in_person', 'email', 'api'),
          status: fc.constantFrom('active', 'revoked', 'expired'),
          grantedAt: fc.date({ min: new Date('2020-01-01'), max: new Date('2025-12-31') }),
          expiresAt: fc.option(fc.date({ min: new Date('2025-01-01'), max: new Date('2030-12-31') }), { nil: null }),
          revokedAt: fc.option(fc.date({ min: new Date('2023-01-01'), max: new Date('2025-12-31') }), { nil: null }),
        }),
        { minLength: 1, maxLength: 5 },
      ),
      deletionRequests: fc.array(
        fc.record({
          requestedAt: fc.date({ min: new Date('2023-01-01'), max: new Date('2025-12-31') }),
          status: fc.constantFrom('completed', 'in_progress', 'failed'),
          completedAt: fc.option(fc.date({ min: new Date('2023-01-01'), max: new Date('2025-12-31') }), { nil: null }),
        }),
        { minLength: 0, maxLength: 3 },
      ),
    }).map((data) => ({
      ...data,
      tenantId,
      consents: data.consents.map((c, idx) => ({
        ...c,
        id: `consent-${data.subjectId}-${idx}`,
        tenantId,
        subjectId: data.subjectId,
      })),
      deletionRequests: data.deletionRequests.map((d, idx) => ({
        ...d,
        id: `deletion-${data.subjectId}-${idx}`,
        tenantId,
        subjectId: data.subjectId,
      })),
    }));

  const exportFormatArb = fc.constantFrom<ExportFormat>('json', 'csv');

  // ==========================================================================
  // PROPERTY TESTS
  // ==========================================================================

  it(
    'exported data contains ALL personal data belonging to the subject',
    async () => {
      const tenantId = '11111111-1111-1111-1111-111111111111';

      await fc.assert(
        fc.asyncProperty(
          subjectDataArb(tenantId),
          exportFormatArb,
          async (subjectData, format) => {
            // Seed the stores with this subject's data
            consentStore = [...subjectData.consents];
            deletionStore = [...subjectData.deletionRequests];

            const result = await service.exportData(
              subjectData.subjectId,
              tenantId,
              format,
            );

            // Verify all consents are present in the export
            expect(result.data.consents).toHaveLength(subjectData.consents.length);

            for (let i = 0; i < subjectData.consents.length; i++) {
              const exported = result.data.consents[i];
              const original = subjectData.consents[i];
              expect(exported.id).toBe(original.id);
              expect(exported.purpose).toBe(original.purpose);
              expect(exported.collectionMethod).toBe(original.collectionMethod);
              expect(exported.status).toBe(original.status);
            }

            // Verify all deletion requests are present
            expect(result.data.deletionRequests).toHaveLength(
              subjectData.deletionRequests.length,
            );

            for (let i = 0; i < subjectData.deletionRequests.length; i++) {
              const exported = result.data.deletionRequests[i];
              const original = subjectData.deletionRequests[i];
              expect(exported.id).toBe(original.id);
              expect(exported.status).toBe(original.status);
            }

            // Verify the subjectId is embedded in the export data
            expect(result.data.subjectId).toBe(subjectData.subjectId);
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    'exported data does NOT contain data from other subjects',
    async () => {
      const tenantId = '22222222-2222-2222-2222-222222222222';

      await fc.assert(
        fc.asyncProperty(
          subjectDataArb(tenantId),
          subjectDataArb(tenantId),
          exportFormatArb,
          async (targetSubject, otherSubject, format) => {
            // Ensure subjects have different IDs
            fc.pre(targetSubject.subjectId !== otherSubject.subjectId);

            // Seed stores with BOTH subjects' data
            consentStore = [
              ...targetSubject.consents,
              ...otherSubject.consents,
            ];
            deletionStore = [
              ...targetSubject.deletionRequests,
              ...otherSubject.deletionRequests,
            ];

            const result = await service.exportData(
              targetSubject.subjectId,
              tenantId,
              format,
            );

            // Verify the export belongs to the target subject
            expect(result.subjectId).toBe(targetSubject.subjectId);

            // Verify exported consents only belong to target subject
            for (const consent of result.data.consents) {
              expect(consent.id).not.toMatch(
                new RegExp(`consent-${otherSubject.subjectId}-`),
              );
            }

            // Verify exported deletion requests only belong to target subject
            for (const deletion of result.data.deletionRequests) {
              expect(deletion.id).not.toMatch(
                new RegExp(`deletion-${otherSubject.subjectId}-`),
              );
            }

            // Verify counts match only target subject's data
            expect(result.data.consents).toHaveLength(targetSubject.consents.length);
            expect(result.data.deletionRequests).toHaveLength(
              targetSubject.deletionRequests.length,
            );
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    'export format is valid and matches the requested format',
    async () => {
      const tenantId = '33333333-3333-3333-3333-333333333333';

      await fc.assert(
        fc.asyncProperty(
          subjectDataArb(tenantId),
          exportFormatArb,
          async (subjectData, format) => {
            consentStore = [...subjectData.consents];
            deletionStore = [...subjectData.deletionRequests];

            const result = await service.exportData(
              subjectData.subjectId,
              tenantId,
              format,
            );

            // Verify export metadata
            expect(result.format).toBe(format);
            expect(result.subjectId).toBe(subjectData.subjectId);
            expect(result.tenantId).toBe(tenantId);
            expect(result.generatedAt).toBeInstanceOf(Date);
            expect(result.expiresAt).toBeInstanceOf(Date);

            // Verify expiration is 48h after generation
            const diffMs = result.expiresAt.getTime() - result.generatedAt.getTime();
            const diffHours = diffMs / (1000 * 60 * 60);
            expect(diffHours).toBeCloseTo(48, 0);

            // Verify data is a valid object with expected structure
            expect(result.data).toBeDefined();
            expect(typeof result.data).toBe('object');
            expect(result.data.subjectId).toBeDefined();
            expect(Array.isArray(result.data.consents)).toBe(true);
            expect(Array.isArray(result.data.deletionRequests)).toBe(true);
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    'export with no data still returns valid structure for the subject',
    async () => {
      const tenantId = '44444444-4444-4444-4444-444444444444';

      await fc.assert(
        fc.asyncProperty(
          alphanumStringArb(5, 30),
          exportFormatArb,
          async (subjectId, format) => {
            // Empty stores — subject has no data
            consentStore = [];
            deletionStore = [];

            const result = await service.exportData(subjectId, tenantId, format);

            // Even with no data, export should be valid and reference correct subject
            expect(result.subjectId).toBe(subjectId);
            expect(result.tenantId).toBe(tenantId);
            expect(result.format).toBe(format);
            expect(result.data.subjectId).toBe(subjectId);
            expect(result.data.consents).toHaveLength(0);
            expect(result.data.deletionRequests).toHaveLength(0);
            expect(result.generatedAt).toBeInstanceOf(Date);
            expect(result.expiresAt).toBeInstanceOf(Date);
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});
