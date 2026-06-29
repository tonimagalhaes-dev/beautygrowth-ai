import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BusinessMemoryController } from './business-memory.controller';
import { BusinessMemoryService } from './services/business-memory.service';
import { BusinessMemoryEntry } from './entities/business-memory-entry.entity';

@Module({
  imports: [TypeOrmModule.forFeature([BusinessMemoryEntry])],
  controllers: [BusinessMemoryController],
  providers: [BusinessMemoryService],
  exports: [BusinessMemoryService],
})
export class BusinessMemoryModule {}
