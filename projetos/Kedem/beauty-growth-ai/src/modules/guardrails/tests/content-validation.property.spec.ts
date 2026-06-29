import * as fc from 'fast-check';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { GuardrailsService } from '../services/guardrails.service';
import { Guardrail } from '../entities/guardrail.entity';
import { GuardrailViolation } from '../entities/guardrail-violation.entity';
import { GuardrailVersion } from '../entities/guardrail-version.entity';
import { GuardrailRule } from '../interfaces/guardrails-service.interface';

/**
 * Property 20: Guardrails — Validação de Conteúdo
 *
 * For any generated content, if it contains patterns that violate active guardrails
 * (system or tenant), validation MUST return isValid=false with the corresponding
 * violations list. If the content does not violate any guardrail, validation MUST
 * return isValid=true with an empty violations list.
 *
 * **Validates: Requirements 11.3, 11.4**
 */
describe('Property 20: Guardrails — Validação de Conteúdo', () => {
  const mockTenantId = '11111111-1111-1111-1111-111111111111';

  // System guardrails definitions (matching the service's SYSTEM_GUARDRAILS_DEFINITIONS)
  const SYSTEM_GUARDRAILS: Guardrail[] = [
    {
      id: 'sg-001',
      tenantId: null,
      type: 'system',
      name: 'no-health-promises',
      description: 'Proíbe promessas de resultados de saúde ou estéticos garantidos',
      rule: {
        pattern:
          '\\b(garanti[a-z]*|certeza de resultado|100%|resultado garantido|prometo|assegur[a-z]*)\\b.*\\b(resultado|cur[a-z]*|emagrec[a-z]*|rejuvenesc[a-z]*)\\b',
        categories: ['health_promise'],
        action: 'regenerate',
        maxRetries: 3,
      },
      version: 1,
      isActive: true,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
    },
    {
      id: 'sg-002',
      tenantId: null,
      type: 'system',
      name: 'no-diagnoses',
      description: 'Proíbe diagnósticos médicos ou de saúde',
      rule: {
        pattern:
          '\\b(diagnóstic[a-z]*|diagnostica[a-z]*|você tem|você sofre de|sua condição é|patologia)\\b',
        categories: ['diagnosis'],
        action: 'block',
        maxRetries: 3,
      },
      version: 1,
      isActive: true,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
    },
    {
      id: 'sg-003',
      tenantId: null,
      type: 'system',
      name: 'no-prescriptions',
      description: 'Proíbe prescrições de medicamentos ou tratamentos médicos',
      rule: {
        pattern:
          '\\b(prescrev[a-z]*|receitar|tome|use.*mg|aplique.*vezes ao dia|medicament[a-z]*|remédio)\\b',
        categories: ['prescription'],
        action: 'block',
        maxRetries: 3,
      },
      version: 1,
      isActive: true,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
    },
    {
      id: 'sg-004',
      tenantId: null,
      type: 'system',
      name: 'no-anvisa-cfm-violations',
      description: 'Proíbe conteúdo que viole regulamentações ANVISA/CFM',
      rule: {
        pattern:
          '\\b(antes e depois|fotos comparativas de pacientes|resultado de outro paciente|propaganda enganosa)\\b',
        categories: ['regulatory_violation'],
        action: 'block',
        maxRetries: 3,
      },
      version: 1,
      isActive: true,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
    },
    {
      id: 'sg-005',
      tenantId: null,
      type: 'system',
      name: 'no-cross-tenant-data',
      description: 'Proíbe compartilhamento de dados entre tenants',
      rule: {
        pattern:
          '\\b(outra clínica|outro consultório|dados do paciente de|informações de outro)\\b',
        categories: ['cross_tenant_data'],
        action: 'block',
        maxRetries: 3,
      },
      version: 1,
      isActive: true,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
    },
  ];

  // Violating content fragments for each system guardrail
  const VIOLATING_FRAGMENTS: Record<string, string[]> = {
    'no-health-promises': [
      'garantimos resultado de emagrecimento',
      'certeza de resultado na cura',
      'resultado garantido de rejuvenescimento',
      'prometo resultado visível na cura',
      'asseguramos a cura completa',
    ],
    'no-diagnoses': [
      'baseado na análise, você tem uma condição',
      'o diagnóstico indica inflamação',
      'diagnosticamos uma alergia',
      'você sofre de rosácea',
      'identificamos uma patologia',
      'após exames, a patologia foi confirmada',
    ],
    'no-prescriptions': [
      'prescrevo este tratamento',
      'vou receitar um creme',
      'tome dois comprimidos',
      'use 500mg diariamente',
      'aplique duas vezes ao dia no local',
      'o medicamento indicado é',
      'o remédio correto é',
    ],
    'no-anvisa-cfm-violations': [
      'veja o antes e depois do procedimento',
      'fotos comparativas de pacientes mostram',
      'resultado de outro paciente comprova',
      'isso é propaganda enganosa',
    ],
    'no-cross-tenant-data': [
      'na outra clínica fazem diferente',
      'no outro consultório o preço é',
      'dados do paciente de outra unidade',
      'informações de outro cliente indicam',
    ],
  };

  // Clean content that does NOT match any system guardrail pattern
  const SAFE_CONTENT_FRAGMENTS = [
    'Nosso tratamento de limpeza de pele é realizado por profissionais qualificados',
    'Agende sua consulta para avaliação personalizada',
    'Oferecemos diversos procedimentos estéticos para o seu bem-estar',
    'Nossa equipe está pronta para atender você com excelência',
    'Conheça nossos serviços de harmonização facial',
    'Trabalhamos com as melhores tecnologias disponíveis no mercado',
    'O procedimento é seguro e minimamente invasivo',
    'Consulte nosso catálogo completo de serviços estéticos',
    'Acompanhamento pós-procedimento incluído em todos os pacotes',
    'Resultados podem variar de acordo com cada paciente individual',
  ];

  /**
   * Creates a fresh service instance with mocked repositories.
   * Each call returns an independent service to avoid cache interference between iterations.
   */
  function createService(
    systemGuardrails: Guardrail[],
    tenantGuardrails: Guardrail[] = [],
  ): GuardrailsService {
    const guardrailRepo = {
      find: jest.fn()
        .mockResolvedValueOnce(systemGuardrails)
        .mockResolvedValueOnce(tenantGuardrails),
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      remove: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    const violationRepo = {
      find: jest.fn(),
      create: jest.fn().mockImplementation((data: any) => data),
      save: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(),
    };

    const versionRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
    };

    const eventEmitter = { emit: jest.fn() };

    // Directly instantiate the service to avoid cache sharing
    const service = new GuardrailsService(
      guardrailRepo as any,
      violationRepo as any,
      versionRepo as any,
      eventEmitter as any,
    );

    return service;
  }

  // =========================================================================
  // Arbitraries (generators)
  // =========================================================================

  /** Arbitrary that picks a random system guardrail index and a violating fragment for it. */
  const systemViolationArb = fc
    .integer({ min: 0, max: SYSTEM_GUARDRAILS.length - 1 })
    .chain((idx) => {
      const guardrail = SYSTEM_GUARDRAILS[idx];
      const fragments = VIOLATING_FRAGMENTS[guardrail.name];
      return fc
        .integer({ min: 0, max: fragments.length - 1 })
        .map((fragIdx) => ({
          guardrail,
          violatingContent: fragments[fragIdx],
        }));
    });

  /** Arbitrary that generates safe content by picking from safe fragments. */
  const safeContentArb = fc
    .integer({ min: 0, max: SAFE_CONTENT_FRAGMENTS.length - 1 })
    .map((idx) => SAFE_CONTENT_FRAGMENTS[idx]);

  /** Arbitrary for tenant guardrail with paired name/keyword. */
  const tenantGuardrailArb = fc.constantFrom(
    { name: 'no-price-comparison', keyword: 'preço mais baixo', action: 'block' as const },
    { name: 'no-competitor-mention', keyword: 'concorrente', action: 'regenerate' as const },
    { name: 'no-discount-promise', keyword: 'desconto garantido', action: 'warn' as const },
    { name: 'brand-tone-enforcement', keyword: 'barato demais', action: 'block' as const },
  );

  // =========================================================================
  // Property Tests
  // =========================================================================

  describe('System guardrail violations', () => {
    it('content matching a system guardrail pattern → isValid=false with correct violations', async () => {
      await fc.assert(
        fc.asyncProperty(systemViolationArb, async ({ guardrail, violatingContent }) => {
          const service = createService([guardrail]);

          const result = await service.validate(violatingContent, mockTenantId);

          // Must be invalid
          expect(result.isValid).toBe(false);

          // Must have at least one violation
          expect(result.violations.length).toBeGreaterThanOrEqual(1);

          // The violation must reference the correct guardrail
          const violation = result.violations.find(
            (v) => v.guardrailId === guardrail.id,
          );
          expect(violation).toBeDefined();
          expect(violation!.guardrailId).toBe(guardrail.id);
          expect(violation!.guardrailName).toBe(guardrail.name);
          expect(violation!.matchedContent).toBeTruthy();

          // Severity should match the rule action
          const expectedSeverity =
            guardrail.rule.action === 'block'
              ? 'critical'
              : guardrail.rule.action === 'regenerate'
                ? 'high'
                : 'medium';
          expect(violation!.severity).toBe(expectedSeverity);
        }),
        { numRuns: 100 },
      );
    });

    it('content matching multiple system guardrails → isValid=false with all violations listed', async () => {
      const multiViolationArb = fc.constantFrom(
        {
          content: 'Você tem uma patologia e prescrevo este medicamento para cura',
          expectedGuardrailNames: ['no-diagnoses', 'no-prescriptions'],
        },
        {
          content: 'Na outra clínica o diagnóstico foi diferente',
          expectedGuardrailNames: ['no-cross-tenant-data', 'no-diagnoses'],
        },
        {
          content: 'Veja o antes e depois e tome este remédio',
          expectedGuardrailNames: ['no-anvisa-cfm-violations', 'no-prescriptions'],
        },
      );

      await fc.assert(
        fc.asyncProperty(multiViolationArb, async ({ content, expectedGuardrailNames }) => {
          const relevantGuardrails = SYSTEM_GUARDRAILS.filter((g) =>
            expectedGuardrailNames.includes(g.name),
          );
          const service = createService(relevantGuardrails);

          const result = await service.validate(content, mockTenantId);

          expect(result.isValid).toBe(false);
          expect(result.violations.length).toBeGreaterThanOrEqual(2);

          // All expected guardrails should be represented in violations
          for (const expectedName of expectedGuardrailNames) {
            const found = result.violations.some(
              (v) => v.guardrailName === expectedName,
            );
            expect(found).toBe(true);
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('Clean content (no violations)', () => {
    it('content not matching any guardrail pattern → isValid=true with empty violations', async () => {
      await fc.assert(
        fc.asyncProperty(safeContentArb, async (content) => {
          const service = createService(SYSTEM_GUARDRAILS);

          const result = await service.validate(content, mockTenantId);

          expect(result.isValid).toBe(true);
          expect(result.violations).toHaveLength(0);
          expect(result.checkedGuardrails).toBe(SYSTEM_GUARDRAILS.length);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('Tenant guardrail violations', () => {
    it('content matching tenant guardrail patterns → isValid=false', async () => {
      await fc.assert(
        fc.asyncProperty(tenantGuardrailArb, async ({ name, keyword, action }) => {
          const tenantGuardrail: Guardrail = {
            id: 'tg-001',
            tenantId: mockTenantId,
            type: 'tenant',
            name,
            description: `Custom tenant rule: ${name}`,
            rule: {
              pattern: `\\b${keyword.replace(/\s+/g, '\\s+')}\\b`,
              categories: ['custom'],
              action,
              maxRetries: 3,
            },
            version: 1,
            isActive: true,
            createdAt: new Date('2024-01-01'),
            updatedAt: new Date('2024-01-01'),
          };

          // Set up with no system guardrails, only the tenant one
          const service = createService([], [tenantGuardrail]);

          const violatingContent = `Nosso serviço oferece ${keyword} no mercado`;
          const result = await service.validate(violatingContent, mockTenantId);

          expect(result.isValid).toBe(false);
          expect(result.violations.length).toBeGreaterThanOrEqual(1);

          const violation = result.violations.find(
            (v) => v.guardrailId === tenantGuardrail.id,
          );
          expect(violation).toBeDefined();
          expect(violation!.guardrailName).toBe(name);

          const expectedSeverity =
            action === 'block' ? 'critical' : action === 'regenerate' ? 'high' : 'medium';
          expect(violation!.severity).toBe(expectedSeverity);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('Violation details correctness', () => {
    it('violations array contains correct guardrailId, guardrailName, severity, and matchedContent', async () => {
      await fc.assert(
        fc.asyncProperty(systemViolationArb, async ({ guardrail, violatingContent }) => {
          const service = createService([guardrail]);

          const result = await service.validate(violatingContent, mockTenantId);

          expect(result.isValid).toBe(false);

          for (const violation of result.violations) {
            // guardrailId must be a valid string matching one of the checked guardrails
            expect(typeof violation.guardrailId).toBe('string');
            expect(violation.guardrailId).toBe(guardrail.id);

            // guardrailName must be the guardrail's name
            expect(typeof violation.guardrailName).toBe('string');
            expect(violation.guardrailName).toBe(guardrail.name);

            // severity must be one of the valid values
            expect(['critical', 'high', 'medium']).toContain(violation.severity);

            // matchedContent must be a non-empty string that is part of the original content
            expect(typeof violation.matchedContent).toBe('string');
            expect(violation.matchedContent.length).toBeGreaterThan(0);
            expect(
              violatingContent.toLowerCase().includes(violation.matchedContent.toLowerCase()),
            ).toBe(true);
          }
        }),
        { numRuns: 100 },
      );
    });
  });
});
