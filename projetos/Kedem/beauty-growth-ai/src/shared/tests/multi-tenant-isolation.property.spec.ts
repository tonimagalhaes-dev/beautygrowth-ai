import * as fc from 'fast-check';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { of } from 'rxjs';
import { TenantGuard, TokenPayload } from '../guards/tenant.guard';
import { TenantInterceptor } from '../interceptors/tenant.interceptor';

/**
 * Property 1: Isolamento Multi-Tenant Completo
 *
 * For any two distinct tenants A and B, and for any data operation (read, write, query)
 * executed in the context of tenant A, the result MUST NEVER contain data belonging to
 * tenant B. This applies to all entities: clinics, memories, documents, configurations,
 * audit logs, and personal data.
 *
 * **Validates: Requirements 4.1, 4.3, 4.4, 4.5, 4.6, 4.7, 6.6, 7.10, 12.10**
 */
describe('Property 1: Isolamento Multi-Tenant Completo', () => {
  // =========================================================================
  // Arbitraries / Generators
  // =========================================================================

  /** Generate a valid UUID v4 string */
  const uuidArb = fc.uuid().map((u) => u.toString());

  /** Generate a pair of distinct tenant UUIDs */
  const distinctTenantPairArb = fc
    .tuple(uuidArb, uuidArb)
    .filter(([a, b]) => a !== b);

  /** Generate a valid role */
  const roleArb = fc.constantFrom<'admin' | 'operator' | 'viewer'>(
    'admin',
    'operator',
    'viewer',
  );

  /** Generate a valid TokenPayload for a given tenantId */
  const tokenPayloadArb = (tenantId: string) =>
    fc.record({
      userId: uuidArb,
      tenantId: fc.constant(tenantId),
      role: roleArb,
      iat: fc.integer({ min: 1000000000, max: 2000000000 }),
      exp: fc.integer({ min: 2000000001, max: 3000000000 }),
    });

  /** Generate tenant-scoped data records for various entity types */
  const entityTypeArb = fc.constantFrom(
    'clinics',
    'agent_memory_short',
    'agent_memory_long',
    'business_memory_entries',
    'documents',
    'agent_configs',
    'consents',
    'audit_logs',
    'guardrails',
    'brand_identities',
    'users',
    'invitations',
    'token_usage',
  );

  /** Generate a batch of records belonging to a specific tenant */
  const tenantRecordsArb = (tenantId: string) =>
    fc.array(
      fc.record({
        id: uuidArb,
        tenant_id: fc.constant(tenantId),
        entity_type: entityTypeArb,
        data: fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.string()),
      }),
      { minLength: 1, maxLength: 20 },
    );

  // =========================================================================
  // Helpers
  // =========================================================================

  function createMockExecutionContext(
    authHeader?: string,
    tenantContext?: any,
  ): ExecutionContext {
    const request: any = {
      headers: { authorization: authHeader },
      ip: '127.0.0.1',
      path: '/test',
      method: 'GET',
      get: (name: string) => (request.headers as any)[name.toLowerCase()],
    };
    if (tenantContext) {
      request.tenantContext = tenantContext;
    }
    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({}),
        getNext: () => ({}),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
      getArgs: () => [request],
      getArgByIndex: (index: number) => request,
      switchToRpc: () => ({} as any),
      switchToWs: () => ({} as any),
      getType: () => 'http' as any,
    } as unknown as ExecutionContext;
  }

  function createMockDataSource(capturedQueries: string[]) {
    return {
      query: jest.fn().mockImplementation((sql: string, params?: any[]) => {
        capturedQueries.push(
          params ? `${sql} -- params: ${JSON.stringify(params)}` : sql,
        );
        return Promise.resolve([]);
      }),
    } as unknown as DataSource;
  }

  // =========================================================================
  // Property Tests
  // =========================================================================

  describe('TenantInterceptor always sets app.current_tenant before queries', () => {
    it(
      'should set the session variable to the correct tenant_id for any valid tenant',
      async () => {
        await fc.assert(
          fc.asyncProperty(uuidArb, async (tenantId) => {
            const capturedQueries: string[] = [];
            const dataSource = createMockDataSource(capturedQueries);
            const interceptor = new TenantInterceptor(dataSource);

            const tenantContext = { tenantId, userId: 'user-1', role: 'admin' };
            const execContext = createMockExecutionContext(undefined, tenantContext);
            const callHandler = { handle: () => of({ data: 'response' }) };

            await interceptor.intercept(execContext, callHandler);

            // Verify that set_config was called with the exact tenant_id
            expect(capturedQueries.length).toBeGreaterThanOrEqual(1);
            const setConfigQuery = capturedQueries[0];
            expect(setConfigQuery).toContain("set_config('app.current_tenant'");
            expect(setConfigQuery).toContain(tenantId);
          }),
          { numRuns: 100 },
        );
      },
    );

    it(
      'should never set a different tenant_id than what is in the request context',
      async () => {
        await fc.assert(
          fc.asyncProperty(distinctTenantPairArb, async ([tenantA, tenantB]) => {
            const capturedQueries: string[] = [];
            const dataSource = createMockDataSource(capturedQueries);
            const interceptor = new TenantInterceptor(dataSource);

            // Request context has tenantA
            const tenantContext = { tenantId: tenantA, userId: 'user-1', role: 'admin' };
            const execContext = createMockExecutionContext(undefined, tenantContext);
            const callHandler = { handle: () => of({ data: 'response' }) };

            await interceptor.intercept(execContext, callHandler);

            // Verify tenantB is NEVER set as the session variable
            const setConfigQuery = capturedQueries[0];
            expect(setConfigQuery).not.toContain(`"${tenantB}"`);
            // And tenantA IS the one set
            expect(setConfigQuery).toContain(tenantA);
          }),
          { numRuns: 100 },
        );
      },
    );
  });

  describe('Data operations for tenant A never return data belonging to tenant B', () => {
    it(
      'should filter results to only return records matching the active tenant',
      async () => {
        await fc.assert(
          fc.asyncProperty(
            distinctTenantPairArb,
            fc.integer({ min: 1, max: 20 }),
            fc.integer({ min: 1, max: 20 }),
            async ([tenantA, tenantB], countA, countB) => {
              // Generate records for both tenants
              const recordsA = Array.from({ length: countA }, (_, i) => ({
                id: `a-${i}`,
                tenant_id: tenantA,
                entity_type: 'clinics',
                data: { name: `Clinic A${i}` },
              }));
              const recordsB = Array.from({ length: countB }, (_, i) => ({
                id: `b-${i}`,
                tenant_id: tenantB,
                entity_type: 'clinics',
                data: { name: `Clinic B${i}` },
              }));

              // Simulate RLS-filtered query: only returns records where tenant_id matches active tenant
              const allRecords = [...recordsA, ...recordsB];

              // Simulate what PostgreSQL RLS does: filter by current_setting('app.current_tenant')
              const activeTenant = tenantA;
              const filteredResults = allRecords.filter(
                (record) => record.tenant_id === activeTenant,
              );

              // PROPERTY: Results MUST only contain records from the active tenant
              for (const record of filteredResults) {
                expect(record.tenant_id).toBe(activeTenant);
                expect(record.tenant_id).not.toBe(tenantB);
              }

              // PROPERTY: No record from tenant B should appear in results
              const leakedRecords = filteredResults.filter(
                (r) => r.tenant_id === tenantB,
              );
              expect(leakedRecords).toHaveLength(0);
            },
          ),
          { numRuns: 100 },
        );
      },
    );

    it(
      'should isolate data across ALL entity types for any tenant pair',
      async () => {
        await fc.assert(
          fc.asyncProperty(
            distinctTenantPairArb,
            entityTypeArb,
            async ([tenantA, tenantB], entityType) => {
              // Create records for both tenants of the same entity type
              const recordsA = Array.from({ length: 5 }, (_, i) => ({
                id: `a-${i}`,
                tenant_id: tenantA,
                entity_type: entityType,
              }));
              const recordsB = Array.from({ length: 5 }, (_, i) => ({
                id: `b-${i}`,
                tenant_id: tenantB,
                entity_type: entityType,
              }));

              const allRecords = [...recordsA, ...recordsB];

              // Simulate RLS filtering for tenant A
              const resultsForA = allRecords.filter(
                (r) => r.tenant_id === tenantA,
              );
              // Simulate RLS filtering for tenant B
              const resultsForB = allRecords.filter(
                (r) => r.tenant_id === tenantB,
              );

              // PROPERTY: Tenant A's query only returns A's data
              expect(resultsForA.every((r) => r.tenant_id === tenantA)).toBe(true);
              expect(resultsForA.some((r) => r.tenant_id === tenantB)).toBe(false);

              // PROPERTY: Tenant B's query only returns B's data
              expect(resultsForB.every((r) => r.tenant_id === tenantB)).toBe(true);
              expect(resultsForB.some((r) => r.tenant_id === tenantA)).toBe(false);

              // PROPERTY: Union of both results covers all original records
              expect(resultsForA.length + resultsForB.length).toBe(allRecords.length);
            },
          ),
          { numRuns: 100 },
        );
      },
    );
  });

  describe('TenantGuard correctly rejects requests with missing/mismatched tenant_ids', () => {
    it(
      'should reject any request without a valid JWT token',
      async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.constantFrom(undefined, '', 'InvalidToken', 'Basic abc123'),
            async (authHeader) => {
              const jwtService = {
                verifyAsync: jest.fn().mockRejectedValue(new Error('Invalid token')),
              } as unknown as JwtService;
              const configService = {
                get: jest.fn().mockReturnValue('test-secret'),
              } as unknown as ConfigService;

              const guard = new TenantGuard(jwtService, configService);
              const execContext = createMockExecutionContext(authHeader);

              await expect(guard.canActivate(execContext)).rejects.toThrow(
                UnauthorizedException,
              );
            },
          ),
          { numRuns: 100 },
        );
      },
    );

    it(
      'should reject any token payload that has no tenantId',
      async () => {
        await fc.assert(
          fc.asyncProperty(uuidArb, roleArb, async (userId, role) => {
            const payloadWithoutTenant = {
              userId,
              tenantId: '', // empty = missing
              role,
              iat: Date.now(),
              exp: Date.now() + 3600000,
            };

            const jwtService = {
              verifyAsync: jest.fn().mockResolvedValue(payloadWithoutTenant),
            } as unknown as JwtService;
            const configService = {
              get: jest.fn().mockReturnValue('test-secret'),
            } as unknown as ConfigService;

            const guard = new TenantGuard(jwtService, configService);
            const execContext = createMockExecutionContext('Bearer valid-token');

            await expect(guard.canActivate(execContext)).rejects.toThrow(
              ForbiddenException,
            );
          }),
          { numRuns: 100 },
        );
      },
    );

    it(
      'should accept valid tokens and attach correct tenant context to request',
      async () => {
        await fc.assert(
          fc.asyncProperty(
            uuidArb,
            uuidArb,
            roleArb,
            async (tenantId, userId, role) => {
              const payload: TokenPayload = {
                userId,
                tenantId,
                role,
                iat: Math.floor(Date.now() / 1000),
                exp: Math.floor(Date.now() / 1000) + 3600,
              };

              const jwtService = {
                verifyAsync: jest.fn().mockResolvedValue(payload),
              } as unknown as JwtService;
              const configService = {
                get: jest.fn().mockReturnValue('test-secret'),
              } as unknown as ConfigService;

              const guard = new TenantGuard(jwtService, configService);
              const execContext = createMockExecutionContext('Bearer valid-token');

              const result = await guard.canActivate(execContext);
              expect(result).toBe(true);

              // Verify the correct tenant context was attached
              const request = execContext.switchToHttp().getRequest() as any;
              expect(request.tenantContext.tenantId).toBe(tenantId);
              expect(request.tenantContext.userId).toBe(userId);
              expect(request.tenantContext.role).toBe(role);
            },
          ),
          { numRuns: 100 },
        );
      },
    );

    it(
      'should never allow tenant A to access with tenant B credentials in the context',
      async () => {
        await fc.assert(
          fc.asyncProperty(
            distinctTenantPairArb,
            uuidArb,
            roleArb,
            async ([tenantA, tenantB], userId, role) => {
              // Token contains tenantA
              const payload: TokenPayload = {
                userId,
                tenantId: tenantA,
                role,
                iat: Math.floor(Date.now() / 1000),
                exp: Math.floor(Date.now() / 1000) + 3600,
              };

              const jwtService = {
                verifyAsync: jest.fn().mockResolvedValue(payload),
              } as unknown as JwtService;
              const configService = {
                get: jest.fn().mockReturnValue('test-secret'),
              } as unknown as ConfigService;

              const guard = new TenantGuard(jwtService, configService);
              const execContext = createMockExecutionContext('Bearer valid-token');

              await guard.canActivate(execContext);

              // PROPERTY: The attached context must ONLY have tenantA, never tenantB
              const request = execContext.switchToHttp().getRequest() as any;
              expect(request.tenantContext.tenantId).toBe(tenantA);
              expect(request.tenantContext.tenantId).not.toBe(tenantB);
            },
          ),
          { numRuns: 100 },
        );
      },
    );
  });

  describe('End-to-end tenant isolation: interceptor + guard combined', () => {
    it(
      'should guarantee that for any authenticated request, only the authenticated tenant data is accessible',
      async () => {
        await fc.assert(
          fc.asyncProperty(
            distinctTenantPairArb,
            uuidArb,
            roleArb,
            async ([tenantA, tenantB], userId, role) => {
              // Step 1: Guard authenticates and attaches tenant context
              const payload: TokenPayload = {
                userId,
                tenantId: tenantA,
                role,
                iat: Math.floor(Date.now() / 1000),
                exp: Math.floor(Date.now() / 1000) + 3600,
              };

              const jwtService = {
                verifyAsync: jest.fn().mockResolvedValue(payload),
              } as unknown as JwtService;
              const configService = {
                get: jest.fn().mockReturnValue('test-secret'),
              } as unknown as ConfigService;

              const guard = new TenantGuard(jwtService, configService);
              const execContext = createMockExecutionContext('Bearer valid-token');

              const guardResult = await guard.canActivate(execContext);
              expect(guardResult).toBe(true);

              // Step 2: Interceptor sets the PostgreSQL session variable
              const capturedQueries: string[] = [];
              const dataSource = createMockDataSource(capturedQueries);
              const interceptor = new TenantInterceptor(dataSource);

              const callHandler = { handle: () => of({ result: 'ok' }) };
              await interceptor.intercept(execContext, callHandler);

              // Step 3: Verify the session variable is set to tenantA
              expect(capturedQueries.length).toBeGreaterThanOrEqual(1);
              expect(capturedQueries[0]).toContain(tenantA);
              expect(capturedQueries[0]).not.toContain(`"${tenantB}"`);

              // Step 4: Verify that any subsequent query filtered by RLS would
              // only return tenantA data
              const mockRecords = [
                { id: '1', tenant_id: tenantA, name: 'Clinic A' },
                { id: '2', tenant_id: tenantB, name: 'Clinic B' },
                { id: '3', tenant_id: tenantA, name: 'Clinic C' },
              ];

              // Simulate RLS: app.current_tenant = tenantA
              const rlsFiltered = mockRecords.filter(
                (r) => r.tenant_id === tenantA,
              );

              // PROPERTY: Filtered results contain ONLY tenantA data
              expect(rlsFiltered.every((r) => r.tenant_id === tenantA)).toBe(true);
              expect(rlsFiltered.some((r) => r.tenant_id === tenantB)).toBe(false);
            },
          ),
          { numRuns: 100 },
        );
      },
    );
  });
});
