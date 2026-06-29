import * as fc from 'fast-check';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';

import { AgentConfigService } from '../services/agent-config.service';
import { AgentConfig } from '../entities/agent-config.entity';
import { ConfigChange } from '../entities/config-change.entity';
import { UpdateAgentConfigDto } from '../dto/update-agent-config.dto';

/**
 * Property 6: Validação de Parâmetros de Agente
 *
 * For any agent configuration with temperature, max_tokens and model,
 * validation MUST accept if temperature is in [0.0, 2.0] AND max_tokens
 * is within the model's limit. Configurations outside these bounds MUST
 * be rejected.
 *
 * **Validates: Requirements 5.4, 5.5**
 */

describe('Property 6: Validação de Parâmetros de Agente', () => {
  const mockAgentId = '33333333-3333-3333-3333-333333333333';
  const mockTenantId = '11111111-1111-1111-1111-111111111111';
  const mockUserId = '22222222-2222-2222-2222-222222222222';
  const mockModelId = '44444444-4444-4444-4444-444444444444';
  const MODEL_MAX_OUTPUT_TOKENS = 8192;

  const createMockAgent = (): AgentConfig => ({
    id: mockAgentId,
    tenantId: mockTenantId,
    agentType: 'content',
    status: 'inactive',
    modelId: mockModelId,
    temperature: 0.7,
    maxTokens: 2048,
    systemPromptId: null,
    knowledgeCategories: [],
    fallbackModelId: null,
    lastExecutedAt: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  });

  function createService(modelMaxTokens: number = MODEL_MAX_OUTPUT_TOKENS) {
    const mockManager = {
      query: jest.fn().mockImplementation(async () => [{ max_output_tokens: modelMaxTokens }]),
    };

    const agentConfigRepo = {
      find: jest.fn(),
      findOne: jest.fn().mockImplementation(async () => createMockAgent()),
      create: jest.fn(),
      save: jest.fn().mockImplementation(async (a: any) => ({ ...a })),
      manager: mockManager,
    };

    const configChangeRepo = {
      find: jest.fn(),
      create: jest.fn().mockImplementation((data: any) => data),
      save: jest.fn().mockImplementation(async (records: any) => records),
    };

    // Directly instantiate the service with mocked repositories
    const service = new AgentConfigService(
      agentConfigRepo as any,
      configChangeRepo as any,
    );

    return { service, agentConfigRepo, configChangeRepo, mockManager };
  }

  describe('Temperature validation', () => {
    it('should accept any temperature in [0.0, 2.0]', async () => {
      const { service } = createService();

      await fc.assert(
        fc.asyncProperty(
          fc.double({ min: 0.0, max: 2.0, noNaN: true }),
          async (temperature) => {
            const dto: UpdateAgentConfigDto = { temperature };
            const result = await service.update(mockAgentId, dto, mockUserId);
            expect(result.temperature).toBe(temperature);
          },
        ),
        { numRuns: 150 },
      );
    });

    it('should reject any temperature below 0.0', async () => {
      const { service } = createService();

      await fc.assert(
        fc.asyncProperty(
          fc.double({ min: -1000, max: -Number.MIN_VALUE, noNaN: true }),
          async (temperature) => {
            const dto: UpdateAgentConfigDto = { temperature };
            await expect(
              service.update(mockAgentId, dto, mockUserId),
            ).rejects.toThrow(BadRequestException);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should reject any temperature above 2.0', async () => {
      const { service } = createService();

      await fc.assert(
        fc.asyncProperty(
          fc.double({ min: 2.0 + Number.EPSILON, max: 1000, noNaN: true }).filter(t => t > 2.0),
          async (temperature) => {
            const dto: UpdateAgentConfigDto = { temperature };
            await expect(
              service.update(mockAgentId, dto, mockUserId),
            ).rejects.toThrow(BadRequestException);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('maxTokens validation against model limit', () => {
    it('should accept any maxTokens within model limit [1, modelMax]', async () => {
      const { service } = createService();

      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: MODEL_MAX_OUTPUT_TOKENS }),
          async (maxTokens) => {
            const dto: UpdateAgentConfigDto = { maxTokens };
            const result = await service.update(mockAgentId, dto, mockUserId);
            expect(result.maxTokens).toBe(maxTokens);
          },
        ),
        { numRuns: 150 },
      );
    });

    it('should reject any maxTokens above model limit', async () => {
      const { service } = createService();

      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: MODEL_MAX_OUTPUT_TOKENS + 1, max: MODEL_MAX_OUTPUT_TOKENS * 10 }),
          async (maxTokens) => {
            const dto: UpdateAgentConfigDto = { maxTokens };
            await expect(
              service.update(mockAgentId, dto, mockUserId),
            ).rejects.toThrow(BadRequestException);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should reject maxTokens less than 1', async () => {
      const { service } = createService();

      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: -1000, max: 0 }),
          async (maxTokens) => {
            const dto: UpdateAgentConfigDto = { maxTokens };
            await expect(
              service.update(mockAgentId, dto, mockUserId),
            ).rejects.toThrow(BadRequestException);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should accept/reject based on arbitrary model limits', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 100, max: 200000 }), // random model limit
          fc.integer({ min: 1, max: 200000 }), // random maxTokens
          async (modelMax, maxTokens) => {
            const { service } = createService(modelMax);

            const dto: UpdateAgentConfigDto = { maxTokens };

            if (maxTokens <= modelMax) {
              const result = await service.update(mockAgentId, dto, mockUserId);
              expect(result.maxTokens).toBe(maxTokens);
            } else {
              await expect(
                service.update(mockAgentId, dto, mockUserId),
              ).rejects.toThrow(BadRequestException);
            }
          },
        ),
        { numRuns: 150 },
      );
    });
  });

  describe('Combined temperature + maxTokens validation', () => {
    it('should accept when both temperature in [0.0, 2.0] and maxTokens within limit', async () => {
      const { service } = createService();

      await fc.assert(
        fc.asyncProperty(
          fc.double({ min: 0.0, max: 2.0, noNaN: true }),
          fc.integer({ min: 1, max: MODEL_MAX_OUTPUT_TOKENS }),
          async (temperature, maxTokens) => {
            const dto: UpdateAgentConfigDto = { temperature, maxTokens };
            const result = await service.update(mockAgentId, dto, mockUserId);
            expect(result.temperature).toBe(temperature);
            expect(result.maxTokens).toBe(maxTokens);
          },
        ),
        { numRuns: 150 },
      );
    });

    it('should reject when temperature is invalid regardless of valid maxTokens', async () => {
      const { service } = createService();

      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            fc.double({ min: -100, max: -Number.MIN_VALUE, noNaN: true }),
            fc.double({ min: 2.0 + Number.EPSILON, max: 100, noNaN: true }).filter(t => t > 2.0),
          ),
          fc.integer({ min: 1, max: MODEL_MAX_OUTPUT_TOKENS }),
          async (temperature, maxTokens) => {
            const dto: UpdateAgentConfigDto = { temperature, maxTokens };
            await expect(
              service.update(mockAgentId, dto, mockUserId),
            ).rejects.toThrow(BadRequestException);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should reject when maxTokens exceeds limit regardless of valid temperature', async () => {
      const { service } = createService();

      await fc.assert(
        fc.asyncProperty(
          fc.double({ min: 0.0, max: 2.0, noNaN: true }),
          fc.integer({ min: MODEL_MAX_OUTPUT_TOKENS + 1, max: MODEL_MAX_OUTPUT_TOKENS * 10 }),
          async (temperature, maxTokens) => {
            const dto: UpdateAgentConfigDto = { temperature, maxTokens };
            await expect(
              service.update(mockAgentId, dto, mockUserId),
            ).rejects.toThrow(BadRequestException);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
