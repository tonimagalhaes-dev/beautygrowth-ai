import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditService, RecordSuccessParams, RecordFailureParams, RecordReplayParams } from './audit.service';
import { EventAuditLog } from '../entities/event-audit-log.entity';

describe('AuditService', () => {
  let service: AuditService;
  let repo: jest.Mocked<Repository<EventAuditLog>>;

  beforeEach(async () => {
    const mockRepo = {
      create: jest.fn((data) => ({ id: 'mock-uuid', ...data }) as any),
      save: jest.fn((entity) => Promise.resolve(entity)),
      find: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditService,
        {
          provide: getRepositoryToken(EventAuditLog),
          useValue: mockRepo,
        },
      ],
    }).compile();

    service = module.get<AuditService>(AuditService);
    repo = module.get(getRepositoryToken(EventAuditLog));
  });

  describe('recordSuccess', () => {
    it('should create and save an audit entry with status success', async () => {
      const params: RecordSuccessParams = {
        eventName: 'tenant.created',
        payload: { tenantId: 'tenant-1', action: 'created' },
        tenantId: 'tenant-1',
        correlationId: 'corr-123',
        publishedAt: new Date('2024-01-01T10:00:00Z'),
        processedAt: new Date('2024-01-01T10:00:01Z'),
        durationMs: 1000,
        attempts: 1,
      };

      const result = await service.recordSuccess(params);

      expect(repo.create).toHaveBeenCalledWith({
        eventName: 'tenant.created',
        payload: { tenantId: 'tenant-1', action: 'created' },
        tenantId: 'tenant-1',
        correlationId: 'corr-123',
        publishedAt: params.publishedAt,
        processedAt: params.processedAt,
        durationMs: 1000,
        attempts: 1,
        isReplay: false,
        status: 'success',
      });
      expect(repo.save).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('should mark isReplay when provided', async () => {
      const params: RecordSuccessParams = {
        eventName: 'brand.updated',
        payload: { tenantId: 'tenant-2', brandId: 'brand-1' },
        tenantId: 'tenant-2',
        correlationId: 'corr-456',
        publishedAt: new Date('2024-01-01T10:00:00Z'),
        processedAt: new Date('2024-01-01T10:00:02Z'),
        durationMs: 2000,
        attempts: 1,
        isReplay: true,
      };

      await service.recordSuccess(params);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ isReplay: true }),
      );
    });
  });

  describe('recordFailure', () => {
    it('should create and save an audit entry with status failed', async () => {
      const params: RecordFailureParams = {
        eventName: 'tenant.created',
        payload: { tenantId: 'tenant-1' },
        tenantId: 'tenant-1',
        correlationId: 'corr-789',
        publishedAt: new Date('2024-01-01T10:00:00Z'),
        attempts: 5,
        errors: [
          { attempt: 1, error: 'Connection timeout', timestamp: '2024-01-01T10:00:01Z' },
          { attempt: 2, error: 'Connection timeout', timestamp: '2024-01-01T10:00:03Z' },
        ],
      };

      const result = await service.recordFailure(params);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: 'tenant.created',
          tenantId: 'tenant-1',
          correlationId: 'corr-789',
          status: 'failed',
          attempts: 5,
          errors: params.errors,
          isReplay: false,
        }),
      );
      expect(repo.save).toHaveBeenCalled();
      expect(result).toBeDefined();
    });
  });

  describe('recordReplay', () => {
    it('should create an audit entry with status replayed and isReplay true', async () => {
      const params: RecordReplayParams = {
        eventName: 'brand.updated',
        payload: { tenantId: 'tenant-1', brandId: 'brand-1' },
        tenantId: 'tenant-1',
        correlationId: 'new-corr-001',
        originalCorrelationId: 'original-corr-001',
        publishedAt: new Date('2024-01-15T10:00:00Z'),
      };

      const result = await service.recordReplay(params);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: 'brand.updated',
          tenantId: 'tenant-1',
          correlationId: 'new-corr-001',
          isReplay: true,
          status: 'replayed',
          attempts: 0,
        }),
      );
      expect(repo.save).toHaveBeenCalled();
      expect(result).toBeDefined();
    });
  });

  describe('replay', () => {
    it('should query audit entries filtered by eventName only', async () => {
      const mockEntries = [
        { correlationId: 'corr-1' },
        { correlationId: 'corr-2' },
      ] as EventAuditLog[];

      repo.find.mockResolvedValue(mockEntries);

      const result = await service.replay('tenant.created', {});

      expect(repo.find).toHaveBeenCalledWith({
        where: { eventName: 'tenant.created' },
        order: { publishedAt: 'ASC' },
      });
      expect(result.replayed).toBe(2);
      expect(result.correlationIds).toEqual(['corr-1', 'corr-2']);
    });

    it('should apply tenantId filter', async () => {
      repo.find.mockResolvedValue([]);

      await service.replay('brand.updated', { tenantId: 'tenant-1' });

      expect(repo.find).toHaveBeenCalledWith({
        where: { eventName: 'brand.updated', tenantId: 'tenant-1' },
        order: { publishedAt: 'ASC' },
      });
    });

    it('should apply status filter', async () => {
      repo.find.mockResolvedValue([]);

      await service.replay('brand.updated', { status: 'failed' });

      expect(repo.find).toHaveBeenCalledWith({
        where: { eventName: 'brand.updated', status: 'failed' },
        order: { publishedAt: 'ASC' },
      });
    });

    it('should apply date range filter with both startDate and endDate', async () => {
      repo.find.mockResolvedValue([]);
      const startDate = new Date('2024-01-01');
      const endDate = new Date('2024-01-31');

      await service.replay('tenant.created', { startDate, endDate });

      const callArgs = repo.find.mock.calls[0][0] as any;
      expect(callArgs.where.eventName).toBe('tenant.created');
      // Between is a TypeORM FindOperator, verify it was applied
      expect(callArgs.where.publishedAt).toBeDefined();
    });

    it('should apply only startDate filter when endDate is not provided', async () => {
      repo.find.mockResolvedValue([]);
      const startDate = new Date('2024-01-01');

      await service.replay('tenant.created', { startDate });

      const callArgs = repo.find.mock.calls[0][0] as any;
      expect(callArgs.where.publishedAt).toBeDefined();
    });

    it('should apply only endDate filter when startDate is not provided', async () => {
      repo.find.mockResolvedValue([]);
      const endDate = new Date('2024-01-31');

      await service.replay('tenant.created', { endDate });

      const callArgs = repo.find.mock.calls[0][0] as any;
      expect(callArgs.where.publishedAt).toBeDefined();
    });

    it('should combine all filters', async () => {
      const mockEntries = [{ correlationId: 'corr-filtered' }] as EventAuditLog[];
      repo.find.mockResolvedValue(mockEntries);

      const result = await service.replay('guardrails.changed', {
        tenantId: 'tenant-5',
        status: 'success',
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-02-01'),
      });

      const callArgs = repo.find.mock.calls[0][0] as any;
      expect(callArgs.where.eventName).toBe('guardrails.changed');
      expect(callArgs.where.tenantId).toBe('tenant-5');
      expect(callArgs.where.status).toBe('success');
      expect(callArgs.where.publishedAt).toBeDefined();
      expect(result.replayed).toBe(1);
      expect(result.correlationIds).toEqual(['corr-filtered']);
    });

    it('should return empty result when no events match', async () => {
      repo.find.mockResolvedValue([]);

      const result = await service.replay('nonexistent.event', {});

      expect(result.replayed).toBe(0);
      expect(result.correlationIds).toEqual([]);
    });
  });

  describe('getEventsForReplay', () => {
    it('should return full audit log entries for replay', async () => {
      const mockEntries = [
        {
          id: 'entry-1',
          eventName: 'tenant.created',
          payload: { tenantId: 'tenant-1' },
          tenantId: 'tenant-1',
          correlationId: 'corr-1',
        },
      ] as unknown as EventAuditLog[];

      repo.find.mockResolvedValue(mockEntries);

      const result = await service.getEventsForReplay('tenant.created', {
        tenantId: 'tenant-1',
      });

      expect(result).toEqual(mockEntries);
      expect(repo.find).toHaveBeenCalledWith({
        where: { eventName: 'tenant.created', tenantId: 'tenant-1' },
        order: { publishedAt: 'ASC' },
      });
    });
  });
});
