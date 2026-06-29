import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { TenantContext } from '../interfaces/tenant-context.interface';

/**
 * Parameter decorator that extracts the TenantContext from the request.
 * The TenantGuard must be applied before this decorator can be used.
 *
 * Usage:
 * ```typescript
 * @Get()
 * @UseGuards(TenantGuard)
 * findAll(@CurrentTenant() tenant: TenantContext) {
 *   // tenant.tenantId, tenant.userId, tenant.role
 * }
 * ```
 *
 * You can also extract a specific property:
 * ```typescript
 * @Get()
 * @UseGuards(TenantGuard)
 * findAll(@CurrentTenant('tenantId') tenantId: string) {
 *   // tenantId is directly the UUID string
 * }
 * ```
 */
export const CurrentTenant = createParamDecorator(
  (data: keyof TenantContext | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const tenantContext: TenantContext | undefined = request.tenantContext;

    if (!tenantContext) {
      return undefined;
    }

    return data ? tenantContext[data] : tenantContext;
  },
);
