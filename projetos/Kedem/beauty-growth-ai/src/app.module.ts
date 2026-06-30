import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ClinicModule } from './modules/clinic/clinic.module';
import { AgentMemoryModule } from './modules/agent-memory/agent-memory.module';
import { BusinessMemoryModule } from './modules/business-memory/business-memory.module';
import { ModelRegistryModule } from './modules/model-registry/model-registry.module';
import { PromptRegistryModule } from './modules/prompt-registry/prompt-registry.module';
import { KnowledgeHubModule } from './modules/knowledge-hub/knowledge-hub.module';
import { GuardrailsModule } from './modules/guardrails/guardrails.module';
import { PrivacyModule } from './modules/privacy/privacy.module';
import { ObservabilityModule } from './modules/observability/observability.module';
import { IntegrationModule } from './modules/integration/integration.module';
import { AgentExecutionModule } from './modules/agent-execution/agent-execution.module';
import { ContentAgentModule } from './modules/content-agent/content-agent.module';
import { AuthModule } from './modules/auth/auth.module';
import { EventBusModule } from './modules/event-bus/event-bus.module';
import { CacheModule } from './modules/cache/cache.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.example'],
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('DATABASE_HOST', 'localhost'),
        port: config.get<number>('DATABASE_PORT', 5432),
        username: config.get<string>('DATABASE_USER', 'beautygrowth'),
        password: config.get<string>('DATABASE_PASSWORD', 'beautygrowth_dev'),
        database: config.get<string>('DATABASE_NAME', 'beautygrowth_dev'),
        autoLoadEntities: true,
        synchronize: config.get<string>('NODE_ENV') === 'development',
        logging: config.get<string>('NODE_ENV') === 'development',
      }),
    }),
    EventEmitterModule.forRoot(),
    EventBusModule.forRoot(),
    CacheModule.forRoot(),
    ClinicModule,
    AgentMemoryModule,
    BusinessMemoryModule,
    ModelRegistryModule,
    PromptRegistryModule,
    KnowledgeHubModule,
    GuardrailsModule,
    PrivacyModule,
    ObservabilityModule,
    IntegrationModule,
    AgentExecutionModule,
    ContentAgentModule,
    AuthModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
