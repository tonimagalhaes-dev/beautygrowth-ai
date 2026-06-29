import { Injectable } from '@nestjs/common';

export type Role = 'admin' | 'operator' | 'viewer';
export type Resource =
  | 'clinics'
  | 'brands'
  | 'agents'
  | 'content'
  | 'campaigns'
  | 'calendar'
  | 'members'
  | 'settings'
  | 'knowledge-hub'
  | 'guardrails'
  | 'observability'
  | 'privacy';

export type Action = 'create' | 'read' | 'update' | 'delete' | 'manage';

/**
 * Permission matrix definition.
 * Maps each role to the set of resources and allowed actions.
 *
 * - Admin: ALL resources, ALL actions
 * - Operator: content (create, read, update), campaigns (read, create), calendar (read, create, update)
 * - Viewer: ALL resources (read only)
 */
const PERMISSION_MATRIX: Record<Role, Record<string, Action[]>> = {
  admin: {
    clinics: ['create', 'read', 'update', 'delete', 'manage'],
    brands: ['create', 'read', 'update', 'delete', 'manage'],
    agents: ['create', 'read', 'update', 'delete', 'manage'],
    content: ['create', 'read', 'update', 'delete', 'manage'],
    campaigns: ['create', 'read', 'update', 'delete', 'manage'],
    calendar: ['create', 'read', 'update', 'delete', 'manage'],
    members: ['create', 'read', 'update', 'delete', 'manage'],
    settings: ['create', 'read', 'update', 'delete', 'manage'],
    'knowledge-hub': ['create', 'read', 'update', 'delete', 'manage'],
    guardrails: ['create', 'read', 'update', 'delete', 'manage'],
    observability: ['create', 'read', 'update', 'delete', 'manage'],
    privacy: ['create', 'read', 'update', 'delete', 'manage'],
  },
  operator: {
    content: ['create', 'read', 'update'],
    campaigns: ['read', 'create'],
    calendar: ['read', 'create', 'update'],
  },
  viewer: {
    clinics: ['read'],
    brands: ['read'],
    agents: ['read'],
    content: ['read'],
    campaigns: ['read'],
    calendar: ['read'],
    members: ['read'],
    settings: ['read'],
    'knowledge-hub': ['read'],
    guardrails: ['read'],
    observability: ['read'],
    privacy: ['read'],
  },
};

/**
 * Service responsible for checking access permissions based on the RBAC matrix.
 * Evaluates (role, resource, action) tuples against the defined permission matrix.
 */
@Injectable()
export class PermissionsService {
  /**
   * Checks if a given role has permission to perform an action on a resource.
   *
   * @param role - The user's role (admin, operator, viewer)
   * @param resource - The target resource
   * @param action - The action being attempted
   * @returns true if the role is allowed to perform the action on the resource
   */
  canAccess(role: Role, resource: string, action: string): boolean {
    const rolePermissions = PERMISSION_MATRIX[role];
    if (!rolePermissions) {
      return false;
    }

    const allowedActions = rolePermissions[resource];
    if (!allowedActions) {
      return false;
    }

    return allowedActions.includes(action as Action);
  }

  /**
   * Returns all allowed actions for a given role on a specific resource.
   *
   * @param role - The user's role
   * @param resource - The target resource
   * @returns Array of allowed actions, empty if no permissions
   */
  getAllowedActions(role: Role, resource: string): Action[] {
    const rolePermissions = PERMISSION_MATRIX[role];
    if (!rolePermissions) {
      return [];
    }

    return rolePermissions[resource] || [];
  }

  /**
   * Returns the full permission matrix for a given role.
   *
   * @param role - The user's role
   * @returns Record of resources to allowed actions
   */
  getPermissionsForRole(role: Role): Record<string, Action[]> {
    return PERMISSION_MATRIX[role] || {};
  }
}
