import * as fc from 'fast-check';
import { PermissionsService, Role, Resource, Action } from '../../../shared/services/permissions.service';

/**
 * Property 5: Controle de Acesso por Perfil (RBAC)
 *
 * For any tuple (role, resource, action), the system MUST allow access if and only if
 * the action is in the role's permission list. Admin has full access; Operator can
 * generate content, view campaigns, and schedule; Viewer has read-only access.
 *
 * **Validates: Requirements 3.3, 3.9**
 */

// All valid roles, resources, and actions
const ALL_ROLES: Role[] = ['admin', 'operator', 'viewer'];
const ALL_RESOURCES: Resource[] = [
  'clinics',
  'brands',
  'agents',
  'content',
  'campaigns',
  'calendar',
  'members',
  'settings',
  'knowledge-hub',
  'guardrails',
  'observability',
  'privacy',
];
const ALL_ACTIONS: Action[] = ['create', 'read', 'update', 'delete', 'manage'];

// Expected permission matrix (ground truth)
const EXPECTED_PERMISSIONS: Record<Role, Record<string, Action[]>> = {
  admin: Object.fromEntries(
    ALL_RESOURCES.map((r) => [r, ['create', 'read', 'update', 'delete', 'manage']]),
  ),
  operator: {
    content: ['create', 'read', 'update'],
    campaigns: ['read', 'create'],
    calendar: ['read', 'create', 'update'],
  },
  viewer: Object.fromEntries(ALL_RESOURCES.map((r) => [r, ['read']])),
};

// Helper: check if (role, resource, action) should be allowed per expected matrix
function expectedAccess(role: Role, resource: Resource, action: Action): boolean {
  const rolePerms = EXPECTED_PERMISSIONS[role];
  if (!rolePerms) return false;
  const allowedActions = rolePerms[resource];
  if (!allowedActions) return false;
  return allowedActions.includes(action);
}

// fast-check arbitraries
const roleArb = fc.constantFrom<Role>(...ALL_ROLES);
const resourceArb = fc.constantFrom<Resource>(...ALL_RESOURCES);
const actionArb = fc.constantFrom<Action>(...ALL_ACTIONS);
const tupleArb = fc.tuple(roleArb, resourceArb, actionArb);

describe('Property 5: Controle de Acesso por Perfil (RBAC)', () => {
  let permissionsService: PermissionsService;

  beforeAll(() => {
    permissionsService = new PermissionsService();
  });

  describe('1. Admin ALWAYS has access to any (resource, action) combination', () => {
    it('should grant admin access to every resource and action', () => {
      fc.assert(
        fc.property(resourceArb, actionArb, (resource, action) => {
          expect(permissionsService.canAccess('admin', resource, action)).toBe(true);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('2. Viewer ONLY has access when action === read', () => {
    it('should grant viewer access only for read actions', () => {
      fc.assert(
        fc.property(resourceArb, actionArb, (resource, action) => {
          const result = permissionsService.canAccess('viewer', resource, action);
          if (action === 'read') {
            expect(result).toBe(true);
          } else {
            expect(result).toBe(false);
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('3. Operator access matches exactly the defined subset', () => {
    it('should grant operator access only for defined (resource, action) pairs', () => {
      fc.assert(
        fc.property(resourceArb, actionArb, (resource, action) => {
          const result = permissionsService.canAccess('operator', resource, action);
          const expected = expectedAccess('operator', resource, action);
          expect(result).toBe(expected);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('4. Access is denied for ALL tuples NOT in the permission matrix', () => {
    it('should deny access for tuples not in the permission matrix', () => {
      fc.assert(
        fc.property(tupleArb, ([role, resource, action]) => {
          const result = permissionsService.canAccess(role, resource, action);
          const expected = expectedAccess(role, resource, action);
          // If expected is false (not in matrix), result must be false
          if (!expected) {
            expect(result).toBe(false);
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('5. Permission check is deterministic (same inputs always produce same output)', () => {
    it('should return the same result for the same (role, resource, action) across multiple calls', () => {
      fc.assert(
        fc.property(tupleArb, ([role, resource, action]) => {
          const result1 = permissionsService.canAccess(role, resource, action);
          const result2 = permissionsService.canAccess(role, resource, action);
          const result3 = permissionsService.canAccess(role, resource, action);
          expect(result1).toBe(result2);
          expect(result2).toBe(result3);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('Biconditional: access is granted IFF tuple is in the permission matrix', () => {
    it('should match the expected permission matrix for all (role, resource, action) tuples', () => {
      fc.assert(
        fc.property(tupleArb, ([role, resource, action]) => {
          const result = permissionsService.canAccess(role, resource, action);
          const expected = expectedAccess(role, resource, action);
          expect(result).toBe(expected);
        }),
        { numRuns: 200 },
      );
    });
  });
});
