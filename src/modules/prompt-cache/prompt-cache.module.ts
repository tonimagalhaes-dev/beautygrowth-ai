import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth/auth.module';
import { PromptCacheEntry } from './entities/prompt-cache-entry.entity';
import { PromptCacheService } from './services/prompt-cache.service';
import { PromptFingerprintService } from './services/prompt-fingerprint.service';
import { PromptCacheController } from './controllers/prompt-cache.controller';

/**
 * PromptCacheModule provides the persistent prompt/response cache layer
 * that intercepts the content generation flow to avoid redundant AI token consumption.
 *
 * Registers:
 * - PromptCacheEntry entity (TypeORM)
 * - PromptCacheService: core cache logic (lookup, persist, similar match)
 * - PromptFingerprintService: normalization + SHA-256 fingerprint computation
 * - PromptCacheController: REST API for history panel and similar match confirmation
 *
 * Imports:
 * - AuthModule: provides JwtModule (needed by TenantGuard used in the controller)
 *
 * Requirements: 1.3, 1.4, 6.1
 */
@Module({
  imports: [AuthModule, TypeOrmModule.forFeature([PromptCacheEntry])],
  controllers: [PromptCacheController],
  providers: [PromptCacheService, PromptFingerprintService],
  exports: [PromptCacheService, PromptFingerprintService],
})
export class PromptCacheModule {}
