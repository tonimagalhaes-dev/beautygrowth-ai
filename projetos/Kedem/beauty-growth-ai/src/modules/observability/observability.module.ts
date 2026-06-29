import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ObservabilityController } from './observability.controller';
import { ObservabilityService } from './services/observability.service';
import { AuditLog } from './entities/audit-log.entity';
import { AlertEntity } from './entities/alert.entity';

@Module({
  imports: [TypeOrmModule.forFeature([AuditLog, AlertEntity])],
  controllers: [ObservabilityController],
  providers: [ObservabilityService],
  exports: [ObservabilityService],
})
export class ObservabilityModule {}
