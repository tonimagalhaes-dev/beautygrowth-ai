import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { TenantContext } from '../interfaces/tenant-context.interface';
import { PermissionsService, Role } from '../services/permissions.service';

/**
 * Guard that enforces role-based access control (RBAC).
 *
 * Reads required roles from handler metadata (set by @Roles() decorator),
 * retrieves the user's role from request.tenantContext (set by TenantGuard),
 * and checks if the user's role satisfies the permission requirement.
 *
 * If no @Roles() decorator is present on a handler, access is allowed by default.
 * If the user's role is not in the required roles list, a 403 Forbidden is thrown.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly permissionsService: PermissionsService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // If no @Roles() decorator is present, allow access
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const tenantContext = (request as any).tenantContext as TenantContext | undefined;

    if (!tenantContext) {
      this.logger.warn({
        event: 'roles_guard_rejection',
        reason: 'Missing tenant context (TenantGuard must run before RolesGuard)',
        path: request.path,
        method: request.method,
      });
      throw new ForbiddenException(
        'Access denied: missing authentication context',
      );
    }

    const userRole = tenantContext.role;

    if (!requiredRoles.includes(userRole)) {
      this.logger.warn({
        event: 'roles_guard_rejection',
        reason: 'Insufficient role',
        userId: tenantContext.userId,
        tenantId: tenantContext.tenantId,
        userRole,
        requiredRoles,
        path: request.path,
        method: request.method,
      });
      throw new ForbiddenException(
        'Access denied: insufficient permissions',
      );
    }

    return true;
  }
}
