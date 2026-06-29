import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ModelRegistryController } from './model-registry.controller';
import { ModelRegistryService } from './services/model-registry.service';
import { AIModel } from './entities/ai-model.entity';
import { TenantModel } from './entities/tenant-model.entity';
import { TokenUsage } from './entities/token-usage.entity';

@Module({
  imports: [TypeOrmModule.forFeature([AIModel, TenantModel, TokenUsage])],
  controllers: [ModelRegistryController],
  providers: [ModelRegistryService],
  exports: [ModelRegistryService],
})
export class ModelRegistryModule {}
