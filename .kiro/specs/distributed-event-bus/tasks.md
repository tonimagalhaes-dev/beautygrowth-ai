# Implementation Plan: Distributed Event Bus

## Overview

Implementação do módulo `EventBusModule` baseado em BullMQ para substituir progressivamente o `EventEmitter2` em eventos críticos de domínio. A abordagem é incremental: infraestrutura → core service → decorators → consumers → DLQ → observabilidade → testes.

## Tasks

- [ ] 1. Infraestrutura e estrutura do módulo
  - [x] 1.1 Instalar dependências BullMQ e criar estrutura de diretórios
    - Executar `npm install bullmq @nestjs/bullmq`
    - Criar a estrutura de diretórios sob `src/modules/event-bus/` conforme definido no design: `interfaces/`, `services/`, `decorators/`, `dto/`, `entities/`, `consumers/`, `config/`, `controllers/`, `tests/`
    - Criar o arquivo `src/modules/event-bus/index.ts` com barrel exports
    - _Requirements: 1.1, 1.3_

  - [x] 1.2 Definir interfaces e tipos core do Event Bus
    - Criar `src/modules/event-bus/interfaces/event-bus.interface.ts` com `IEventBusService`, `DomainEventPayload`, `PublishOptions`, `PublishResult`, `EventPriority`, `PaginationOptions`, `PaginatedDLQResult`, `DLQItem`, `ReplayFilters`, `ReplayResult`, `EventHandler`
    - Criar `src/modules/event-bus/interfaces/event-config.interface.ts` com `EventConfig`, `ConsumerOptions`, `EventBusModuleOptions`
    - Criar `src/modules/event-bus/interfaces/index.ts` com re-exports
    - _Requirements: 1.1, 9.1_

  - [x] 1.3 Criar constantes e registro de eventos (EventRegistry)
    - Criar `src/modules/event-bus/config/event-bus.constants.ts` com o namespace `REDIS_PREFIX = 'beautygrowth:events:'` e demais constantes (CONNECTION_BUFFER_TTL_MS = 30000, prioridades)
    - Criar `src/modules/event-bus/config/event-registry.ts` com o array `EVENT_REGISTRY` contendo configuração declarativa dos 4 eventos: `tenant.created`, `brand.updated`, `guardrails.changed`, `guardrails.violation` com prioridades, retries, concorrência, dualEmit e payloadSchema conforme design
    - _Requirements: 1.7, 4.1, 4.2, 9.1, 9.2_

  - [x] 1.4 Criar DTOs de payload com validação class-validator
    - Criar `src/modules/event-bus/dto/tenant-created-payload.dto.ts`
    - Criar `src/modules/event-bus/dto/brand-updated-payload.dto.ts`
    - Criar `src/modules/event-bus/dto/guardrails-changed-payload.dto.ts`
    - Criar `src/modules/event-bus/dto/guardrails-violation-payload.dto.ts`
    - Cada DTO implementa `DomainEventPayload` com decorators `@IsUUID`, `@IsIn`, `@IsOptional`, `@IsDate` etc.
    - _Requirements: 5.1, 9.3_

  - [x] 1.5 Criar entidade EventAuditLog (TypeORM)
    - Criar `src/modules/event-bus/entities/event-audit-log.entity.ts` com todos os campos definidos no design: id, eventName, payload (jsonb), tenantId, correlationId, publishedAt, processedAt, durationMs, status, attempts, errors (jsonb), isReplay, createdAt
    - Adicionar índice em `tenantId` para queries filtradas
    - _Requirements: 6.1, 6.2, 6.3_

  - [x] 1.6 Criar migration para tabela event_audit_logs
    - Gerar migration TypeORM para criar a tabela `event_audit_logs` com todas as colunas, índices e tipos conforme a entidade
    - _Requirements: 6.1, 6.3_

- [x] 2. Checkpoint - Verificar compilação da infraestrutura
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Implementação do EventBusService (core)
  - [x] 3.1 Implementar ConnectionBuffer
    - Criar `src/modules/event-bus/services/connection-buffer.service.ts`
    - Implementar buffer local com array de `BufferedEvent[]`
    - Implementar `bufferEvent()`, `flush()`, `pruneExpired()` com TTL de 30s
    - Implementar cálculo de delay de reconexão: `min(1000 * 2^attempt, 16000)`
    - _Requirements: 1.6_

  - [x] 3.2 Implementar PayloadValidator
    - Criar `src/modules/event-bus/services/payload-validator.service.ts`
    - Utilizar `class-validator` + `class-transformer` para validar payloads contra o schema do EventRegistry
    - Retornar erro descritivo listando campos inválidos quando validação falha
    - _Requirements: 9.3, 5.1_

  - [x] 3.3 Implementar EventBusService — método publish()
    - Criar `src/modules/event-bus/services/event-bus.service.ts` implementando `IEventBusService`
    - Implementar `publish()`: validação de payload → geração de correlationId (UUID v4) → emissão dual (se configurado) → enqueue no BullMQ com prioridade, retry config e namespace correto
    - Integrar ConnectionBuffer para cenário de Redis offline
    - _Requirements: 1.1, 1.2, 1.7, 2.5, 4.4, 6.6, 8.5_

  - [x] 3.4 Implementar EventBusService — método subscribe()
    - Implementar `subscribe()` para registro programático de consumers
    - Configurar worker BullMQ com contexto de tenant (SET app.current_tenant), concorrência por tenant (max 5) e exponential backoff
    - _Requirements: 1.1, 1.5, 5.2, 5.3, 5.5_

  - [x] 3.5 Implementar AuditService
    - Criar `src/modules/event-bus/services/audit.service.ts`
    - Implementar persistência de registros de auditoria no EventAuditLog (sucesso e falha)
    - Implementar método `replay()` com filtros por tenantId, intervalo de datas e status
    - Marcar eventos republicados com `isReplay: true`
    - _Requirements: 6.1, 6.2, 6.4, 6.5, 6.6_

  - [ ]* 3.6 Escrever teste de propriedade para fórmula de backoff
    - **Property 3: Fórmula de exponential backoff**
    - Gerar tentativas aleatórias (1-5), validar que delay = `1000 * 2^(n-1)` para toda tentativa
    - **Validates: Requirements 1.6, 3.1**

  - [ ]* 3.7 Escrever teste de propriedade para correlationId único
    - **Property 14: CorrelationId único UUID v4**
    - Gerar N publicações, validar que todos correlationIds são UUIDs v4 válidos e distintos
    - **Validates: Requirements 6.6**

  - [ ]* 3.8 Escrever teste de propriedade para validação de payload
    - **Property 19: Validação de payload contra schema**
    - Gerar payloads válidos e inválidos (sem tenantId, campos extras, tipos errados), validar aceitação/rejeição conforme schema
    - **Validates: Requirements 9.3**

  - [ ]* 3.9 Escrever teste de propriedade para tenantId obrigatório
    - **Property 9: Validação de tenantId obrigatório**
    - Gerar payloads com tenantId ausente ou inválido, validar rejeição com erro descritivo
    - **Validates: Requirements 5.1**

- [x] 4. Checkpoint - Verificar EventBusService core
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Decorator e registro automático de consumers
  - [x] 5.1 Implementar decorator @OnDistributedEvent
    - Criar `src/modules/event-bus/decorators/on-distributed-event.decorator.ts`
    - Implementar decorator que armazena metadata (eventName, options) via `Reflect.defineMetadata`
    - Suportar `ConsumerOptions` (concurrency, groupByTenant)
    - _Requirements: 8.2, 8.3_

  - [x] 5.2 Implementar discovery e registro automático de consumers
    - No `EventBusModule.onModuleInit()`, escanear todos os providers registrados buscando métodos decorados com `@OnDistributedEvent`
    - Para cada handler encontrado, registrar um worker BullMQ correspondente ao eventName com as configurações do EventRegistry
    - _Requirements: 8.3, 9.2_

  - [ ]* 5.3 Escrever teste de propriedade para decorator registra consumer
    - **Property 17: Decorator @OnDistributedEvent registra consumer**
    - Gerar eventNames variados, validar que cada decorator resulta em worker BullMQ registrado
    - **Validates: Requirements 8.2, 8.3**

  - [ ]* 5.4 Escrever teste de propriedade para configuração declarativa cria fila
    - **Property 18: Configuração declarativa cria fila com parâmetros corretos**
    - Gerar configurações variadas no EVENT_REGISTRY, validar que filas são criadas com parâmetros corretos na inicialização
    - **Validates: Requirements 9.1, 9.2**

- [ ] 6. Migração dos consumers existentes
  - [x] 6.1 Implementar TenantProvisioningConsumer
    - Criar `src/modules/event-bus/consumers/tenant-provisioning.consumer.ts`
    - Migrar lógica de `TenantProvisioningListener.handleKnowledgeHubInit()` e `handleBusinessMemoryInit()` usando `@OnDistributedEvent('tenant.created')`
    - Manter `TenantProvisioningListener` ativo (dual-emit durante transição)
    - _Requirements: 2.1, 2.5_

  - [x] 6.2 Implementar BrandSyncConsumer
    - Criar `src/modules/event-bus/consumers/brand-sync.consumer.ts`
    - Migrar lógica de `BrandSyncListener.handleBrandUpdated()` usando `@OnDistributedEvent('brand.updated')`
    - Manter `BrandSyncListener` ativo (dual-emit durante transição)
    - _Requirements: 2.2, 2.5_

  - [x] 6.3 Implementar GuardrailsCacheConsumer
    - Criar `src/modules/event-bus/consumers/guardrails-cache.consumer.ts`
    - Implementar handler para `guardrails.changed` com invalidação de cache usando `@OnDistributedEvent('guardrails.changed')`
    - _Requirements: 2.3_

  - [x] 6.4 Implementar GuardrailsViolationConsumer
    - Criar `src/modules/event-bus/consumers/guardrails-violation.consumer.ts`
    - Implementar handler para `guardrails.violation` com logging de violação usando `@OnDistributedEvent('guardrails.violation')`
    - _Requirements: 2.4_

  - [ ]* 6.5 Escrever teste de propriedade para emissão dual
    - **Property 4: Emissão dual com semânticas corretas**
    - Validar que eventos com `dualEmit: true` emitem síncrono no EventEmitter2 e assíncrono no BullMQ
    - **Validates: Requirements 2.5, 8.5**

  - [ ]* 6.6 Escrever teste de propriedade para retry + DLQ
    - **Property 5: Retry configurado por tipo com preservação em DLQ**
    - Gerar falhas para cada tipo de evento, validar que retries seguem configuração e DLQ preserva payload + erros
    - **Validates: Requirements 3.2, 3.3**

- [x] 7. Checkpoint - Verificar consumers migrados
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Gerenciamento da Dead Letter Queue
  - [x] 8.1 Implementar reprocessFromDLQ()
    - Adicionar método `reprocessFromDLQ(eventName, jobId)` ao EventBusService
    - Buscar job na DLQ do BullMQ, reprocessar via fila original, remover da DLQ em caso de sucesso
    - Registrar reprocessamento no log de auditoria
    - _Requirements: 3.4, 3.6_

  - [x] 8.2 Implementar listDLQ()
    - Adicionar método `listDLQ(eventName, pagination)` ao EventBusService
    - Retornar itens da DLQ com paginação, ordenados do mais recente ao mais antigo pelo timestamp de falha
    - Incluir payload original, histórico de erros e número de tentativas em cada item
    - _Requirements: 3.5_

  - [ ]* 8.3 Escrever teste de propriedade para round-trip da DLQ
    - **Property 6: Round-trip da Dead Letter Queue**
    - Validar que reprocessamento com sucesso remove da DLQ e registra auditoria
    - **Validates: Requirements 3.4, 3.6**

  - [ ]* 8.4 Escrever teste de propriedade para paginação DLQ
    - **Property 7: Paginação e ordenação na DLQ**
    - Gerar N itens + configurações de page/pageSize aleatórias, validar contagem e ordenação corretas
    - **Validates: Requirements 3.5**

- [x] 9. Observabilidade (métricas, health, alertas)
  - [x] 9.1 Implementar MetricsCollector
    - Criar `src/modules/event-bus/services/metrics-collector.service.ts`
    - Coletar métricas: published, processed, failed por tipo; latência média; tamanho de filas (waiting, active, delayed, failed)
    - Emitir alerta WARN quando latência > 2x SLA ou fila > 1000 eventos pendentes
    - _Requirements: 7.1, 7.2, 7.3_

  - [x] 9.2 Implementar endpoint GET /events/health
    - Criar `src/modules/event-bus/controllers/event-bus-health.controller.ts`
    - Expor `GET /events/health` retornando: status Redis, filas ativas, workers ativos, métricas últimos 5 minutos
    - _Requirements: 7.4_

  - [x] 9.3 Implementar log estruturado por evento processado
    - Garantir que cada evento processado pelo worker gera log JSON com campos: eventName, tenantId, correlationId, durationMs, status, attempt, workerInstance
    - _Requirements: 7.5, 5.4_

  - [ ]* 9.4 Escrever teste de propriedade para alerta de latência
    - **Property 15: Alerta de latência excedida**
    - Gerar durações aleatórias, validar que WARN é emitido apenas quando > 2x SLA
    - **Validates: Requirements 7.2**

  - [ ]* 9.5 Escrever teste de propriedade para log estruturado
    - **Property 16: Log estruturado por evento processado**
    - Validar que logs contêm todos os campos obrigatórios para cada status (success/failed/retrying)
    - **Validates: Requirements 7.5**

- [x] 10. Checkpoint - Verificar observabilidade
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 11. Modo fallback e configuração de desativação dual-emit
  - [x] 11.1 Implementar modo fallback (EVENT_BUS_ENABLED=false)
    - Quando `EVENT_BUS_ENABLED=false`, publicar todos os eventos exclusivamente via EventEmitter2
    - Não tentar conexão com Redis
    - Consumers com `@OnDistributedEvent()` devem receber via EventEmitter2 como fallback
    - _Requirements: 9.5_

  - [x] 11.2 Implementar flag de desativação de dual-emit por evento
    - Permitir desativar emissão EventEmitter2 por evento via configuração no EventRegistry (campo `dualEmit: false`)
    - Sem necessidade de alteração de código, apenas mudar o valor no registro
    - _Requirements: 2.6_

  - [ ]* 11.3 Escrever teste de propriedade para modo fallback
    - **Property 20: Modo fallback sem Redis**
    - Validar que com ENV=false eventos são publicados via EventEmitter2 e consumers recebem via fallback
    - **Validates: Requirements 9.5**

- [x] 12. Wiring final: EventBusModule no AppModule
  - [x] 12.1 Criar EventBusModule com DynamicModule e registrar no AppModule
    - Implementar `EventBusModule.forRoot()` com opções de configuração
    - Registrar `EventBusModule.forRoot()` no `AppModule.imports`
    - Adicionar path alias `@event-bus/` no tsconfig e jest config
    - Garantir que todos os consumers são registrados como providers
    - _Requirements: 1.4, 9.2_

  - [ ]* 12.2 Escrever teste de propriedade para persistência com namespace
    - **Property 1: Persistência com namespace correto**
    - Validar que jobs criados usam chaves com prefixo `beautygrowth:events:`
    - **Validates: Requirements 1.2, 1.7**

  - [ ]* 12.3 Escrever teste de propriedade para prioridade com override
    - **Property 8: Processamento por prioridade com override**
    - Gerar prioridades aleatórias (1, 5, 10) como override, validar que job usa prioridade fornecida
    - **Validates: Requirements 4.3, 4.4**

- [ ] 13. Testes de integração e propriedades restantes
  - [ ]* 13.1 Escrever teste de propriedade para processamento único
    - **Property 2: Processamento único (competing consumers)**
    - Simular N workers e M eventos, validar que cada evento gera exatamente um registro de auditoria
    - **Validates: Requirements 1.5**

  - [ ]* 13.2 Escrever teste de propriedade para isolamento de falha por tenant
    - **Property 10: Isolamento de falha por tenant**
    - Simular falhas em tenant A, validar que tenants B/C continuam processando normalmente
    - **Validates: Requirements 5.3**

  - [ ]* 13.3 Escrever teste de propriedade para concorrência limitada por tenant
    - **Property 11: Concorrência limitada por tenant**
    - Gerar N jobs por tenant, validar que max 5 estão active simultaneamente por tenant
    - **Validates: Requirements 5.5**

  - [ ]* 13.4 Escrever teste de propriedade para auditoria completa
    - **Property 12: Registro de auditoria completo**
    - Gerar eventos de sucesso e falha, validar que audit log contém todos os campos obrigatórios
    - **Validates: Requirements 6.1, 6.2**

  - [ ]* 13.5 Escrever teste de propriedade para replay com filtros
    - **Property 13: Replay com filtros e marcação isReplay**
    - Gerar filtros aleatórios, validar que apenas eventos matching são republicados com isReplay=true
    - **Validates: Requirements 6.4, 6.5**

  - [ ]* 13.6 Escrever teste de integração end-to-end
    - Testar fluxo completo: publish → worker processa → audit log → métricas atualizadas
    - Testar cenário de retry → DLQ → reprocessamento
    - Testar health endpoint com Redis up/down
    - _Requirements: 1.2, 1.5, 3.1, 7.4_

- [x] 14. Checkpoint final - Verificar todos os testes
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marcadas com `*` são opcionais e podem ser puladas para um MVP mais rápido
- Cada task referencia requisitos específicos para rastreabilidade
- Checkpoints garantem validação incremental
- Testes de propriedade validam propriedades universais de corretude (fast-check)
- Testes unitários validam cenários específicos e edge cases
- A migração é incremental: os listeners antigos coexistem com os consumers novos via dual-emit
- Redis 7 e ioredis já estão configurados — apenas BullMQ precisa ser instalado

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["1.4", "1.5", "1.6"] },
    { "id": 3, "tasks": ["3.1", "3.2"] },
    { "id": 4, "tasks": ["3.3", "3.5"] },
    { "id": 5, "tasks": ["3.4", "3.6", "3.7", "3.8", "3.9"] },
    { "id": 6, "tasks": ["5.1"] },
    { "id": 7, "tasks": ["5.2", "5.3", "5.4"] },
    { "id": 8, "tasks": ["6.1", "6.2", "6.3", "6.4"] },
    { "id": 9, "tasks": ["6.5", "6.6"] },
    { "id": 10, "tasks": ["8.1", "8.2"] },
    { "id": 11, "tasks": ["8.3", "8.4"] },
    { "id": 12, "tasks": ["9.1", "9.3"] },
    { "id": 13, "tasks": ["9.2", "9.4", "9.5"] },
    { "id": 14, "tasks": ["11.1", "11.2"] },
    { "id": 15, "tasks": ["11.3", "12.1"] },
    { "id": 16, "tasks": ["12.2", "12.3"] },
    { "id": 17, "tasks": ["13.1", "13.2", "13.3", "13.4", "13.5", "13.6"] }
  ]
}
```
