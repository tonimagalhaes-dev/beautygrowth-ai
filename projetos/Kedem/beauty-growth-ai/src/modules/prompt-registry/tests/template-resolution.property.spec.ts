import * as fc from 'fast-check';

import { PromptRegistryService } from '../services/prompt-registry.service';
import { PromptVersion } from '../entities/prompt-version.entity';

/**
 * Property 18: Resolução de Variáveis de Template em Prompts
 *
 * For any prompt containing template variables (e.g., {{nome_clinica}}) and
 * for any tenant context that contains values for those variables, the resolution
 * MUST substitute all variables with the correct tenant values. Variables without
 * a value in the context MUST be reported as unresolved.
 *
 * **Validates: Requirements 10.5, 10.7**
 */
describe('Property 18: Template Variable Resolution', () => {
  let service: PromptRegistryService;

  beforeEach(() => {
    // We test resolveTemplate and extractVariables directly since they are
    // pure functions that don't require database access.
    service = new PromptRegistryService(
      {} as any, // promptRepository not needed for template resolution
      {} as any, // versionRepository not needed for template resolution
      {} as any, // cache not needed for template resolution
      {} as any, // keyBuilder not needed for template resolution
    );
  });

  // =========================================================================
  // ARBITRARIES (generators)
  // =========================================================================

  /**
   * Generate valid variable names: alphanumeric + underscore, starting with a letter.
   */
  const variableNameArb = fc
    .tuple(
      fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), {
        minLength: 1,
        maxLength: 1,
      }),
      fc.stringOf(
        fc.constantFrom(
          ...'abcdefghijklmnopqrstuvwxyz0123456789_'.split(''),
        ),
        { minLength: 0, maxLength: 15 },
      ),
    )
    .map(([first, rest]) => first + rest);

  /**
   * Generate a variable value (no double braces to avoid interference).
   */
  const variableValueArb = fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,!?-_@#$%&*()'.split(
          '',
        ),
      ),
      { minLength: 1, maxLength: 50 },
    )
    .filter((s) => !s.includes('{{') && !s.includes('}}'));

  /**
   * Generate plain text content (no template syntax).
   */
  const plainTextArb = fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,!?-:;\n'.split(
          '',
        ),
      ),
      { minLength: 0, maxLength: 30 },
    )
    .filter((s) => !s.includes('{{') && !s.includes('}}'));

  /**
   * Generate a prompt template with known variables embedded.
   * Returns { template, variables } where template contains {{var}} placeholders.
   */
  const templateWithVariablesArb = fc
    .tuple(
      fc.uniqueArray(variableNameArb, { minLength: 1, maxLength: 8 }),
      plainTextArb,
    )
    .map(([variables, prefix]) => {
      const segments = variables.map(
        (v, i) => `${i > 0 ? ' ' : ''}text_${i} {{${v}}}`,
      );
      const template = prefix + segments.join(' ') + ' end.';
      return { template, variables };
    });

  /**
   * Generate a tenant context that covers some (or all) variables.
   * Returns { context, matchedVars, unmatchedVars }.
   */
  const contextForVariablesArb = (variables: string[]) =>
    fc
      .tuple(
        fc.subarray(variables, { minLength: 0, maxLength: variables.length }),
        fc.array(variableValueArb, {
          minLength: variables.length,
          maxLength: variables.length,
        }),
      )
      .map(([matchedVars, values]) => {
        const context: Record<string, string> = {};
        for (let i = 0; i < matchedVars.length; i++) {
          context[matchedVars[i]] = values[i];
        }
        const unmatchedVars = variables.filter((v) => !matchedVars.includes(v));
        return { context, matchedVars, unmatchedVars };
      });

  // =========================================================================
  // PROPERTY TESTS
  // =========================================================================

  it('all matched variables are correctly substituted in the output', async () => {
    await fc.assert(
      fc.asyncProperty(
        templateWithVariablesArb.chain(({ template, variables }) =>
          contextForVariablesArb(variables).map((ctx) => ({
            template,
            variables,
            ...ctx,
          })),
        ),
        async ({ template, variables, context, matchedVars }) => {
          const version = createMockVersion(template, variables);
          const result = service.resolveTemplate(version, context);

          // Every matched variable should be substituted with the context value
          for (const varName of matchedVars) {
            const expectedValue = context[varName];
            expect(result.content).toContain(expectedValue);
            // The placeholder should NOT remain in the output
            expect(result.content).not.toContain(`{{${varName}}}`);
            // Should be in resolvedVariables
            expect(result.resolvedVariables[varName]).toBe(expectedValue);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('unresolved variables (no matching context value) are reported', async () => {
    await fc.assert(
      fc.asyncProperty(
        templateWithVariablesArb.chain(({ template, variables }) =>
          contextForVariablesArb(variables).map((ctx) => ({
            template,
            variables,
            ...ctx,
          })),
        ),
        async ({ template, variables, context, unmatchedVars }) => {
          const version = createMockVersion(template, variables);
          const result = service.resolveTemplate(version, context);

          // Every unmatched variable should appear in unresolvedVariables
          expect(result.unresolvedVariables.sort()).toEqual(
            unmatchedVars.sort(),
          );

          // Unresolved placeholders remain in the content
          for (const varName of unmatchedVars) {
            expect(result.content).toContain(`{{${varName}}}`);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('resolvedVariables + unresolvedVariables covers all template variables', async () => {
    await fc.assert(
      fc.asyncProperty(
        templateWithVariablesArb.chain(({ template, variables }) =>
          contextForVariablesArb(variables).map((ctx) => ({
            template,
            variables,
            ...ctx,
          })),
        ),
        async ({ template, variables, context }) => {
          const version = createMockVersion(template, variables);
          const result = service.resolveTemplate(version, context);

          const allReported = [
            ...Object.keys(result.resolvedVariables),
            ...result.unresolvedVariables,
          ].sort();

          expect(allReported).toEqual([...variables].sort());
        },
      ),
      { numRuns: 100 },
    );
  });

  it('empty context means all variables are unresolved', async () => {
    await fc.assert(
      fc.asyncProperty(
        templateWithVariablesArb,
        async ({ template, variables }) => {
          const version = createMockVersion(template, variables);
          const result = service.resolveTemplate(version, {});

          expect(result.unresolvedVariables.sort()).toEqual(variables.sort());
          expect(Object.keys(result.resolvedVariables)).toHaveLength(0);

          // All placeholders remain intact
          for (const varName of variables) {
            expect(result.content).toContain(`{{${varName}}}`);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('full context means no unresolved variables', async () => {
    await fc.assert(
      fc.asyncProperty(
        templateWithVariablesArb,
        fc.array(variableValueArb, { minLength: 8, maxLength: 8 }),
        async ({ template, variables }, values) => {
          // Build a context with values for ALL variables
          const context: Record<string, string> = {};
          for (let i = 0; i < variables.length; i++) {
            context[variables[i]] = values[i % values.length];
          }

          const version = createMockVersion(template, variables);
          const result = service.resolveTemplate(version, context);

          expect(result.unresolvedVariables).toHaveLength(0);
          expect(Object.keys(result.resolvedVariables).sort()).toEqual(
            variables.sort(),
          );

          // No placeholders should remain
          for (const varName of variables) {
            expect(result.content).not.toContain(`{{${varName}}}`);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('extractVariables correctly identifies all {{variable}} patterns', async () => {
    await fc.assert(
      fc.asyncProperty(
        templateWithVariablesArb,
        async ({ template, variables }) => {
          const extracted = service.extractVariables(template);
          expect(extracted.sort()).toEqual([...new Set(variables)].sort());
        },
      ),
      { numRuns: 100 },
    );
  });

  // =========================================================================
  // HELPERS
  // =========================================================================

  function createMockVersion(
    content: string,
    variables: string[],
  ): PromptVersion {
    return {
      id: 'version-id',
      promptId: 'prompt-id',
      version: '1.0.0',
      content,
      variables,
      author: null,
      description: 'test version',
      isActive: true,
      createdAt: new Date(),
      prompt: {} as any,
    } as PromptVersion;
  }
});
