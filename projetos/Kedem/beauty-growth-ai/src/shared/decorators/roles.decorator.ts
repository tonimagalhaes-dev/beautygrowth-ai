import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

/**
 * Decorator that attaches required role metadata to route handlers.
 * Used in conjunction with RolesGuard to enforce RBAC.
 *
 * @example
 * ```typescript
 * @Roles('admin')
 * @Get('settings')
 * getSettings() { ... }
 *
 * @Roles('admin', 'operator')
 * @Post('content')
 * createContent() { ... }
 * ```
 */
export const Roles = (...roles: Array<'admin' | 'operator' | 'viewer'>) =>
  SetMetadata(ROLES_KEY, roles);
