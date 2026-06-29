import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PrivacyController } from './privacy.controller';
import { PrivacyService } from './services/privacy.service';
import { Consent } from './entities/consent.entity';
import { RetentionPolicyEntity } from './entities/retention-policy.entity';
import { DeletionRequest } from './entities/deletion-request.entity';
import { ROPARecordEntity } from './entities/ropa-record.entity';
import { DPOContactEntity } from './entities/dpo-contact.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Consent,
      RetentionPolicyEntity,
      DeletionRequest,
      ROPARecordEntity,
      DPOContactEntity,
    ]),
  ],
  controllers: [PrivacyController],
  providers: [PrivacyService],
  exports: [PrivacyService],
})
export class PrivacyModule {}
