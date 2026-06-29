import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Observable, tap } from 'rxjs';
import { Request } from 'express';
import { TenantContext } from '../interfaces/tenant-context.interface';

/**
 * TenantInterceptor sets the PostgreSQL session variable `app.current_tenant`
 * before any DB operation, ensuring Row-Level Security policies filter
 * data by the authenticated tenant.
 *
 * This interceptor runs AFTER the TenantGuard has validated the JWT
 * and attached the TenantContext to the request.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TenantInterceptor.name);

  constructor(private readonly dataSource: DataSource) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest<Request>();
    const tenantContext: TenantContext | undefined = (request as any).tenantContext;

    if (tenantContext?.tenantId) {
      await this.setTenantSessionVariable(tenantContext.tenantId);
    }

    return next.handle().pipe(
      tap({
        error: () => {
          // Reset the session variable on error to prevent leakage
          this.resetTenantSessionVariable().catch((err) => {
            this.logger.error('Failed to reset tenant session variable', err);
          });
        },
      }),
    );
  }

  /**
   * Sets the PostgreSQL session variable `app.current_tenant` to the
   * given tenant_id. This enables Row-Level Security policies to
   * automatically filter all queries by tenant.
   */
  private async setTenantSessionVariable(tenantId: string): Promise<void> {
    try {
      // Use parameterized query to prevent SQL injection
      await this.dataSource.query(
        `SELECT set_config('app.current_tenant', $1, false)`,
        [tenantId],
      );
    } catch (error) {
      this.logger.error(
        `Failed to set tenant session variable for tenant ${tenantId}`,
        error,
      );
      throw error;
    }
  }

  /**
   * Resets the session variable to prevent tenant data leakage
   * in pooled connections.
   */
  private async resetTenantSessionVariable(): Promise<void> {
    await this.dataSource.query(
      `SELECT set_config('app.current_tenant', '', false)`,
    );
  }
}
