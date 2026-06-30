/**
 * Error thrown when an invalid tenant ID is provided to cache operations.
 * The tenantId must be a valid UUID v4.
 */
export class InvalidTenantIdError extends Error {
  public readonly tenantId: string;

  constructor(tenantId: string) {
    super(
      `Invalid tenant ID "${tenantId}": must be a valid UUID v4 format (e.g., 550e8400-e29b-41d4-a716-446655440000)`,
    );
    this.name = 'InvalidTenantIdError';
    this.tenantId = tenantId;
  }
}
