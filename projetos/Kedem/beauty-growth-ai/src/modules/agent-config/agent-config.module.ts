import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AgentConfigController } from './agent-config.controller';
import { AgentConfigService } from './services/agent-config.service';
import { AgentConfig } from './entities/agent-config.entity';
import { ConfigChange } from './entities/config-change.entity';

@Module({
  imports: [TypeOrmModule.forFeature([AgentConfig, ConfigChange])],
  controllers: [AgentConfigController],
  providers: [AgentConfigService],
  exports: [AgentConfigService],
})
export class AgentConfigModule {}
