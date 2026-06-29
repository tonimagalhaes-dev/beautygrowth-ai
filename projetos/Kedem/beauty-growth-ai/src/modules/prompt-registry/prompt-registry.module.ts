import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { PromptRegistryController } from './prompt-registry.controller';
import { PromptRegistryService } from './services/prompt-registry.service';
import { Prompt } from './entities/prompt.entity';
import { PromptVersion } from './entities/prompt-version.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Prompt, PromptVersion])],
  controllers: [PromptRegistryController],
  providers: [PromptRegistryService],
  exports: [PromptRegistryService],
})
export class PromptRegistryModule {}
