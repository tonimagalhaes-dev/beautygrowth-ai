# Requirements Document

## Introduction

O **Distributed Cache** (ADR-004) implementa uma camada de cache distribuído baseada em **Redis 7** para a plataforma BeautyGrowth AI. A solução resolve inconsistências críticas identificadas na revisão arquitetural pós-EPIC 01: o `GuardrailsService` utiliza um cache in-memory (`Map<string, Guardrail[]>`) com TTL de 60 segundos por instância, causando dados desatualizados em deployments multi-réplica. O `PromptRegistryService` realiza queries diretas ao PostgreSQL em cada resolução de template, sem nenhuma camada de cache. A migração para Redis com invalidação por eventos garante consistência cross-instância, reduz latência de leitura e permite configuração de TTL por tipo de dado.

## Glossary

- **Cache_Module**: Módulo NestJS compartilhado que provê a interface `ICacheService` para operações de cache distribuído via Redis.
- **Cache_Entry**: Par chave-valor armazenado no Redis com TTL configurável e metadados de namespace de tenant.
- **TTL**: Time-To-Live — tempo em segundos após o qual uma Cache_Entry expira automaticamente no Redis.
- **Cache_Hit**: Evento em que uma leitura ao cache encontra a Cache_Entry solicitada (evita acesso ao banco de dados).
- **Cache_Miss**: Evento em que uma leitura ao cache não encontra a Cache_Entry solicitada (requer acesso ao banco de dados).
- **Cache_Invalidation**: Processo de remoção explícita de uma ou mais Cache_Entries do Redis antes do vencimento do TTL, tipicamente acionado por um evento de domínio.
- **Tenant_Namespace**: Padrão de prefixo de chave Redis no formato `tenant:{tenantId}:{recurso}:{identificador}` que garante isolamento de dados entre tenants.
- **Cache_Warming**: Processo de pré-carregamento de dados frequentemente acessados no cache durante a inicialização do sistema ou após invalidação massiva.
- **Graceful_Degradation**: Comportamento do sistema em que, na indisponibilidade do Redis, as operações continuam funcionando normalmente acessando diretamente o banco de dados sem cache.
- **Guardrails_Service**: Serviço que valida conteúdo gerado por agentes contra regras de segurança (sistema + tenant), atualmente com cache in-memory por instância.
- **Prompt_Registry**: Serviço que gerencia templates de prompts versionados com variáveis substituíveis, atualmente sem cache.
- **Plataforma**: Aplicação backend BeautyGrowth AI em NestJS.
- **Event_Bus**: Barramento de eventos distribuído (BullMQ) já implementado via ADR-001, utilizado para acionar invalidações de cache.

## Requirements

### Requisito 1: Módulo de Cache Distribuído (CacheModule)

**User Story:** Como desenvolvedor da plataforma, eu quero um módulo de cache distribuído compartilhado baseado em Redis, para que todos os serviços possam cachear dados de forma consistente em deployments multi-réplica.

#### Acceptance Criteria

1. THE Cache_Module SHALL expor uma interface `ICacheService` com métodos `get<T>(key)`, `set<T>(key, value, ttlSeconds)`, `delete(key)`, `deleteByPattern(pattern)` e `exists(key)` que encapsula a interação com Redis.
2. THE Cache_Module SHALL utilizar a instância Redis já configurada no docker-compose da Plataforma (redis:7-alpine, porta 6379) sem necessidade de infraestrutura adicional.
3. WHEN o Cache_Module é registrado via `CacheModule.forRoot(options)`, THE Cache_Module SHALL aceitar configuração de TTL padrão, prefixo global de namespace e configuração de conexão Redis.
4. THE Cache_Module SHALL prefixar todas as chaves Redis com o namespace `beautygrowth:cache:` para evitar colisão com outras utilizações do Redis na Plataforma (filas BullMQ, event bus).
5. THE Cache_Module SHALL serializar valores em JSON ao armazenar e desserializar ao recuperar, preservando a estrutura e tipos dos objetos originais.
6. WHEN o método `deleteByPattern(pattern)` é chamado, THE Cache_Module SHALL remover todas as chaves que correspondem ao padrão glob fornecido utilizando o comando Redis SCAN para evitar bloqueio do servidor.

### Requisito 2: Isolamento Multi-Tenant por Namespace

**User Story:** Como arquiteto da plataforma, eu quero que o cache respeite o isolamento multi-tenant via namespacing de chaves, para que dados de um tenant sejam completamente isolados no Redis sem possibilidade de colisão.

#### Acceptance Criteria

1. THE Cache_Module SHALL estruturar todas as chaves de cache no formato `beautygrowth:cache:tenant:{tenantId}:{recurso}:{identificador}` para dados tenant-scoped.
2. THE Cache_Module SHALL suportar chaves globais (não-tenant-scoped) no formato `beautygrowth:cache:global:{recurso}:{identificador}` para dados compartilhados como guardrails de sistema.
3. WHEN uma operação de invalidação por tenant é solicitada, THE Cache_Module SHALL remover exclusivamente as chaves do Tenant_Namespace especificado sem afetar chaves de outros tenants.
4. THE Cache_Module SHALL validar que o `tenantId` fornecido nas operações tenant-scoped é um UUID válido, retornando erro descritivo se inválido.

### Requisito 3: Migração do Cache do GuardrailsService

**User Story:** Como desenvolvedor da plataforma, eu quero migrar o cache in-memory do GuardrailsService para Redis distribuído, para que regras de guardrails sejam consistentes entre todas as réplicas da aplicação.

#### Acceptance Criteria

1. WHEN o Guardrails_Service busca guardrails ativos para um tenant, THE Guardrails_Service SHALL primeiro consultar o cache distribuído na chave `tenant:{tenantId}:guardrails:active` antes de acessar o banco de dados.
2. WHEN ocorre um Cache_Miss para guardrails de um tenant, THE Guardrails_Service SHALL buscar os guardrails no banco de dados, armazená-los no cache distribuído com TTL configurável e retornar o resultado.
3. THE Guardrails_Service SHALL cachear guardrails de sistema (tenant_id NULL) na chave `global:guardrails:system` com TTL independente dos guardrails de tenant.
4. WHEN um guardrail é criado, atualizado ou deletado, THE Guardrails_Service SHALL invalidar imediatamente o cache do tenant correspondente, garantindo que todas as réplicas obtenham dados atualizados na próxima requisição.
5. THE Guardrails_Service SHALL utilizar TTL de 300 segundos (5 minutos) como padrão para cache de guardrails de tenant e 600 segundos (10 minutos) para guardrails de sistema.
6. THE Guardrails_Service SHALL remover completamente o cache in-memory (`Map<string, Guardrail[]>` e `cacheLastUpdated`) após a migração para Redis.

### Requisito 4: Migração do Cache do PromptRegistryService

**User Story:** Como desenvolvedor da plataforma, eu quero adicionar cache distribuído ao PromptRegistryService, para que resoluções de prompts frequentes sejam servidas do Redis reduzindo latência e carga no banco de dados.

#### Acceptance Criteria

1. WHEN o Prompt_Registry resolve um prompt ativo, THE Prompt_Registry SHALL primeiro consultar o cache distribuído na chave `global:prompts:{promptId}:active` antes de acessar o banco de dados.
2. WHEN ocorre um Cache_Miss para um prompt, THE Prompt_Registry SHALL buscar o prompt no banco de dados, armazená-lo no cache distribuído com TTL configurável e retornar o resultado.
3. WHEN um prompt é atualizado (nova versão criada) ou sofre rollback, THE Prompt_Registry SHALL invalidar imediatamente o cache da chave correspondente ao promptId.
4. THE Prompt_Registry SHALL utilizar TTL de 600 segundos (10 minutos) como padrão para cache de prompts, pois prompts são atualizados com menor frequência que guardrails.
5. THE Prompt_Registry SHALL cachear apenas o conteúdo do template ativo (sem variáveis resolvidas), permitindo que a resolução de variáveis continue ocorrendo em tempo de execução.

### Requisito 5: Invalidação de Cache por Eventos

**User Story:** Como desenvolvedor da plataforma, eu quero que o cache seja invalidado automaticamente via eventos do Event Bus distribuído, para que atualizações em guardrails ou prompts reflitam imediatamente em todas as réplicas sem esperar o vencimento do TTL.

#### Acceptance Criteria

1. WHEN o Event_Bus publica o evento `guardrails.changed` com payload contendo `tenantId` e `action` (created/updated/deleted), THE Cache_Module SHALL invalidar automaticamente o cache de guardrails do tenant especificado.
2. WHEN o Event_Bus publica um evento de atualização de prompt (a ser definido como `prompt.updated`), THE Cache_Module SHALL invalidar automaticamente o cache do prompt especificado no payload.
3. THE Cache_Module SHALL processar eventos de invalidação de forma idempotente: invalidar uma chave que já não existe no cache não deve gerar erro.
4. WHEN um evento de invalidação é processado, THE Cache_Module SHALL registrar em log estruturado o evento com campos: eventName, tenantId, cacheKey invalidada e timestamp.
5. IF o Redis está indisponível no momento de uma invalidação event-driven, THEN THE Cache_Module SHALL registrar um log WARN e não propagarr o erro ao event handler, pois o TTL natural eventualmente expirará a entrada.

### Requisito 6: TTL Configurável por Tipo de Dado

**User Story:** Como desenvolvedor da plataforma, eu quero configurar TTLs diferentes para cada tipo de dado cacheado, para que dados com diferentes frequências de mudança tenham políticas de expiração otimizadas.

#### Acceptance Criteria

1. THE Cache_Module SHALL aceitar configuração declarativa de TTL por tipo de recurso no formato `{ guardrails_tenant: number, guardrails_system: number, prompts: number, default: number }`.
2. THE Cache_Module SHALL aplicar o TTL padrão (`default`) quando o recurso solicitado não possui TTL específico configurado.
3. THE Cache_Module SHALL permitir override de TTL em operações individuais de `set()`, onde o TTL passado como parâmetro prevalece sobre a configuração global.
4. WHEN a variável de ambiente `CACHE_TTL_GUARDRAILS_TENANT` está definida, THE Cache_Module SHALL utilizar seu valor (em segundos) ao invés do TTL padrão para guardrails de tenant.
5. WHEN a variável de ambiente `CACHE_TTL_PROMPTS` está definida, THE Cache_Module SHALL utilizar seu valor (em segundos) ao invés do TTL padrão para prompts.

### Requisito 7: Cache Warming (Pré-carregamento)

**User Story:** Como operador da plataforma, eu quero que dados críticos sejam pré-carregados no cache durante a inicialização, para que as primeiras requisições após um deploy não sofram latência elevada por cache miss.

#### Acceptance Criteria

1. WHEN a Plataforma inicializa com sucesso e a conexão Redis está disponível, THE Cache_Module SHALL executar o warming de guardrails de sistema carregando-os do banco de dados para o cache.
2. THE Cache_Module SHALL expor um método `warmTenantCache(tenantId)` que carrega guardrails e prompts ativos do tenant especificado para o cache.
3. WHEN o warming falha (Redis indisponível ou erro de banco), THE Cache_Module SHALL registrar log WARN e permitir que a Plataforma continue a inicialização normalmente sem cache aquecido.
4. THE Cache_Module SHALL executar o warming de forma assíncrona sem bloquear a inicialização da Plataforma ou o atendimento de requisições.
5. THE Cache_Module SHALL suportar warming sob demanda via método `warmAll()` que carrega todos os tenants ativos, limitado a processamento sequencial de 10 tenants por vez para não sobrecarregar o banco de dados.

### Requisito 8: Degradação Graciosa (Graceful Degradation)

**User Story:** Como operador da plataforma, eu quero que o sistema continue funcionando normalmente quando o Redis está indisponível, para que a indisponibilidade do cache não cause downtime da aplicação.

#### Acceptance Criteria

1. IF a conexão com Redis é perdida, THEN THE Cache_Module SHALL operar em modo bypass onde `get()` retorna `null` (cache miss) e `set()` e `delete()` são no-ops silenciosos.
2. WHEN o Cache_Module detecta falha de conexão Redis, THE Cache_Module SHALL registrar log com nível ERROR contendo o erro de conexão e timestamp.
3. WHEN a conexão Redis é restaurada após uma falha, THE Cache_Module SHALL retomar operações normais de cache automaticamente sem necessidade de restart da Plataforma.
4. THE Cache_Module SHALL implementar circuit breaker com threshold de 3 falhas consecutivas de conexão antes de entrar em modo bypass, evitando tentativas repetidas contra um Redis indisponível.
5. WHEN o circuit breaker está aberto (modo bypass), THE Cache_Module SHALL tentar reconexão a cada 30 segundos até restaurar a conexão.
6. THE Guardrails_Service e o Prompt_Registry SHALL continuar funcionando normalmente (acessando banco de dados diretamente) quando o Cache_Module está em modo bypass.

### Requisito 9: Métricas e Observabilidade do Cache

**User Story:** Como operador da plataforma, eu quero monitorar a taxa de hit/miss, latência e evictions do cache, para que eu possa otimizar a configuração de TTL e identificar problemas de performance.

#### Acceptance Criteria

1. THE Cache_Module SHALL coletar métricas contendo: total de hits por tipo de recurso, total de misses por tipo de recurso, total de invalidações por tipo de recurso, latência média de operações get/set (em ms) e total de erros de conexão.
2. THE Cache_Module SHALL expor um método `getMetrics()` que retorna as métricas agregadas desde o último reset ou desde a inicialização da Plataforma.
3. THE Cache_Module SHALL calcular e expor a taxa de hit rate por tipo de recurso usando a fórmula `hits / (hits + misses) * 100`.
4. WHEN a taxa de hit rate de um tipo de recurso cai abaixo de 50% em uma janela de 5 minutos, THE Cache_Module SHALL emitir log estruturado com nível WARN contendo o tipo de recurso e a taxa atual.
5. THE Cache_Module SHALL incluir o campo `cacheStatus` (hit/miss/bypass) nos logs de operações do Guardrails_Service e do Prompt_Registry para permitir análise de eficácia do cache.
6. THE Cache_Module SHALL expor as métricas via endpoint HTTP `GET /cache/metrics` retornando o estado atual do cache incluindo: conexão Redis (up/down/circuit-open), métricas por tipo de recurso e configuração de TTL ativa.

### Requisito 10: Remoção de Código Legado

**User Story:** Como desenvolvedor da plataforma, eu quero que todo código legado de cache in-memory e referências não utilizadas sejam removidos ao final da migração, para que o codebase permaneça limpo e sem ambiguidade sobre qual mecanismo de cache está em uso.

#### Acceptance Criteria

1. WHEN a migração para cache distribuído estiver concluída, THE Plataforma SHALL remover todo código de cache in-memory do GuardrailsService incluindo: propriedades `Map<string, Guardrail[]>`, variáveis de controle como `cacheLastUpdated`, lógica de verificação de expiração in-memory e imports não utilizados.
2. THE Plataforma SHALL remover quaisquer interfaces, types ou constantes que eram utilizados exclusivamente pelo mecanismo de cache in-memory e não possuem outro consumidor no codebase.
3. THE Plataforma SHALL verificar que nenhum outro módulo referencia ou depende das funcionalidades de cache in-memory removidas, garantindo que a remoção não causa erros de compilação ou runtime.
4. THE Plataforma SHALL atualizar ou remover testes unitários que validavam o comportamento do cache in-memory, substituindo-os por testes que validam a integração com o cache distribuído via Redis.
5. THE Plataforma SHALL remover variáveis de ambiente ou configurações relacionadas ao cache in-memory legado (se existirem), atualizando o `.env.example` para refletir apenas as novas variáveis de configuração do cache Redis.
