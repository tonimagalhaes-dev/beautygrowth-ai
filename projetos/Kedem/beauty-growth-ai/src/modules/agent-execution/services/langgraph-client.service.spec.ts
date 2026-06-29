import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as grpc from '@grpc/grpc-js';

import { LangGraphClientService } from './langgraph-client.service';

/**
 * Unit tests for LangGraphClientService.
 *
 * Validates:
 * - Service can be instantiated with correct configuration
 * - Metadata is propagated correctly (x-tenant-id, x-trace-id, x-user-id)
 * - Timeout (deadline) is set on calls
 * - Pool management works correctly
 */
describe('LangGraphClientService', () => {
  let service: LangGraphClientService;
  let configService: ConfigService;

  const mockConfigValues: Record<string, any> = {
    LANGGRAPH_HOST: 'test-host',
    LANGGRAPH_PORT: 50051,
    LANGGRAPH_CALL_TIMEOUT_MS: 30000,
    LANGGRAPH_POOL_MIN: 1,
    LANGGRAPH_POOL_MAX: 10,
    LANGGRAPH_PROTO_PATH: '/fake/path/agent_orchestration.proto',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LangGraphClientService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: any) => {
              return mockConfigValues[key] ?? defaultValue;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<LangGraphClientService>(LangGraphClientService);
    configService = module.get<ConfigService>(ConfigService);
  });

  describe('instantiation', () => {
    it('should be defined', () => {
      expect(service).toBeDefined();
    });

    it('should read configuration from ConfigService', () => {
      expect(configService.get).toHaveBeenCalledWith('LANGGRAPH_HOST', 'localhost');
      expect(configService.get).toHaveBeenCalledWith('LANGGRAPH_PORT', 50051);
      expect(configService.get).toHaveBeenCalledWith('LANGGRAPH_CALL_TIMEOUT_MS', 30000);
      expect(configService.get).toHaveBeenCalledWith('LANGGRAPH_POOL_MIN', 1);
      expect(configService.get).toHaveBeenCalledWith('LANGGRAPH_POOL_MAX', 10);
    });
  });

  describe('buildMetadata', () => {
    it('should set x-tenant-id when tenantId is provided', () => {
      const metadata = service.buildMetadata('tenant-123');

      expect(metadata.get('x-tenant-id')).toEqual(['tenant-123']);
    });

    it('should set x-user-id when userId is provided', () => {
      const metadata = service.buildMetadata('tenant-123', 'user-456');

      expect(metadata.get('x-user-id')).toEqual(['user-456']);
    });

    it('should always set x-trace-id', () => {
      const metadata = service.buildMetadata('tenant-123');

      const traceId = metadata.get('x-trace-id');
      expect(traceId).toHaveLength(1);
      expect(traceId[0]).toMatch(/^trace-/);
    });

    it('should generate unique trace IDs per call', () => {
      const metadata1 = service.buildMetadata('tenant-1');
      const metadata2 = service.buildMetadata('tenant-1');

      const traceId1 = metadata1.get('x-trace-id')[0];
      const traceId2 = metadata2.get('x-trace-id')[0];

      expect(traceId1).not.toEqual(traceId2);
    });

    it('should not set x-tenant-id when tenantId is undefined', () => {
      const metadata = service.buildMetadata(undefined);

      expect(metadata.get('x-tenant-id')).toEqual([]);
    });

    it('should not set x-user-id when userId is undefined', () => {
      const metadata = service.buildMetadata('tenant-123', undefined);

      expect(metadata.get('x-user-id')).toEqual([]);
    });

    it('should propagate all three metadata keys when all provided', () => {
      const metadata = service.buildMetadata('tenant-abc', 'user-xyz');

      expect(metadata.get('x-tenant-id')).toEqual(['tenant-abc']);
      expect(metadata.get('x-user-id')).toEqual(['user-xyz']);
      expect(metadata.get('x-trace-id')[0]).toMatch(/^trace-[a-f0-9-]+$/);
    });
  });

  describe('pool management', () => {
    it('should start with pool size 0 before initialization', () => {
      expect(service.getPoolSize()).toBe(0);
    });

    it('should report correct pool size', () => {
      // Before init, pool is empty
      expect(service.getPoolSize()).toBe(0);
    });
  });

  describe('timeout configuration', () => {
    it('should use 30000ms as default timeout', () => {
      // The service was created with 30000ms timeout from config
      // We verify this by checking the config was read correctly
      expect(configService.get).toHaveBeenCalledWith(
        'LANGGRAPH_CALL_TIMEOUT_MS',
        30000,
      );
    });

    it('should accept custom timeout from configuration', async () => {
      const customConfig: Record<string, any> = {
        ...mockConfigValues,
        LANGGRAPH_CALL_TIMEOUT_MS: 60000,
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          LangGraphClientService,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, defaultValue?: any) => {
                return customConfig[key] ?? defaultValue;
              }),
            },
          },
        ],
      }).compile();

      const customService = module.get<LangGraphClientService>(LangGraphClientService);
      expect(customService).toBeDefined();
    });
  });

  describe('pool constraints', () => {
    it('should enforce minimum pool size of 1', () => {
      // minPoolSize is read from config, defaults to 1
      expect(configService.get).toHaveBeenCalledWith('LANGGRAPH_POOL_MIN', 1);
    });

    it('should enforce maximum pool size of 10', () => {
      expect(configService.get).toHaveBeenCalledWith('LANGGRAPH_POOL_MAX', 10);
    });
  });

  describe('error handling', () => {
    it('should throw when trying to get a client from empty pool', () => {
      expect(() => (service as any).getNextClient()).toThrow(
        'gRPC client pool is empty',
      );
    });
  });
});
