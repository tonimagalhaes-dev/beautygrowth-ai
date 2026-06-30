import { Injectable } from '@nestjs/common';

import { CACHE_PREFIX } from '../config/cache.constants';
import { InvalidTenantIdError } from '../errors/invalid-tenant-id.error';

/**
 * Utilitário para construção de chaves Redis com namespace de tenant.
 * Garante consistência de formato em todo o módulo.
 */
@Injectable()
export class CacheKeyBuilder {
  private readonly prefix: string;

  private static readonly UUID_V4_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  constructor(prefix?: string) {
    this.prefix = prefix ?? CACHE_PREFIX;
  }

  /**
   * Constrói chave tenant-scoped.
   * Formato: beautygrowth:cache:tenant:{tenantId}:{resource}:{identifier}
   * @throws InvalidTenantIdError se tenantId não é UUID v4 válido
   */
  tenantKey(tenantId: string, resource: string, identifier: string): string {
    this.validateTenantId(tenantId);
    return `${this.prefix}tenant:${tenantId}:${resource}:${identifier}`;
  }

  /**
   * Constrói chave global (não-tenant-scoped).
   * Formato: beautygrowth:cache:global:{resource}:{identifier}
   */
  globalKey(resource: string, identifier: string): string {
    return `${this.prefix}global:${resource}:${identifier}`;
  }

  /**
   * Constrói padrão glob para invalidação por tenant.
   * Formato: beautygrowth:cache:tenant:{tenantId}:*
   * @throws InvalidTenantIdError se tenantId não é UUID v4 válido
   */
  tenantPattern(tenantId: string): string {
    this.validateTenantId(tenantId);
    return `${this.prefix}tenant:${tenantId}:*`;
  }

  /**
   * Constrói padrão glob para invalidação por recurso de tenant.
   * Formato: beautygrowth:cache:tenant:{tenantId}:{resource}:*
   * @throws InvalidTenantIdError se tenantId não é UUID v4 válido
   */
  tenantResourcePattern(tenantId: string, resource: string): string {
    this.validateTenantId(tenantId);
    return `${this.prefix}tenant:${tenantId}:${resource}:*`;
  }

  /**
   * Valida que o tenantId é UUID v4 válido.
   * @throws InvalidTenantIdError com mensagem descritiva
   */
  validateTenantId(tenantId: string): void {
    if (!CacheKeyBuilder.UUID_V4_REGEX.test(tenantId)) {
      throw new InvalidTenantIdError(tenantId);
    }
  }
}
