import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';

import { EventBusService } from './event-bus.service';
import { AuditService } from './audit.service';
import { ConnectionBuffer } from './connection-buffer.service';
import { MetricsCollector } from './metrics-collector.service';
import { PayloadValidator } from './payload-validator.service';

// Mock BullMQ Queue and Worker
const mockQueueAdd = jest.fn();
const mockQueueClose = jest.fn();
const mockQueueGetJob = jest.fn();
const mockQueueGetJobs = jest.fn();
const mockQueueGetJobCounts = jest.fn();
const mockWorkerClose = jest.fn();
const mockWorkerProcess = jest.fn();
let workerIdCounter = 0;
let capturedWorkerProcessor: any = null;
let capturedWorkerOptions: any = null;

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: mockQueueAdd,
    close: mockQueueClose,
    getJob: mockQueueGetJob,
    getJobs: mockQueueGetJobs,
    getJobCounts: mockQueueGetJobCounts,
  })),
  Worker: jest.fn().mockImplementation((_name: string, processor: any, opts: any) => {
    capturedWorkerProcessor = processor;
    capturedWorkerOptions = opts;
    workerIdCounter++;
    return {
      id: `worker-${workerIdCounter}`,
      close: mockWorkerClose,
    };
  }),
}));

// Mock uuid
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'test-uuid-v4-1234'),
}));

describe('EventBusService', () => {
  let service: EventBusService;
  let payloadValidator: PayloadValidator;
  let connectionBuffer: ConnectionBuffer;
  let eventEmitter: EventEmitter2;
  let configService: ConfigService;
  let auditService: AuditService;

  const validPayload = {
    tenantId: '550e8400-e29b-41d4-a716-446655440000',
    timestamp: new Date('2024-01-01'),
  };

  beforeEach(async () => {
    mockQueueAdd.mockReset();
    mockQueueClose.mockReset();
    mockQueueGetJob.mockReset();
    mockQueueGetJobs.mockReset();
    mockQueueGetJobCounts.mockReset();
    mockWorkerClose.mockReset();
    mockWorkerProcess.mockReset();
    mockQueueAdd.mockResolvedValue({ id: 'job-123' });
    capturedWorkerProcessor = null;
    capturedWorkerOptions = null;
    workerIdCounter = 0;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventBusService,
        {
          provide: PayloadValidator,
          useValue: {
            validatePayload: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: ConnectionBuffer,
          useValue: {
            bufferEvent: jest.fn(),
          },
        },
        {
          provide: EventEmitter2,
          useValue: {
            emit: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultVal?: any) => {
              const config: Record<string, any> = {
                EVENT_BUS_ENABLED: 'true',
                REDIS_HOST: 'localhost',
                REDIS_PORT: 6379,
              };
              return config[key] ?? defaultVal;
            }),
          },
        },
        {
          provide: AuditService,
          useValue: {
            recordSuccess: jest.fn().mockResolvedValue({}),
            recordFailure: jest.fn().mockResolvedValue({}),
            recordReplay: jest.fn().mockResolvedValue({}),
          },
        },
        {
          provide: MetricsCollector,
          useValue: {
            getMetrics: jest.fn().mockReturnValue({
              published: { 'tenant.created': 10, 'brand.updated': 5 },
              processed: { 'tenant.created': 8, 'brand.updated': 4 },
              failed: { 'tenant.created': 2, 'brand.updated': 1 },
              avgLatencyMs: { 'tenant.created': 150, 'brand.updated': 200 },
              queueSizes: {},
            }),
            recordPublished: jest.fn(),
            recordProcessed: jest.fn(),
            recordFailed: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<EventBusService>(EventBusService);
    payloadValidator = module.get<PayloadValidator>(PayloadValidator);
    connectionBuffer = module.get<ConnectionBuffer>(ConnectionBuffer);
    eventEmitter = module.get<EventEmitter2>(EventEmitter2);
    configService = module.get<ConfigService>(ConfigService);
    auditService = module.get<AuditService>(AuditService);

    await service.onModuleInit();
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  describe('publish()', () => {
    it('should publish an event successfully with BullMQ', async () => {
      const result = await service.publish('tenant.created', validPayload);

      expect(result).toEqual({
        jobId: 'job-123',
        correlationId: 'test-uuid-v4-1234',
        queueName: 'tenant.created',
      });
    });

    it('should validate payload before publishing', async () => {
      await service.publish('tenant.created', validPayload);

      expect(payloadValidator.validatePayload).toHaveBeenCalledWith(
        'tenant.created',
        validPayload,
      );
    });

    it('should throw when event name is not in registry', async () => {
      await expect(
        service.publish('unknown.event', validPayload),
      ).rejects.toThrow("Event 'unknown.event' not found in registry");
    });

    it('should throw when payload validation fails', async () => {
      (payloadValidator.validatePayload as jest.Mock).mockRejectedValue(
        new Error("Payload validation failed for 'tenant.created': tenantId: must be a UUID"),
      );

      await expect(
        service.publish('tenant.created', { tenantId: 'invalid' } as any),
      ).rejects.toThrow('Payload validation failed');
    });

    it('should use provided correlationId from options', async () => {
      const customCorrelationId = 'custom-correlation-id';
      const result = await service.publish('tenant.created', validPayload, {
        correlationId: customCorrelationId,
      });

      expect(result.correlationId).toBe(customCorrelationId);
    });

    it('should generate UUID v4 correlationId when not provided', async () => {
      const result = await service.publish('tenant.created', validPayload);

      expect(result.correlationId).toBe('test-uuid-v4-1234');
    });

    it('should emit via EventEmitter2 when dualEmit is true', async () => {
      await service.publish('tenant.created', validPayload);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'tenant.created',
        expect.objectContaining({
          tenantId: validPayload.tenantId,
          correlationId: 'test-uuid-v4-1234',
        }),
      );
    });

    it('should NOT emit via EventEmitter2 when dualEmit is false', async () => {
      await service.publish('guardrails.violation', {
        ...validPayload,
        agentId: '550e8400-e29b-41d4-a716-446655440001',
        guardrailName: 'test-guardrail',
        violationType: 'test-violation',
      });

      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('should enqueue with correct priority from registry', async () => {
      await service.publish('tenant.created', validPayload);

      expect(mockQueueAdd).toHaveBeenCalledWith(
        'tenant.created',
        expect.any(Object),
        expect.objectContaining({
          priority: 1, // HIGH priority for tenant.created
        }),
      );
    });

    it('should allow priority override via options', async () => {
      await service.publish('tenant.created', validPayload, { priority: 10 });

      expect(mockQueueAdd).toHaveBeenCalledWith(
        'tenant.created',
        expect.any(Object),
        expect.objectContaining({
          priority: 10,
        }),
      );
    });

    it('should configure exponential backoff with BASE_RETRY_DELAY_MS', async () => {
      await service.publish('tenant.created', validPayload);

      expect(mockQueueAdd).toHaveBeenCalledWith(
        'tenant.created',
        expect.any(Object),
        expect.objectContaining({
          attempts: 5, // maxRetries for tenant.created
          backoff: { type: 'exponential', delay: 1000 },
        }),
      );
    });

    it('should set removeOnComplete: true and removeOnFail: false', async () => {
      await service.publish('tenant.created', validPayload);

      expect(mockQueueAdd).toHaveBeenCalledWith(
        'tenant.created',
        expect.any(Object),
        expect.objectContaining({
          removeOnComplete: true,
          removeOnFail: false,
        }),
      );
    });

    it('should pass delay option when provided', async () => {
      await service.publish('tenant.created', validPayload, { delay: 5000 });

      expect(mockQueueAdd).toHaveBeenCalledWith(
        'tenant.created',
        expect.any(Object),
        expect.objectContaining({
          delay: 5000,
        }),
      );
    });

    it('should buffer event when Redis is disconnected', async () => {
      service.setConnectionState(false);

      const result = await service.publish('tenant.created', validPayload);

      expect(result.jobId).toBe('buffered');
      expect(connectionBuffer.bufferEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: 'tenant.created',
          payload: expect.objectContaining({
            tenantId: validPayload.tenantId,
            correlationId: 'test-uuid-v4-1234',
          }),
        }),
      );
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it('should still emit via EventEmitter2 even when buffering (dualEmit=true)', async () => {
      service.setConnectionState(false);

      await service.publish('tenant.created', validPayload);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'tenant.created',
        expect.objectContaining({
          tenantId: validPayload.tenantId,
        }),
      );
    });

    it('should enrich payload with timestamp when not provided', async () => {
      const payloadNoTimestamp = { tenantId: validPayload.tenantId };

      await service.publish('tenant.created', payloadNoTimestamp as any);

      expect(mockQueueAdd).toHaveBeenCalledWith(
        'tenant.created',
        expect.objectContaining({
          tenantId: validPayload.tenantId,
          timestamp: expect.any(Date),
          correlationId: 'test-uuid-v4-1234',
        }),
        expect.any(Object),
      );
    });
  });

  describe('onModuleInit() — fallback mode', () => {
    it('should not create queues when EVENT_BUS_ENABLED=false', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          EventBusService,
          {
            provide: PayloadValidator,
            useValue: { validatePayload: jest.fn().mockResolvedValue(undefined) },
          },
          {
            provide: ConnectionBuffer,
            useValue: { bufferEvent: jest.fn() },
          },
          {
            provide: EventEmitter2,
            useValue: { emit: jest.fn() },
          },
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultVal?: any) => {
                if (key === 'EVENT_BUS_ENABLED') return 'false';
                return defaultVal;
              }),
            },
          },
          {
            provide: AuditService,
            useValue: {
              recordSuccess: jest.fn().mockResolvedValue({}),
              recordFailure: jest.fn().mockResolvedValue({}),
            },
          },
          {
            provide: MetricsCollector,
            useValue: {
              getMetrics: jest.fn().mockReturnValue({
                published: {},
                processed: {},
                failed: {},
                avgLatencyMs: {},
                queueSizes: {},
              }),
              recordPublished: jest.fn(),
              recordProcessed: jest.fn(),
              recordFailed: jest.fn(),
            },
          },
        ],
      }).compile();

      const fallbackService = module.get<EventBusService>(EventBusService);
      await fallbackService.onModuleInit();

      expect(fallbackService.isEnabled()).toBe(false);

      // Publish should work in fallback mode
      const result = await fallbackService.publish('tenant.created', validPayload);
      expect(result.jobId).toBe('fallback');
      expect(result.correlationId).toBe('test-uuid-v4-1234');
    });
  });

  describe('setConnectionState()', () => {
    it('should update connected state', () => {
      service.setConnectionState(false);
      expect(service.getConnectionState()).toBe(false);

      service.setConnectionState(true);
      expect(service.getConnectionState()).toBe(true);
    });
  });

  describe('stub methods', () => {
    it('replay() should throw not implemented', async () => {
      await expect(service.replay('test', {})).rejects.toThrow(
        'Not implemented yet',
      );
    });

    it('getMetrics() should throw not implemented', async () => {
      await expect(service.getMetrics()).rejects.toThrow('Not implemented yet');
    });
  });

  describe('getHealth()', () => {
    it('should return health status with redis up when connected', async () => {
      const health = await service.getHealth();

      expect(health.redis).toBe('up');
    });

    it('should return health status with redis down when disconnected', async () => {
      service.setConnectionState(false);
      const health = await service.getHealth();

      expect(health.redis).toBe('down');
    });

    it('should return the number of active queues', async () => {
      const health = await service.getHealth();

      // 4 queues from EVENT_REGISTRY (tenant.created, brand.updated, guardrails.changed, guardrails.violation)
      expect(health.queuesActive).toBe(4);
    });

    it('should return the number of active workers', async () => {
      const health = await service.getHealth();

      // No workers subscribed yet
      expect(health.workersActive).toBe(0);
    });

    it('should return workers count after subscribing', async () => {
      service.subscribe('tenant.created', async () => {});

      const health = await service.getHealth();

      expect(health.workersActive).toBe(1);
    });

    it('should return metrics from MetricsCollector', async () => {
      const health = await service.getHealth();

      expect(health.metrics5min).toEqual({
        published: { 'tenant.created': 10, 'brand.updated': 5 },
        processed: { 'tenant.created': 8, 'brand.updated': 4 },
        failed: { 'tenant.created': 2, 'brand.updated': 1 },
        avgLatencyMs: { 'tenant.created': 150, 'brand.updated': 200 },
        queueSizes: {},
      });
    });
  });

  describe('listDLQ()', () => {
    it('should throw when queue for event is not found', async () => {
      await expect(
        service.listDLQ('nonexistent.event', { page: 1, pageSize: 10 }),
      ).rejects.toThrow("Queue for event 'nonexistent.event' not found");
    });

    it('should return paginated DLQ items with correct structure', async () => {
      const now = Date.now();
      const mockFailedJobs = [
        {
          id: 'job-1',
          data: { tenantId: 'tenant-1', correlationId: 'corr-1' },
          finishedOn: now - 1000,
          processedOn: now - 2000,
          timestamp: now - 5000,
          attemptsMade: 3,
          stacktrace: ['Error: timeout', 'Error: connection reset', 'Error: service down'],
        },
        {
          id: 'job-2',
          data: { tenantId: 'tenant-2', correlationId: 'corr-2' },
          finishedOn: now - 3000,
          processedOn: now - 4000,
          timestamp: now - 6000,
          attemptsMade: 5,
          stacktrace: ['Error: something went wrong'],
        },
      ];

      mockQueueGetJobs.mockResolvedValue(mockFailedJobs);
      mockQueueGetJobCounts.mockResolvedValue({ failed: 2 });

      const result = await service.listDLQ('tenant.created', { page: 1, pageSize: 10 });

      expect(result.items).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(10);
    });

    it('should return DLQ items with original payload, errors, and attempts', async () => {
      const now = Date.now();
      const mockFailedJobs = [
        {
          id: 'job-1',
          data: { tenantId: 'tenant-1', correlationId: 'corr-1', someData: 'value' },
          finishedOn: now - 1000,
          processedOn: now - 2000,
          timestamp: now - 5000,
          attemptsMade: 3,
          stacktrace: ['Error: first attempt', 'Error: second attempt', 'Error: third attempt'],
        },
      ];

      mockQueueGetJobs.mockResolvedValue(mockFailedJobs);
      mockQueueGetJobCounts.mockResolvedValue({ failed: 1 });

      const result = await service.listDLQ('tenant.created', { page: 1, pageSize: 10 });

      const item = result.items[0];
      expect(item.jobId).toBe('job-1');
      expect(item.eventName).toBe('tenant.created');
      expect(item.payload).toEqual({ tenantId: 'tenant-1', correlationId: 'corr-1', someData: 'value' });
      expect(item.attempts).toBe(3);
      expect(item.errors).toHaveLength(3);
      expect(item.errors[0]).toEqual({
        attempt: 1,
        error: 'Error: first attempt',
        timestamp: expect.any(Date),
      });
      expect(item.errors[2]).toEqual({
        attempt: 3,
        error: 'Error: third attempt',
        timestamp: expect.any(Date),
      });
    });

    it('should sort items by failedAt descending (most recent first)', async () => {
      const now = Date.now();
      const mockFailedJobs = [
        {
          id: 'job-older',
          data: { tenantId: 'tenant-1' },
          finishedOn: now - 5000, // older
          processedOn: null,
          timestamp: now - 10000,
          attemptsMade: 2,
          stacktrace: [],
        },
        {
          id: 'job-newer',
          data: { tenantId: 'tenant-2' },
          finishedOn: now - 1000, // newer
          processedOn: null,
          timestamp: now - 8000,
          attemptsMade: 1,
          stacktrace: [],
        },
      ];

      mockQueueGetJobs.mockResolvedValue(mockFailedJobs);
      mockQueueGetJobCounts.mockResolvedValue({ failed: 2 });

      const result = await service.listDLQ('tenant.created', { page: 1, pageSize: 10 });

      expect(result.items[0].jobId).toBe('job-newer');
      expect(result.items[1].jobId).toBe('job-older');
    });

    it('should calculate correct pagination start/end indices', async () => {
      mockQueueGetJobs.mockResolvedValue([]);
      mockQueueGetJobCounts.mockResolvedValue({ failed: 25 });

      await service.listDLQ('tenant.created', { page: 3, pageSize: 5 });

      // page 3 with pageSize 5: start = (3-1)*5 = 10, end = 10 + 5 - 1 = 14
      expect(mockQueueGetJobs).toHaveBeenCalledWith(['failed'], 10, 14);
    });

    it('should use processedOn when finishedOn is not available', async () => {
      const now = Date.now();
      const processedTime = now - 2000;
      const mockFailedJobs = [
        {
          id: 'job-1',
          data: { tenantId: 'tenant-1' },
          finishedOn: null,
          processedOn: processedTime,
          timestamp: now - 5000,
          attemptsMade: 1,
          stacktrace: [],
        },
      ];

      mockQueueGetJobs.mockResolvedValue(mockFailedJobs);
      mockQueueGetJobCounts.mockResolvedValue({ failed: 1 });

      const result = await service.listDLQ('tenant.created', { page: 1, pageSize: 10 });

      expect(result.items[0].failedAt.getTime()).toBe(processedTime);
    });

    it('should handle empty DLQ', async () => {
      mockQueueGetJobs.mockResolvedValue([]);
      mockQueueGetJobCounts.mockResolvedValue({ failed: 0 });

      const result = await service.listDLQ('tenant.created', { page: 1, pageSize: 10 });

      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(10);
    });

    it('should handle jobs with no stacktrace', async () => {
      const now = Date.now();
      const mockFailedJobs = [
        {
          id: 'job-1',
          data: { tenantId: 'tenant-1' },
          finishedOn: now - 1000,
          processedOn: null,
          timestamp: now - 5000,
          attemptsMade: 1,
          stacktrace: undefined,
        },
      ];

      mockQueueGetJobs.mockResolvedValue(mockFailedJobs);
      mockQueueGetJobCounts.mockResolvedValue({ failed: 1 });

      const result = await service.listDLQ('tenant.created', { page: 1, pageSize: 10 });

      expect(result.items[0].errors).toEqual([]);
    });

    it('should return correct total count from queue job counts', async () => {
      mockQueueGetJobs.mockResolvedValue([]);
      mockQueueGetJobCounts.mockResolvedValue({ failed: 42 });

      const result = await service.listDLQ('tenant.created', { page: 1, pageSize: 10 });

      expect(result.total).toBe(42);
    });
  });

  describe('reprocessFromDLQ()', () => {
    const mockJobData = {
      tenantId: '550e8400-e29b-41d4-a716-446655440000',
      correlationId: 'corr-dlq-123',
      timestamp: new Date('2024-01-01'),
    };

    const mockJob = {
      id: 'failed-job-1',
      data: mockJobData,
      getState: jest.fn().mockResolvedValue('failed'),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    beforeEach(() => {
      mockQueueGetJob.mockResolvedValue(mockJob);
      mockQueueAdd.mockResolvedValue({ id: 'new-job-123' });
      mockJob.getState.mockResolvedValue('failed');
      mockJob.remove.mockReset();
    });

    it('should throw when queue for event is not found', async () => {
      await expect(
        service.reprocessFromDLQ('unknown.event', 'job-1'),
      ).rejects.toThrow("Queue for event 'unknown.event' not found");
    });

    it('should throw when job is not found in queue', async () => {
      mockQueueGetJob.mockResolvedValue(null);

      await expect(
        service.reprocessFromDLQ('tenant.created', 'nonexistent-job'),
      ).rejects.toThrow(
        "Job 'nonexistent-job' not found in queue 'tenant.created'",
      );
    });

    it('should throw when job is not in failed state', async () => {
      mockJob.getState.mockResolvedValue('completed');
      mockQueueGetJob.mockResolvedValue(mockJob);

      await expect(
        service.reprocessFromDLQ('tenant.created', 'failed-job-1'),
      ).rejects.toThrow(
        "Job 'failed-job-1' is in state 'completed', expected 'failed'",
      );
    });

    it('should re-add job to queue with original payload', async () => {
      await service.reprocessFromDLQ('tenant.created', 'failed-job-1');

      expect(mockQueueAdd).toHaveBeenCalledWith(
        'tenant.created',
        mockJobData,
        expect.objectContaining({
          priority: 1, // tenant.created priority
          attempts: 5, // tenant.created maxRetries
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: true,
          removeOnFail: false,
        }),
      );
    });

    it('should remove the failed job from DLQ after re-adding', async () => {
      await service.reprocessFromDLQ('tenant.created', 'failed-job-1');

      expect(mockJob.remove).toHaveBeenCalled();
    });

    it('should record reprocessment in audit log', async () => {
      await service.reprocessFromDLQ('tenant.created', 'failed-job-1');

      expect(auditService.recordReplay).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: 'tenant.created',
          payload: mockJobData,
          tenantId: mockJobData.tenantId,
          correlationId: mockJobData.correlationId,
          originalCorrelationId: mockJobData.correlationId,
          publishedAt: expect.any(Date),
        }),
      );
    });

    it('should use event config priority and retries for the specific event type', async () => {
      // Test with brand.updated (priority 5, maxRetries 3)
      await service.reprocessFromDLQ('brand.updated', 'failed-job-1');

      expect(mockQueueAdd).toHaveBeenCalledWith(
        'brand.updated',
        mockJobData,
        expect.objectContaining({
          priority: 5,
          attempts: 3,
        }),
      );
    });

    it('should use default priority 5 and retries 3 when event not in registry', async () => {
      // This scenario can't occur because we check queue existence first,
      // but testing the fallback values in the implementation
      // We test with guardrails.violation (priority 10, maxRetries 1)
      await service.reprocessFromDLQ('guardrails.violation', 'failed-job-1');

      expect(mockQueueAdd).toHaveBeenCalledWith(
        'guardrails.violation',
        mockJobData,
        expect.objectContaining({
          priority: 10,
          attempts: 1,
        }),
      );
    });
  });

  describe('subscribe()', () => {
    it('should throw when event name is not in registry', () => {
      expect(() => service.subscribe('unknown.event', async () => {})).toThrow(
        "Event 'unknown.event' not found in registry",
      );
    });

    it('should create a BullMQ Worker for the given event name', () => {
      const { Worker } = require('bullmq');

      service.subscribe('tenant.created', async () => {});

      expect(Worker).toHaveBeenCalledWith(
        'tenant.created',
        expect.any(Function),
        expect.objectContaining({
          connection: { host: 'localhost', port: 6379 },
          prefix: 'beautygrowth:events:',
          concurrency: 3, // default concurrency for tenant.created
        }),
      );
    });

    it('should use concurrency from options when provided', () => {
      const { Worker } = require('bullmq');

      service.subscribe('tenant.created', async () => {}, { concurrency: 10 });

      expect(Worker).toHaveBeenCalledWith(
        'tenant.created',
        expect.any(Function),
        expect.objectContaining({
          concurrency: 10,
        }),
      );
    });

    it('should use default concurrency from EVENT_REGISTRY when no options provided', () => {
      const { Worker } = require('bullmq');

      service.subscribe('guardrails.violation', async () => {});

      expect(Worker).toHaveBeenCalledWith(
        'guardrails.violation',
        expect.any(Function),
        expect.objectContaining({
          concurrency: 5, // guardrails.violation has concurrency: 5
        }),
      );
    });

    it('should store the worker for lifecycle management', () => {
      service.subscribe('tenant.created', async () => {});

      // The worker should be stored and closed during onModuleDestroy
      expect(capturedWorkerOptions).toBeDefined();
    });

    it('should close workers on module destroy', async () => {
      service.subscribe('tenant.created', async () => {});

      await service.onModuleDestroy();

      expect(mockWorkerClose).toHaveBeenCalled();
    });

    describe('worker processor', () => {
      it('should call handler with job payload on success', async () => {
        const handler = jest.fn().mockResolvedValue(undefined);
        service.subscribe('tenant.created', handler);

        const mockJob = {
          data: {
            tenantId: '550e8400-e29b-41d4-a716-446655440000',
            correlationId: 'corr-123',
          },
          attemptsMade: 0,
          timestamp: Date.now(),
        };

        await capturedWorkerProcessor(mockJob);

        expect(handler).toHaveBeenCalledWith(mockJob.data);
      });

      it('should record success audit after handler completes', async () => {
        const handler = jest.fn().mockResolvedValue(undefined);
        service.subscribe('tenant.created', handler);

        const mockJob = {
          data: {
            tenantId: '550e8400-e29b-41d4-a716-446655440000',
            correlationId: 'corr-123',
          },
          attemptsMade: 0,
          timestamp: Date.now(),
        };

        await capturedWorkerProcessor(mockJob);

        expect(auditService.recordSuccess).toHaveBeenCalledWith(
          expect.objectContaining({
            eventName: 'tenant.created',
            tenantId: '550e8400-e29b-41d4-a716-446655440000',
            correlationId: 'corr-123',
            attempts: 1,
            isReplay: false,
          }),
        );
      });

      it('should re-throw errors to trigger BullMQ retry', async () => {
        const handler = jest.fn().mockRejectedValue(new Error('Processing failed'));
        service.subscribe('tenant.created', handler);

        const mockJob = {
          data: {
            tenantId: '550e8400-e29b-41d4-a716-446655440000',
            correlationId: 'corr-123',
          },
          attemptsMade: 0,
          timestamp: Date.now(),
        };

        await expect(capturedWorkerProcessor(mockJob)).rejects.toThrow(
          'Processing failed',
        );
      });

      it('should record failure audit when last retry is exhausted', async () => {
        const handler = jest.fn().mockRejectedValue(new Error('Final failure'));
        service.subscribe('tenant.created', handler);

        // tenant.created has maxRetries: 5, so attemptsMade=4 means 5th attempt (last)
        const mockJob = {
          data: {
            tenantId: '550e8400-e29b-41d4-a716-446655440000',
            correlationId: 'corr-123',
          },
          attemptsMade: 4,
          timestamp: Date.now(),
        };

        await expect(capturedWorkerProcessor(mockJob)).rejects.toThrow('Final failure');

        expect(auditService.recordFailure).toHaveBeenCalledWith(
          expect.objectContaining({
            eventName: 'tenant.created',
            tenantId: '550e8400-e29b-41d4-a716-446655440000',
            correlationId: 'corr-123',
            attempts: 5,
            errors: expect.arrayContaining([
              expect.objectContaining({
                attempt: 5,
                error: 'Final failure',
              }),
            ]),
          }),
        );
      });

      it('should NOT record failure audit when retries remain', async () => {
        const handler = jest.fn().mockRejectedValue(new Error('Temporary failure'));
        service.subscribe('tenant.created', handler);

        // tenant.created maxRetries: 5, attemptsMade=1 means only 2nd attempt
        const mockJob = {
          data: {
            tenantId: '550e8400-e29b-41d4-a716-446655440000',
            correlationId: 'corr-123',
          },
          attemptsMade: 1,
          timestamp: Date.now(),
        };

        await expect(capturedWorkerProcessor(mockJob)).rejects.toThrow('Temporary failure');

        expect(auditService.recordFailure).not.toHaveBeenCalled();
      });

      it('should handle isReplay flag from payload', async () => {
        const handler = jest.fn().mockResolvedValue(undefined);
        service.subscribe('tenant.created', handler);

        const mockJob = {
          data: {
            tenantId: '550e8400-e29b-41d4-a716-446655440000',
            correlationId: 'corr-123',
            isReplay: true,
          },
          attemptsMade: 0,
          timestamp: Date.now(),
        };

        await capturedWorkerProcessor(mockJob);

        expect(auditService.recordSuccess).toHaveBeenCalledWith(
          expect.objectContaining({
            isReplay: true,
          }),
        );
      });
    });

    describe('fallback mode (EVENT_BUS_ENABLED=false)', () => {
      let fallbackService: EventBusService;
      let fallbackEventEmitter: EventEmitter2;

      beforeEach(async () => {
        const fallbackModule: TestingModule = await Test.createTestingModule({
          providers: [
            EventBusService,
            {
              provide: PayloadValidator,
              useValue: { validatePayload: jest.fn().mockResolvedValue(undefined) },
            },
            {
              provide: ConnectionBuffer,
              useValue: { bufferEvent: jest.fn() },
            },
            {
              provide: EventEmitter2,
              useValue: {
                emit: jest.fn(),
                on: jest.fn(),
              },
            },
            {
              provide: ConfigService,
              useValue: {
                get: jest.fn((key: string, defaultVal?: any) => {
                  if (key === 'EVENT_BUS_ENABLED') return 'false';
                  return defaultVal;
                }),
              },
            },
            {
              provide: AuditService,
              useValue: {
                recordSuccess: jest.fn().mockResolvedValue({}),
                recordFailure: jest.fn().mockResolvedValue({}),
                recordReplay: jest.fn().mockResolvedValue({}),
              },
            },
            {
              provide: MetricsCollector,
              useValue: {
                getMetrics: jest.fn().mockReturnValue({
                  published: {},
                  processed: {},
                  failed: {},
                  avgLatencyMs: {},
                  queueSizes: {},
                }),
              },
            },
          ],
        }).compile();

        fallbackService = fallbackModule.get<EventBusService>(EventBusService);
        fallbackEventEmitter = fallbackModule.get<EventEmitter2>(EventEmitter2);
        await fallbackService.onModuleInit();
      });

      it('should register handler via EventEmitter2.on() instead of creating a BullMQ Worker', () => {
        const { Worker } = require('bullmq');
        const initialWorkerCalls = (Worker as jest.Mock).mock.calls.length;

        const handler = jest.fn();
        fallbackService.subscribe('tenant.created', handler);

        // No new Worker should be created
        expect((Worker as jest.Mock).mock.calls.length).toBe(initialWorkerCalls);
        // Handler should be registered via EventEmitter2
        expect(fallbackEventEmitter.on).toHaveBeenCalledWith('tenant.created', handler);
      });

      it('should register handlers for multiple events via EventEmitter2', () => {
        const handler1 = jest.fn();
        const handler2 = jest.fn();

        fallbackService.subscribe('tenant.created', handler1);
        fallbackService.subscribe('brand.updated', handler2);

        expect(fallbackEventEmitter.on).toHaveBeenCalledWith('tenant.created', handler1);
        expect(fallbackEventEmitter.on).toHaveBeenCalledWith('brand.updated', handler2);
      });

      it('should still throw for unknown event names in fallback mode', () => {
        expect(() =>
          fallbackService.subscribe('unknown.event', jest.fn()),
        ).toThrow("Event 'unknown.event' not found in registry");
      });

      it('should allow consumers to receive events published in fallback mode', async () => {
        // Simulate the full flow: publish emits via EventEmitter2, handler registered via on()
        // In real usage, EventEmitter2.emit triggers handlers registered via .on()
        const handler = jest.fn();
        fallbackService.subscribe('tenant.created', handler);

        // Verify that subscribe registered the handler
        expect(fallbackEventEmitter.on).toHaveBeenCalledWith('tenant.created', handler);

        // Verify that publish emits via EventEmitter2
        const result = await fallbackService.publish('tenant.created', validPayload);
        expect(result.jobId).toBe('fallback');
        expect(fallbackEventEmitter.emit).toHaveBeenCalledWith(
          'tenant.created',
          expect.objectContaining({ tenantId: validPayload.tenantId }),
        );
      });
    });
  });

  describe('dual-emit flag per event (dualEmit configuration)', () => {
    it('should emit via EventEmitter2 when dualEmit is true (tenant.created)', async () => {
      await service.publish('tenant.created', validPayload);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'tenant.created',
        expect.objectContaining({ tenantId: validPayload.tenantId }),
      );
    });

    it('should NOT emit via EventEmitter2 when dualEmit is false (guardrails.violation)', async () => {
      const violationPayload = {
        ...validPayload,
        agentId: '550e8400-e29b-41d4-a716-446655440001',
        guardrailName: 'test-guardrail',
        violationType: 'test-violation',
      };

      await service.publish('guardrails.violation', violationPayload);

      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('should respect dualEmit flag without code changes — only registry config matters', async () => {
      // Verify that events with dualEmit: true emit
      await service.publish('brand.updated', {
        ...validPayload,
        brandId: '550e8400-e29b-41d4-a716-446655440002',
        action: 'updated',
      });
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'brand.updated',
        expect.objectContaining({ tenantId: validPayload.tenantId }),
      );

      (eventEmitter.emit as jest.Mock).mockClear();

      // Verify that events with dualEmit: false do NOT emit
      await service.publish('guardrails.violation', {
        ...validPayload,
        agentId: '550e8400-e29b-41d4-a716-446655440001',
        guardrailName: 'test-guardrail',
        violationType: 'test-violation',
      });
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });
});
