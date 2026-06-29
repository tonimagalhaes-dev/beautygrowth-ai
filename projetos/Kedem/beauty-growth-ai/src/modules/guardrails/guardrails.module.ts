import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { GuardrailsController } from './guardrails.controller';
import { GuardrailsService } from './services/guardrails.service';
import { Guardrail } from './entities/guardrail.entity';
import { GuardrailViolation } from './entities/guardrail-violation.entity';
import { GuardrailVersion } from './entities/guardrail-version.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Guardrail, GuardrailViolation, GuardrailVersion]),
  ],
  controllers: [GuardrailsController],
  providers: [GuardrailsService],
  exports: [GuardrailsService],
})
export class GuardrailsModule implements OnModuleInit {
  constructor(private readonly guardrailsService: GuardrailsService) {}

  /**
   * On module initialization, seed system guardrails into DB if not present.
   */
  async onModuleInit(): Promise<void> {
    await this.guardrailsService.seedSystemGuardrails();
  }
}
