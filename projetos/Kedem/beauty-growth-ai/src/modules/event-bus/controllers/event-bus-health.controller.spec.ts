import { Test, TestingModule } from '@nestjs/testing';

import { EventBusHealth } from '../interfaces';
import { EventBusService } from '../services/event-bus.service';
import { EventBusHealthController } from './event-bus-health.controller';

describe('EventBusHealthController', () => {
  let controller: EventBusHealthController;
  let eventBusService: EventBusService;

  const mockHealthResponse: EventBusHealth = {
    redis: 'up',
    queuesActive: 4,
    workersActive: 2,
    metrics5min: {
      published: { 'tenant.created': 10, 'brand.updated': 5 },
      processed: { 'tenant.created': 8, 'brand.updated': 4 },
      failed: { 'tenant.created': 2, 'brand.updated': 1 },
      avgLatencyMs: { 'tenant.created': 150, 'brand.updated': 200 },
      queueSizes: {},
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EventBusHealthController],
      providers: [
        {
          provide: EventBusService,
          useValue: {
            getHealth: jest.fn().mockResolvedValue(mockHealthResponse),
          },
        },
      ],
    }).compile();

    controller = module.get<EventBusHealthController>(EventBusHealthController);
    eventBusService = module.get<EventBusService>(EventBusService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('GET /events/health', () => {
    it('should return health status from EventBusService', async () => {
      const result = await controller.getHealth();

      expect(result).toEqual(mockHealthResponse);
      expect(eventBusService.getHealth).toHaveBeenCalled();
    });

    it('should return redis status as "up" when connected', async () => {
      const result = await controller.getHealth();

      expect(result.redis).toBe('up');
    });

    it('should return redis status as "down" when disconnected', async () => {
      const downHealth: EventBusHealth = {
        ...mockHealthResponse,
        redis: 'down',
      };
      (eventBusService.getHealth as jest.Mock).mockResolvedValue(downHealth);

      const result = await controller.getHealth();

      expect(result.redis).toBe('down');
    });

    it('should return the number of active queues', async () => {
      const result = await controller.getHealth();

      expect(result.queuesActive).toBe(4);
    });

    it('should return the number of active workers', async () => {
      const result = await controller.getHealth();

      expect(result.workersActive).toBe(2);
    });

    it('should return metrics from the last 5 minutes', async () => {
      const result = await controller.getHealth();

      expect(result.metrics5min).toBeDefined();
      expect(result.metrics5min.published).toEqual({
        'tenant.created': 10,
        'brand.updated': 5,
      });
      expect(result.metrics5min.processed).toEqual({
        'tenant.created': 8,
        'brand.updated': 4,
      });
      expect(result.metrics5min.failed).toEqual({
        'tenant.created': 2,
        'brand.updated': 1,
      });
      expect(result.metrics5min.avgLatencyMs).toEqual({
        'tenant.created': 150,
        'brand.updated': 200,
      });
    });

    it('should handle zero queues and workers when bus is disabled', async () => {
      const disabledHealth: EventBusHealth = {
        redis: 'down',
        queuesActive: 0,
        workersActive: 0,
        metrics5min: {
          published: {},
          processed: {},
          failed: {},
          avgLatencyMs: {},
          queueSizes: {},
        },
      };
      (eventBusService.getHealth as jest.Mock).mockResolvedValue(disabledHealth);

      const result = await controller.getHealth();

      expect(result.redis).toBe('down');
      expect(result.queuesActive).toBe(0);
      expect(result.workersActive).toBe(0);
    });
  });
});
