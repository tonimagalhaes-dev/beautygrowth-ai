# Implementation Plan: Distributed Cache

## Overview

Implementação do módulo `CacheModule` baseado em Redis 7 + ioredis para substituir o cache in-memory do `GuardrailsService` e adicionar cache ao `PromptRegistryService`. A abordagem é incremental: fundação → circuit breaker → core service → métricas → módulo NestJS → migrações de serviços → invalidação por eventos → warming → health → validação final.

## Tasks

- [ ] 1. CacheModule Foundation
  - [x] 1.1 Criar estrutura de diretórios e interfaces core
    - Criar a estrutura de diretórios sob `src/modules/cache/`: `interfaces/`, `services/`, `dto/`, `config/`, `controllers/`, `tests/`
    - Criar `src/modules/cache/interfaces/cache-service.interface.ts` com `ICacheService`, `CachedValue<T>`, `CacheMetrics`, `CacheHealth`
    - Criar `src/modules/cache/interfaces/cache-module-options.interface.ts` com `CacheModuleOptions`, `CacheTtlConfig`, `CacheFeatureConfig`, `CircuitBreakerConfig`
    - Criar `src/modules/cache/interfaces/index.ts` com barrel exports
    - _Requirements: 1.1, 1.3, 1.4_

  - [x] 1.2 Criar constantes e tokens de DI
    - Criar `src/modules/cache/config/cache.constants.ts` com `CACHE_PREFIX = 'beautygrowth:cache:'`, `CACHE_SERVICE` (Symbol DI token), default TTLs (`DEFAULT_TTL = 300`, `GUARDRAILS_TENANT_TTL = 300`, `GUARDRAILS_SYSTEM_TTL = 600`, `PROMPTS_TTL = 600`)
    - Criar `src/modules/cache/config/index.ts` com re-exports
    - _Requirements: 1.4, 6.1, 6.2_

  - [x] 1.3 Implementar CacheKeyBuilder
    - Criar `src/modules/cache/services/cache-key-builder.service.ts`
    - Implementar `tenantKey(tenantId, resource, identifier)` → `beautygrowth:cache:tenant:{tenantId}:{resource}:{identifier}`
    - Implementar `globalKey(resource, identifier)` → `beautygrowth:cache:global:{resource}:{identifier}`
    - Implementar `tenantPattern(tenantId)` → `beautygrowth:cache:tenant:{tenantId}:*`
    - Implementar `tenantResourcePattern(tenantId, resource)` → `beautygrowth:cache:tenant:{tenantId}:{resource}:*`
    - Implementar `validateTenantId(tenantId)` com validação UUID v4 via regex
    - _Requirements: 2.1, 2.2, 2.4_

  - [x] 1.4 Implementar InvalidTenantIdError
    - Criar `src/modules/cache/errors/invalid-tenant-id.error.ts` extending Error com mensagem descritiva incluindo o tenantId inválido
    - _Requirements: 2.4_

  - [x] 1.5 Escrever testes unitários para CacheKeyBuilder
    - Testar formato de chaves tenant-scoped (cenários com UUIDs válidos)
    - Testar formato de chaves globais
    - Testar padrões glob para invalidação
    - Testar que `validateTenantId` lança `InvalidTenantIdError` para strings não-UUID
    - Testar que UUIDs válidos passam sem erro
    - _Requirements: 2.1, 2.2, 2.4_

  - [x] 1.6 Criar barrel export do módulo
    - Criar `src/modules/cache/index.ts` com exports de interfaces, constantes, serviços e módulo
    - _Requirements: 1.1_

- [x] 2. Circuit Breaker
  - [x] 2.1 Implementar CircuitBreaker
    - Criar `src/modules/cache/services/circuit-breaker.service.ts`
    - Implementar state machine com estados `CLOSED`, `OPEN`, `HALF_OPEN`
    - `CLOSED`: operações normais, conta falhas consecutivas
    - `OPEN`: rejeita operações retornando fallback, após `recoveryTimeoutMs` transiciona para `HALF_OPEN`
    - `HALF_OPEN`: permite uma operação teste — sucesso → `CLOSED`, falha → `OPEN`
    - Implementar métodos `execute<T>(operation, fallback)`, `recordSuccess()`, `recordFailure()`, `getState()`, `reset()`
    - Parâmetros configuráveis: `failureThreshold` (default: 3), `recoveryTimeoutMs` (default: 30000)
    - _Requirements: 8.4, 8.5_

  - [x] 2.2 Escrever testes unitários para CircuitBreaker
    - Testar transição CLOSED → OPEN após N falhas consecutivas
    - Testar que sucesso reseta contador de falhas
    - Testar transição OPEN → HALF_OPEN após timeout
    - Testar transição HALF_OPEN → CLOSED em sucesso
    - Testar transição HALF_OPEN → OPEN em falha
    - Testar que execute() retorna fallback quando OPEN
    - _Requirements: 8.4, 8.5_

  - [ ]* 2.3 Escrever teste de propriedade para circuit breaker abre em N falhas
    - **Property 8: Circuit breaker abre em exatamente N falhas consecutivas**
    - Gerar sequências aleatórias de sucesso/falha, validar que circuito abre apenas quando últimas N operações consecutivas são falhas
    - **Validates: Requirements 8.4**

  - [ ]* 2.4 Escrever teste de propriedade para graceful degradation
    - **Property 9: Graceful degradation em modo bypass**
    - Gerar operações aleatórias (get/set/delete/exists) com circuit em OPEN, validar que nenhuma tenta I/O Redis e retornam valores de bypass corretos
    - **Validates: Requirements 8.1, 8.6**

- [x] 3. Checkpoint - Verificar compilação da fundação e circuit breaker
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. CacheService (Core)
  - [x] 4.1 Implementar CacheService
    - Criar `src/modules/cache/services/cache.service.ts` implementando `ICacheService`
    - Injetar ioredis client, `CircuitBreaker`, `CacheMetricsCollector`, `CacheKeyBuilder`
    - Implementar `get<T>(key)`: circuit breaker execute → Redis GET → JSON.parse → extrair `data` do envelope `CachedValue` → registrar hit/miss nas métricas
    - Implementar `set<T>(key, value, ttlSeconds?)`: circuit breaker execute → construir envelope `CachedValue` → JSON.stringify → Redis SET EX → registrar set latency
    - Implementar `delete(key)`: circuit breaker execute → Redis DEL → idempotente (sem erro se chave inexistente)
    - Implementar `deleteByPattern(pattern)`: circuit breaker execute → SCAN iterativo com COUNT=100 → DEL batch → retornar contagem
    - Implementar `exists(key)`: circuit breaker execute → Redis EXISTS → boolean
    - Implementar `getMetrics()` e `getHealth()` delegando ao MetricsCollector
    - _Requirements: 1.1, 1.5, 1.6, 8.1, 8.6_

  - [x] 4.2 Escrever testes unitários para CacheService
    - Testar get() retorna dado deserializado em cache hit
    - Testar get() retorna null em cache miss
    - Testar set() armazena com envelope CachedValue e TTL correto
    - Testar delete() é idempotente
    - Testar deleteByPattern() usa SCAN iterativo e retorna contagem
    - Testar exists() retorna boolean correto
    - Testar que todas as operações retornam fallback quando circuit está OPEN
    - Testar serialização/desserialização JSON para objetos complexos
    - _Requirements: 1.1, 1.5, 1.6, 8.1_

  - [ ]* 4.3 Escrever teste de propriedade para round-trip JSON
    - **Property 1: Round-trip de serialização JSON**
    - Gerar objetos JSON arbitrários (arrays, nested objects, strings, números, booleans, nulls), validar que set() seguido de get() retorna valor deep-equal
    - **Validates: Requirements 1.5**

  - [ ]* 4.4 Escrever teste de propriedade para deleteByPattern
    - **Property 5: deleteByPattern remove apenas chaves correspondentes**
    - Gerar conjuntos de N chaves onde M correspondem a um padrão e (N-M) não correspondem, validar que apenas M são removidas
    - **Validates: Requirements 1.6**

  - [ ]* 4.5 Escrever teste de propriedade para invalidação idempotente
    - **Property 6: Invalidação idempotente**
    - Gerar chaves existentes e inexistentes, validar que delete() completa sem erro em ambos os casos e que delete() duplo tem mesmo efeito observável
    - **Validates: Requirements 5.3**

  - [ ]* 4.6 Escrever teste de propriedade para TTL override
    - **Property 7: TTL override prevalece sobre configuração global**
    - Gerar TTLs aleatórios como parâmetro de set(), validar que o TTL efetivo na chave Redis é exatamente o valor fornecido
    - **Validates: Requirements 6.3**

- [x] 5. Checkpoint - Verificar CacheService core
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. CacheMetricsCollector
  - [x] 6.1 Implementar CacheMetricsCollector
    - Criar `src/modules/cache/services/cache-metrics-collector.service.ts`
    - Implementar `recordHit(resourceType)`, `recordMiss(resourceType)`, `recordBypass(resourceType)`, `recordInvalidation(resourceType)`
    - Implementar `recordGetLatency(resourceType, ms)`, `recordSetLatency(resourceType, ms)`, `recordConnectionError()`
    - Implementar `getHitRate(resourceType)` → `hits / (hits + misses) * 100` (0 quando sem operações)
    - Implementar `getMetrics()` retornando `CacheMetrics` agregado
    - Implementar log WARN quando hit rate < 50% em janela de 5 minutos
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [x] 6.2 Escrever testes unitários para CacheMetricsCollector
    - Testar que hits/misses são contabilizados corretamente por recurso
    - Testar cálculo de hit rate (cenários: 100%, 50%, 0%, sem operações)
    - Testar que latências são registradas e média calculada
    - Testar emissão de WARN quando hit rate < 50%
    - _Requirements: 9.1, 9.3, 9.4_

  - [ ]* 6.3 Escrever teste de propriedade para métricas
    - **Property 10: Métricas refletem operações reais**
    - Gerar sequências aleatórias de H hits e M misses por tipo de recurso, validar que getMetrics() reflete exatamente H hits, M misses e hit rate = H / (H + M) * 100
    - **Validates: Requirements 9.1, 9.3**

- [ ] 7. CacheModule Registration
  - [x] 7.1 Implementar CacheModule como DynamicModule
    - Criar `src/modules/cache/cache.module.ts`
    - Implementar `CacheModule.forRoot(options?: CacheModuleOptions)`: cria conexão ioredis, registra `CacheService`, `CircuitBreaker`, `CacheMetricsCollector`, `CacheKeyBuilder`, `CacheWarmer`, `EventInvalidationListener`, `CacheHealthController` como providers globais
    - Implementar `CacheModule.forFeature(config: CacheFeatureConfig)`: registra configuração de TTL específica para feature modules
    - Ler TTLs de variáveis de ambiente: `CACHE_TTL_GUARDRAILS_TENANT`, `CACHE_TTL_GUARDRAILS_SYSTEM`, `CACHE_TTL_PROMPTS`, `CACHE_TTL_DEFAULT`
    - _Requirements: 1.3, 6.1, 6.4, 6.5_

  - [x] 7.2 Registrar CacheModule no AppModule
    - Adicionar `CacheModule.forRoot()` ao array de imports do `AppModule`
    - Configurar Redis host/port a partir de env vars existentes (`REDIS_HOST`, `REDIS_PORT`)
    - _Requirements: 1.2, 1.3_

  - [x] 7.3 Atualizar .env.example com variáveis de cache
    - Adicionar: `CACHE_TTL_GUARDRAILS_TENANT=300`, `CACHE_TTL_GUARDRAILS_SYSTEM=600`, `CACHE_TTL_PROMPTS=600`, `CACHE_TTL_DEFAULT=300`
    - _Requirements: 6.4, 6.5_

- [x] 8. Checkpoint - Verificar módulo registrado e compilação
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. GuardrailsService Migration
  - [x] 9.1 Injetar ICacheService no GuardrailsService
    - Adicionar `@Inject(CACHE_SERVICE) private readonly cache: ICacheService` ao construtor do `GuardrailsService`
    - Adicionar `CacheKeyBuilder` como dependência injetada
    - _Requirements: 3.1_

  - [x] 9.2 Implementar cache-aside para getActiveGuardrails
    - Em `getActiveGuardrails(tenantId)`: primeiro `cache.get<Guardrail[]>(tenantKey)` → se hit, retornar → se miss, buscar do banco, `cache.set(tenantKey, data, ttl)` e retornar
    - Chave tenant: `tenant:{tenantId}:guardrails:active`
    - Chave global: `global:guardrails:system`
    - _Requirements: 3.1, 3.2, 3.3, 3.5_

  - [x] 9.3 Implementar invalidação no create/update/delete
    - Em `createGuardrail()`, `updateGuardrail()`, `deleteGuardrail()`: após a operação no banco, chamar `cache.delete(tenantKey)` para o tenant correspondente
    - Para guardrails de sistema, invalidar `global:guardrails:system`
    - _Requirements: 3.4_

  - [x] 9.4 Remover código de cache in-memory legado
    - Remover propriedade `Map<string, Guardrail[]>` e `cacheLastUpdated`
    - Remover lógica de verificação de expiração in-memory
    - Remover imports não utilizados relacionados ao cache legado
    - _Requirements: 3.6, 10.1_

  - [ ] 9.5 Escrever testes unitários para GuardrailsService com cache
    - Testar cache hit retorna dados sem query ao banco
    - Testar cache miss busca do banco e popula cache
    - Testar invalidação após create/update/delete
    - Testar graceful degradation (circuit open → fallback ao banco)
    - _Requirements: 3.1, 3.2, 3.4, 8.6_

- [ ] 10. PromptRegistryService Cache Integration
  - [ ] 10.1 Injetar ICacheService no PromptRegistryService
    - Adicionar `@Inject(CACHE_SERVICE) private readonly cache: ICacheService` ao construtor
    - Adicionar `CacheKeyBuilder` como dependência injetada
    - _Requirements: 4.1_

  - [ ] 10.2 Implementar cache-aside para getActive()
    - Em `getActive(promptId)`: primeiro `cache.get(globalKey)` → se hit, retornar → se miss, buscar do banco, `cache.set(globalKey, data, ttl)` e retornar
    - Chave: `global:prompts:{promptId}:active`
    - Cachear apenas template sem variáveis resolvidas
    - _Requirements: 4.1, 4.2, 4.4, 4.5_

  - [ ] 10.3 Implementar invalidação em update/rollback
    - Em `updatePrompt()` e `rollbackPrompt()`: após a operação, chamar `cache.delete(promptKey)`
    - _Requirements: 4.3_

  - [ ] 10.4 Escrever testes unitários para PromptRegistryService com cache
    - Testar cache hit retorna template sem query ao banco
    - Testar cache miss busca do banco e popula cache
    - Testar invalidação após update e rollback
    - Testar que variáveis {{placeholder}} são preservadas no cache
    - _Requirements: 4.1, 4.2, 4.3, 4.5_

  - [ ]* 10.5 Escrever teste de propriedade para preservação de template
    - **Property 12: Prompt cacheado preserva template com variáveis**
    - Gerar prompts com variáveis `{{variableName}}` aleatórias, validar que após set/get os placeholders permanecem intactos
    - **Validates: Requirements 4.5**

- [ ] 11. Checkpoint - Verificar migrações de serviços
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 12. Event-Driven Invalidation
  - [ ] 12.1 Implementar EventInvalidationListener
    - Criar `src/modules/cache/services/event-invalidation-listener.service.ts`
    - Implementar `handleGuardrailsChanged(payload)`: extrair tenantId → `cache.delete(tenantKey)` para guardrails do tenant → log estruturado
    - Implementar `handlePromptUpdated(payload)`: extrair promptId → `cache.delete(promptKey)` → log estruturado
    - Processamento idempotente (sem erro se chave não existe)
    - Log estruturado com campos: eventName, tenantId, cacheKey, timestamp
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [ ] 12.2 Registrar evento 'prompt.updated' no EventRegistry
    - Adicionar configuração do evento `prompt.updated` no `EVENT_REGISTRY` do EventBusModule com payload schema, prioridade e retry config
    - _Requirements: 5.2_

  - [ ] 12.3 Configurar handlers com @OnDistributedEvent
    - Decorar `handleGuardrailsChanged` com `@OnDistributedEvent('guardrails.changed')`
    - Decorar `handlePromptUpdated` com `@OnDistributedEvent('prompt.updated')`
    - _Requirements: 5.1, 5.2_

  - [ ] 12.4 Escrever testes unitários para EventInvalidationListener
    - Testar que 'guardrails.changed' invalida cache do tenant correto
    - Testar que 'prompt.updated' invalida cache do prompt correto
    - Testar idempotência (chave inexistente não gera erro)
    - Testar log estruturado é emitido com campos obrigatórios
    - Testar que erro de Redis não propaga ao event handler (log WARN)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [ ]* 12.5 Escrever teste de propriedade para isolamento tenant
    - **Property 3: Isolamento de tenant na invalidação**
    - Gerar dois tenants A e B com chaves independentes, invalidar tenant A, validar que chaves de B permanecem intactas
    - **Validates: Requirements 2.3**

- [ ] 13. Cache Warming
  - [ ] 13.1 Implementar CacheWarmer
    - Criar `src/modules/cache/services/cache-warmer.service.ts` implementando `OnApplicationBootstrap`
    - Implementar `onApplicationBootstrap()`: executar `warmSystemGuardrails()` de forma assíncrona (não bloqueia startup)
    - Implementar `warmSystemGuardrails()`: carregar guardrails de sistema (tenant_id NULL) do banco → `cache.set(globalKey, data, ttl)`
    - Implementar `warmTenantCache(tenantId)`: carregar guardrails + prompts ativos do tenant → set no cache
    - Implementar `warmAll()`: listar tenants ativos → processar em lotes de 10 com throttling (max 10 concurrent)
    - Log WARN se warming falha (Redis ou banco indisponível)
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [ ] 13.2 Escrever testes unitários para CacheWarmer
    - Testar que onApplicationBootstrap chama warmSystemGuardrails
    - Testar warmSystemGuardrails popula cache com dados do banco
    - Testar warmTenantCache carrega guardrails e prompts
    - Testar warmAll processa em lotes de 10
    - Testar que falha de Redis não propaga erro (log WARN)
    - Testar que falha de banco não bloqueia startup
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [ ]* 13.3 Escrever teste de propriedade para throttle do warmAll
    - **Property 11: warmAll processa em lotes limitados**
    - Gerar N tenants (N > 10), validar que no máximo 10 operações de warming executam em paralelo simultaneamente
    - **Validates: Requirements 7.5**

- [ ] 14. Cache Health Endpoint
  - [ ] 14.1 Implementar CacheHealthController
    - Criar `src/modules/cache/controllers/cache-health.controller.ts`
    - Implementar `GET /cache/metrics` retornando `CacheHealth`: redis status (up/down/circuit-open), circuitState, metrics por tipo de recurso, ttlConfig ativa, uptimeMs
    - _Requirements: 9.6_

  - [ ] 14.2 Escrever testes unitários para CacheHealthController
    - Testar que endpoint retorna 200 com formato CacheHealth
    - Testar que redis status reflete estado real (up/down/circuit-open)
    - Testar que métricas incluem hits, misses, hit rate por recurso
    - _Requirements: 9.6_

- [ ] 15. Checkpoint - Verificar event invalidation, warming e health
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 16. Namespace e Tenant Isolation Validation
  - [ ]* 16.1 Escrever teste de propriedade para prefixo de namespace
    - **Property 2: Prefixo de namespace consistente**
    - Gerar combinações aleatórias de tenantId (UUID), recurso e identificador, validar que todas as chaves resultantes começam com `beautygrowth:cache:` e seguem o formato correto
    - **Validates: Requirements 1.4, 2.1, 2.2**

  - [ ]* 16.2 Escrever teste de propriedade para validação UUID
    - **Property 4: Validação de tenantId como UUID**
    - Gerar strings aleatórias (UUIDs válidos e inválidos), validar que inválidos lançam `InvalidTenantIdError` e válidos passam sem erro
    - **Validates: Requirements 2.4**

  - [ ] 16.3 Escrever teste de integração com Redis real
    - Testar isolamento tenant end-to-end: set chaves para tenant A e B → invalidar tenant A → verificar que B permanece intacto
    - Testar SCAN-based deleteByPattern com volume de chaves (100+)
    - Testar circuit breaker com Redis desconectado → reconexão
    - _Requirements: 2.3, 1.6, 8.3, 8.5_

- [ ] 17. Legacy Code Cleanup e Final Validation
  - [ ] 17.1 Remover artefatos de cache in-memory legado
    - Verificar e remover qualquer referência remanescente ao cache in-memory no GuardrailsService
    - Remover interfaces/types/constantes usados exclusivamente pelo cache legado
    - _Requirements: 10.1, 10.2_

  - [ ] 17.2 Atualizar testes e imports
    - Remover/atualizar testes que validavam cache in-memory
    - Substituir por testes que validam integração com cache distribuído
    - Remover imports não utilizados em todos os arquivos afetados
    - _Requirements: 10.3, 10.4_

  - [ ] 17.3 Atualizar .env.example final
    - Garantir que `.env.example` contém todas as novas variáveis de cache
    - Remover variáveis de cache legado se existirem
    - _Requirements: 10.5_

  - [ ] 17.4 Verificar compilação e test suite completo
    - Executar `npm run build` sem erros de compilação
    - Executar `npm run test` com todos os testes passando
    - Verificar que nenhum módulo referencia código legado removido
    - _Requirements: 10.3_

- [ ] 18. Checkpoint final - Verificar todos os testes
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marcadas com `*` são property-based tests (PBT) que podem ser executados independentemente
- Cada task referencia requisitos específicos para rastreabilidade
- Checkpoints garantem validação incremental
- Testes de propriedade utilizam `fast-check` v3.19 (já instalado) com mínimo 100 iterações
- A migração é incremental: cache in-memory continua funcionando até Task 9.4 onde é removido
- Redis 7 e ioredis já estão configurados no docker-compose — nenhuma infraestrutura adicional necessária
- O EventBusModule (ADR-001) já está implementado e é reutilizado para invalidação cross-réplica

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "1.4"] },
    { "id": 2, "tasks": ["1.5", "1.6"] },
    { "id": 3, "tasks": ["2.1"] },
    { "id": 4, "tasks": ["2.2", "2.3", "2.4"] },
    { "id": 5, "tasks": ["4.1"] },
    { "id": 6, "tasks": ["4.2", "4.3", "4.4", "4.5", "4.6"] },
    { "id": 7, "tasks": ["6.1"] },
    { "id": 8, "tasks": ["6.2", "6.3"] },
    { "id": 9, "tasks": ["7.1"] },
    { "id": 10, "tasks": ["7.2", "7.3"] },
    { "id": 11, "tasks": ["9.1"] },
    { "id": 12, "tasks": ["9.2", "9.3"] },
    { "id": 13, "tasks": ["9.4", "9.5"] },
    { "id": 14, "tasks": ["10.1"] },
    { "id": 15, "tasks": ["10.2", "10.3", "10.4", "10.5"] },
    { "id": 16, "tasks": ["12.1", "12.2"] },
    { "id": 17, "tasks": ["12.3", "12.4", "12.5"] },
    { "id": 18, "tasks": ["13.1"] },
    { "id": 19, "tasks": ["13.2", "13.3"] },
    { "id": 20, "tasks": ["14.1"] },
    { "id": 21, "tasks": ["14.2"] },
    { "id": 22, "tasks": ["16.1", "16.2", "16.3"] },
    { "id": 23, "tasks": ["17.1", "17.2"] },
    { "id": 24, "tasks": ["17.3", "17.4"] }
  ]
}
```
