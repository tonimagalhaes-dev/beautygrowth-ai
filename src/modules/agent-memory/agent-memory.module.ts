import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AgentMemoryController } from './agent-memory.controller';
import { AgentMemoryService } from './services/agent-memory.service';
import { AgentMemoryShort } from './entities/agent-memory-short.entity';
import { AgentMemoryLong } from './entities/agent-memory-long.entity';

@Module({
  imports: [TypeOrmModule.forFeature([AgentMemoryShort, AgentMemoryLong])],
  controllers: [AgentMemoryController],
  providers: [AgentMemoryService],
  exports: [AgentMemoryService],
})
export class AgentMemoryModule {}
