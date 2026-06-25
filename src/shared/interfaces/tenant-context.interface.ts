/**
 * Tenant context injected into every authenticated request.
 */
export interface TenantContext {
  /** UUID of the tenant */
  tenantId: string;
  /** UUID of the authenticated user */
  userId: string;
  /** User's role within the tenant */
  role: 'admin' | 'operator' | 'viewer';
}
