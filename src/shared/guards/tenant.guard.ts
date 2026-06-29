import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { TenantContext } from '../interfaces/tenant-context.interface';

export interface TokenPayload {
  userId: string;
  tenantId: string;
  role: 'admin' | 'operator' | 'viewer';
  iat: number;
  exp: number;
}

/**
 * TenantGuard extracts tenant_id from JWT, validates the token,
 * and attaches the TenantContext to the request.
 *
 * If tenant_id is missing or the token is invalid, the request is rejected
 * with a 403 Forbidden and an audit log entry is recorded.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  private readonly logger = new Logger(TenantGuard.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      this.logRejection(request, 'Missing authorization token');
      throw new UnauthorizedException('Missing authorization token');
    }

    let payload: TokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<TokenPayload>(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });
    } catch (error) {
      this.logRejection(request, 'Invalid or expired token');
      throw new UnauthorizedException('Invalid or expired token');
    }

    if (!payload.tenantId) {
      this.logRejection(request, 'Missing tenant_id in token payload', payload.userId);
      throw new ForbiddenException('Missing tenant_id in token payload');
    }

    if (!payload.userId) {
      this.logRejection(request, 'Missing user_id in token payload');
      throw new ForbiddenException('Missing user_id in token payload');
    }

    if (!payload.role) {
      this.logRejection(request, 'Missing role in token payload', payload.userId);
      throw new ForbiddenException('Missing role in token payload');
    }

    // Attach tenant context to the request for downstream use
    const tenantContext: TenantContext = {
      tenantId: payload.tenantId,
      userId: payload.userId,
      role: payload.role,
    };

    (request as any).tenantContext = tenantContext;

    return true;
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const authHeader = request.headers.authorization;
    if (!authHeader) {
      return undefined;
    }
    const [type, token] = authHeader.split(' ');
    return type === 'Bearer' ? token : undefined;
  }

  private logRejection(request: Request, reason: string, userId?: string): void {
    this.logger.warn({
      event: 'tenant_guard_rejection',
      reason,
      userId: userId || 'unknown',
      ip: request.ip,
      path: request.path,
      method: request.method,
      userAgent: request.headers['user-agent'],
      timestamp: new Date().toISOString(),
    });
  }
}
