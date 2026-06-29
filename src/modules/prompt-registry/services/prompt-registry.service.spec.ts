import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { PromptRegistryService } from './prompt-registry.service';
import { Prompt } from '../entities/prompt.entity';
import { PromptVersion } from '../entities/prompt-version.entity';

describe('PromptRegistryService', () => {
  let service: PromptRegistryService;
  let promptRepo: Record<string, jest.Mock>;
  let versionRepo: Record<string, jest.Mock>;

  const mockPromptId = '11111111-1111-1111-1111-111111111111';
  const mockAuthorId = '22222222-2222-2222-2222-222222222222';

  const mockPrompt: Prompt = {
    id: mockPromptId,
    agentType: 'content',
    function: 'system',
    activeVersion: '1.0.0',
    createdAt: new Date('2024-01-01'),
    versions: [],
  };

  const mockVersion: PromptVersion = {
    id: '33333333-3333-3333-3333-333333333333',
    promptId: mockPromptId,
    version: '1.0.0',
    content: 'Hello {{clinic_name}}, your specialty is {{specialty}}.',
    variables: ['clinic_name', 'specialty'],
    author: mockAuthorId,
    description: 'Initial system prompt',
    isActive: true,
    createdAt: new Date('2024-01-01'),
    prompt: mockPrompt,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PromptRegistryService,
        {
          provide: getRepositoryToken(Prompt),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(PromptVersion),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            update: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<PromptRegistryService>(PromptRegistryService);
    promptRepo = module.get(getRepositoryToken(Prompt));
    versionRepo = module.get(getRepositoryToken(PromptVersion));
  });

  describe('create', () => {
    it('should create a prompt with initial version', async () => {
      const dto = {
        agentType: 'content' as const,
        function: 'system' as const,
        content: 'Welcome to {{clinic_name}}!',
        version: '1.0.0',
        description: 'Initial prompt',
      };

      promptRepo.create.mockReturnValue({ ...mockPrompt, activeVersion: '1.0.0' });
      promptRepo.save.mockResolvedValue({ ...mockPrompt, id: mockPromptId, activeVersion: '1.0.0' });
      versionRepo.create.mockReturnValue({ ...mockVersion });
      versionRepo.save.mockResolvedValue({ ...mockVersion });

      const result = await service.create(dto, mockAuthorId);

      expect(promptRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          agentType: 'content',
          function: 'system',
          activeVersion: '1.0.0',
        }),
      );
      expect(versionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          promptId: mockPromptId,
          version: '1.0.0',
          content: 'Welcome to {{clinic_name}}!',
          variables: ['clinic_name'],
          isActive: true,
        }),
      );
      expect(result.id).toBe(mockPromptId);
    });

    it('should detect multiple variables in content', async () => {
      const dto = {
        agentType: 'content' as const,
        function: 'task' as const,
        content: 'Clinic: {{clinic_name}}, Specialty: {{specialty}}, Tone: {{voice_tone}}',
        version: '1.0.0',
      };

      promptRepo.create.mockReturnValue(mockPrompt);
      promptRepo.save.mockResolvedValue({ ...mockPrompt, id: mockPromptId });
      versionRepo.create.mockReturnValue(mockVersion);
      versionRepo.save.mockResolvedValue(mockVersion);

      await service.create(dto, mockAuthorId);

      expect(versionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: expect.arrayContaining(['clinic_name', 'specialty', 'voice_tone']),
        }),
      );
    });

    it('should reject invalid semver format', async () => {
      const dto = {
        agentType: 'content' as const,
        function: 'system' as const,
        content: 'Hello!',
        version: 'v1.0',
      };

      await expect(service.create(dto, mockAuthorId)).rejects.toThrow(BadRequestException);
    });

    it('should reject version without patch number', async () => {
      const dto = {
        agentType: 'content' as const,
        function: 'system' as const,
        content: 'Hello!',
        version: '1.0',
      };

      await expect(service.create(dto, mockAuthorId)).rejects.toThrow(BadRequestException);
    });

    it('should accept content with no variables', async () => {
      const dto = {
        agentType: 'content' as const,
        function: 'formatting' as const,
        content: 'Use markdown formatting for all responses.',
        version: '1.0.0',
      };

      promptRepo.create.mockReturnValue(mockPrompt);
      promptRepo.save.mockResolvedValue({ ...mockPrompt, id: mockPromptId });
      versionRepo.create.mockReturnValue(mockVersion);
      versionRepo.save.mockResolvedValue(mockVersion);

      await service.create(dto, mockAuthorId);

      expect(versionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: [],
        }),
      );
    });
  });

  describe('update', () => {
    it('should create a new version and deactivate previous', async () => {
      const dto = {
        content: 'Updated {{clinic_name}} prompt!',
        version: '1.1.0',
        description: 'Added more detail',
      };

      promptRepo.findOne.mockResolvedValue({ ...mockPrompt });
      versionRepo.findOne.mockResolvedValue(null); // no existing version with this number
      versionRepo.update.mockResolvedValue({ affected: 1 });
      versionRepo.create.mockReturnValue({ ...mockVersion, version: '1.1.0' });
      versionRepo.save.mockResolvedValue({ ...mockVersion, version: '1.1.0' });
      promptRepo.save.mockResolvedValue({ ...mockPrompt, activeVersion: '1.1.0' });

      const result = await service.update(mockPromptId, dto, mockAuthorId);

      // Should deactivate current versions
      expect(versionRepo.update).toHaveBeenCalledWith(
        { promptId: mockPromptId, isActive: true },
        { isActive: false },
      );
      // Should create new version as active
      expect(versionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          version: '1.1.0',
          isActive: true,
        }),
      );
      expect(result.version).toBe('1.1.0');
    });

    it('should reject duplicate version numbers', async () => {
      const dto = {
        content: 'Same version content',
        version: '1.0.0',
      };

      promptRepo.findOne.mockResolvedValue({ ...mockPrompt });
      versionRepo.findOne.mockResolvedValue(mockVersion); // existing version found

      await expect(service.update(mockPromptId, dto, mockAuthorId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject version lower than current active', async () => {
      const dto = {
        content: 'Downgrade attempt',
        version: '0.9.0',
      };

      promptRepo.findOne.mockResolvedValue({ ...mockPrompt, activeVersion: '1.0.0' });
      versionRepo.findOne.mockResolvedValue(null);

      await expect(service.update(mockPromptId, dto, mockAuthorId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should accept patch version increment', async () => {
      const dto = {
        content: 'Patch update',
        version: '1.0.1',
      };

      promptRepo.findOne.mockResolvedValue({ ...mockPrompt, activeVersion: '1.0.0' });
      versionRepo.findOne.mockResolvedValue(null);
      versionRepo.update.mockResolvedValue({ affected: 1 });
      versionRepo.create.mockReturnValue({ ...mockVersion, version: '1.0.1' });
      versionRepo.save.mockResolvedValue({ ...mockVersion, version: '1.0.1' });
      promptRepo.save.mockResolvedValue({ ...mockPrompt, activeVersion: '1.0.1' });

      const result = await service.update(mockPromptId, dto, mockAuthorId);
      expect(result.version).toBe('1.0.1');
    });

    it('should throw NotFoundException for non-existent prompt', async () => {
      promptRepo.findOne.mockResolvedValue(null);

      await expect(
        service.update('nonexistent', { content: 'x', version: '2.0.0' }, mockAuthorId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getActive', () => {
    it('should return the active version content', async () => {
      promptRepo.findOne.mockResolvedValue(mockPrompt);
      versionRepo.findOne.mockResolvedValue(mockVersion);

      const result = await service.getActive(mockPromptId);

      expect(result.content).toBe(mockVersion.content);
      expect(result.version).toBe('1.0.0');
      expect(result.unresolvedVariables).toEqual(['clinic_name', 'specialty']);
    });

    it('should throw NotFoundException for non-existent prompt', async () => {
      promptRepo.findOne.mockResolvedValue(null);

      await expect(service.getActive('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when no active version exists', async () => {
      promptRepo.findOne.mockResolvedValue(mockPrompt);
      versionRepo.findOne.mockResolvedValue(null);

      await expect(service.getActive(mockPromptId)).rejects.toThrow(NotFoundException);
    });
  });

  describe('rollback', () => {
    it('should activate the target version and deactivate others', async () => {
      const oldVersion: PromptVersion = {
        ...mockVersion,
        id: '44444444-4444-4444-4444-444444444444',
        version: '1.0.0',
        isActive: false,
      };

      promptRepo.findOne.mockResolvedValue({ ...mockPrompt, activeVersion: '2.0.0' });
      versionRepo.findOne.mockResolvedValue(oldVersion);
      versionRepo.update.mockResolvedValue({ affected: 2 });
      versionRepo.save.mockResolvedValue({ ...oldVersion, isActive: true });
      promptRepo.save.mockResolvedValue({ ...mockPrompt, activeVersion: '1.0.0' });

      await service.rollback(mockPromptId, '1.0.0');

      // Should deactivate all versions
      expect(versionRepo.update).toHaveBeenCalledWith(
        { promptId: mockPromptId },
        { isActive: false },
      );
      // Should activate target
      expect(versionRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ isActive: true, version: '1.0.0' }),
      );
      // Should update prompt active version
      expect(promptRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ activeVersion: '1.0.0' }),
      );
    });

    it('should throw NotFoundException for non-existent version', async () => {
      promptRepo.findOne.mockResolvedValue(mockPrompt);
      versionRepo.findOne.mockResolvedValue(null);

      await expect(service.rollback(mockPromptId, '99.0.0')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw NotFoundException for non-existent prompt', async () => {
      promptRepo.findOne.mockResolvedValue(null);

      await expect(service.rollback('nonexistent', '1.0.0')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('resolve', () => {
    it('should substitute all variables from tenant context', async () => {
      promptRepo.findOne.mockResolvedValue(mockPrompt);
      versionRepo.findOne.mockResolvedValue(mockVersion);

      const tenantContext = {
        clinic_name: 'Estética Premium',
        specialty: 'Harmonização Facial',
      };

      const result = await service.resolve(mockPromptId, tenantContext);

      expect(result.content).toBe(
        'Hello Estética Premium, your specialty is Harmonização Facial.',
      );
      expect(result.resolvedVariables).toEqual(tenantContext);
      expect(result.unresolvedVariables).toEqual([]);
    });

    it('should report unresolved variables when context is incomplete', async () => {
      promptRepo.findOne.mockResolvedValue(mockPrompt);
      versionRepo.findOne.mockResolvedValue(mockVersion);

      const tenantContext = {
        clinic_name: 'Estética Premium',
        // specialty not provided
      };

      const result = await service.resolve(mockPromptId, tenantContext);

      expect(result.content).toBe(
        'Hello Estética Premium, your specialty is {{specialty}}.',
      );
      expect(result.resolvedVariables).toEqual({ clinic_name: 'Estética Premium' });
      expect(result.unresolvedVariables).toEqual(['specialty']);
    });

    it('should report all variables as unresolved when context is empty', async () => {
      promptRepo.findOne.mockResolvedValue(mockPrompt);
      versionRepo.findOne.mockResolvedValue(mockVersion);

      const result = await service.resolve(mockPromptId, {});

      expect(result.content).toBe(mockVersion.content);
      expect(result.unresolvedVariables).toEqual(['clinic_name', 'specialty']);
    });

    it('should handle content with no variables', async () => {
      const noVarVersion: PromptVersion = {
        ...mockVersion,
        content: 'Static prompt with no variables.',
        variables: [],
      };
      promptRepo.findOne.mockResolvedValue(mockPrompt);
      versionRepo.findOne.mockResolvedValue(noVarVersion);

      const result = await service.resolve(mockPromptId, { clinic_name: 'Test' });

      expect(result.content).toBe('Static prompt with no variables.');
      expect(result.resolvedVariables).toEqual({});
      expect(result.unresolvedVariables).toEqual([]);
    });

    it('should throw NotFoundException for non-existent prompt', async () => {
      promptRepo.findOne.mockResolvedValue(null);

      await expect(service.resolve('nonexistent', {})).rejects.toThrow(NotFoundException);
    });
  });

  describe('testInSandbox', () => {
    it('should resolve a specific version without affecting production', async () => {
      const v2: PromptVersion = {
        ...mockVersion,
        version: '2.0.0',
        content: 'New {{clinic_name}} prompt v2!',
        variables: ['clinic_name'],
        isActive: false,
      };

      promptRepo.findOne.mockResolvedValue(mockPrompt);
      versionRepo.findOne.mockResolvedValue(v2);

      const result = await service.testInSandbox(mockPromptId, '2.0.0', {
        clinic_name: 'Test Clinic',
      });

      expect(result.resolvedContent).toBe('New Test Clinic prompt v2!');
      expect(result.version).toBe('2.0.0');
      expect(result.isProduction).toBe(false);
      expect(result.resolvedVariables).toEqual({ clinic_name: 'Test Clinic' });
      expect(result.unresolvedVariables).toEqual([]);
    });

    it('should report unresolved variables in sandbox', async () => {
      promptRepo.findOne.mockResolvedValue(mockPrompt);
      versionRepo.findOne.mockResolvedValue(mockVersion);

      const result = await service.testInSandbox(mockPromptId, '1.0.0', {});

      expect(result.unresolvedVariables).toEqual(['clinic_name', 'specialty']);
      expect(result.isProduction).toBe(false);
    });

    it('should throw NotFoundException for non-existent version', async () => {
      promptRepo.findOne.mockResolvedValue(mockPrompt);
      versionRepo.findOne.mockResolvedValue(null);

      await expect(
        service.testInSandbox(mockPromptId, '99.0.0', {}),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('listVersions', () => {
    it('should return all versions ordered by creation date', async () => {
      const versions: PromptVersion[] = [
        { ...mockVersion, version: '1.1.0', createdAt: new Date('2024-02-01') },
        { ...mockVersion, version: '1.0.0', createdAt: new Date('2024-01-01') },
      ];

      promptRepo.findOne.mockResolvedValue(mockPrompt);
      versionRepo.find.mockResolvedValue(versions);

      const result = await service.listVersions(mockPromptId);

      expect(versionRepo.find).toHaveBeenCalledWith({
        where: { promptId: mockPromptId },
        order: { createdAt: 'DESC' },
      });
      expect(result).toHaveLength(2);
    });

    it('should throw NotFoundException for non-existent prompt', async () => {
      promptRepo.findOne.mockResolvedValue(null);

      await expect(service.listVersions('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('extractVariables', () => {
    it('should extract unique variable names from template content', () => {
      const content = '{{name}} is {{name}} and {{other}}';
      const vars = service.extractVariables(content);
      expect(vars).toEqual(['name', 'other']);
    });

    it('should return empty array for content without variables', () => {
      const vars = service.extractVariables('No variables here');
      expect(vars).toEqual([]);
    });

    it('should handle multiple variables in sequence', () => {
      const vars = service.extractVariables('{{a}}{{b}}{{c}}');
      expect(vars).toEqual(['a', 'b', 'c']);
    });

    it('should only match word characters inside braces', () => {
      const vars = service.extractVariables('{{valid_name}} but not {{invalid-name}} or {{ spaces }}');
      expect(vars).toEqual(['valid_name']);
    });
  });

  describe('resolveTemplate', () => {
    it('should replace all occurrences of a variable', () => {
      const version: PromptVersion = {
        ...mockVersion,
        content: '{{name}} loves {{name}}',
        variables: ['name'],
      };

      const result = service.resolveTemplate(version, { name: 'Alice' });

      expect(result.content).toBe('Alice loves Alice');
    });

    it('should leave unresolved variables in place', () => {
      const version: PromptVersion = {
        ...mockVersion,
        content: '{{known}} and {{unknown}}',
        variables: ['known', 'unknown'],
      };

      const result = service.resolveTemplate(version, { known: 'yes' });

      expect(result.content).toBe('yes and {{unknown}}');
      expect(result.unresolvedVariables).toEqual(['unknown']);
    });
  });
});
