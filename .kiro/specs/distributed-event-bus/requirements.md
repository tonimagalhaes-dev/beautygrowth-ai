# Requirements Document

## Introduction

O **Distributed Event Bus** (ADR-001) migra a comunicação event-driven da plataforma BeautyGrowth AI do `EventEmitter2` (in-process, sem persistência) para um message broker distribuído baseado em **BullMQ** (Redis). Esta migração resolve limitações críticas identificadas na revisão arquitetural pós-EPIC 01: perda de eventos em crash, impossibilidade de escalonamento horizontal (multi-instância), ausência de retry com dead-letter queues e falta de suporte a workflows multiagentes assíncronos. O `EventEmitter2` será mantido exclusivamente para eventos intra-módulo não-críticos que não necessitam de persistência ou entrega garantida.

## Glossary

- **Event_Bus**: Camada de abstração que gerencia a publicação, roteamento e consumo de eventos de domínio entre módulos da Plataforma, utilizando BullMQ como transporte distribuído.
- **BullMQ**: Biblioteca de filas de jobs baseada em Redis que provê persistência, retry automático, dead-letter queues, prioridades e processamento concorrente.
- **Evento_de_Domínio**: Mensagem imutável que representa uma mudança de estado significativa no sistema (ex: `tenant.created`, `brand.updated`, `guardrails.violation`).
- **Producer**: Componente que publica um Evento_de_Domínio no Event_Bus.
- **Consumer**: Componente que processa um Evento_de_Domínio recebido do Event_Bus.
- **Dead_Letter_Queue**: Fila especial que armazena eventos que falharam após todas as tentativas de retry, permitindo análise posterior e reprocessamento manual.
- **Exponential_Backoff**: Estratégia de retry em que o intervalo entre tentativas cresce exponencialmente (ex: 1s, 2s, 4s, 8s, 16s).
- **Tenant**: Clínica registrada na Plataforma que opera como unidade isolada de dados e configuração.
- **SLA**: Service Level Agreement — acordo de nível de serviço que define limites aceitáveis de latência ou tempo de processamento.
- **EventEmitter2**: Módulo NestJS para comunicação in-process entre componentes, mantido para eventos não-críticos que não requerem persistência.
- **Job**: Unidade de trabalho na fila BullMQ que encapsula um Evento_de_Domínio e seus metadados (tentativas, prioridade, timestamps).
- **Observabilidade**: Capacidade de monitorar métricas de processamento de eventos, incluindo latência, taxa de falha, throughput e tamanho das filas.

## Requirements

### Requisito 1: Módulo Central do Event Bus Distribuído

**User Story:** Como desenvolvedor da plataforma, eu quero um módulo centralizado de event bus distribuído baseado em BullMQ, para que eventos de domínio críticos sejam processados de forma confiável mesmo em cenários de multi-instância e crash recovery.

#### Acceptance Criteria

1. THE Event_Bus SHALL prover uma abstração (`EventBusService`) com métodos `publish(eventName, payload, options)` e `subscribe(eventName, handler)` que encapsula a interação com BullMQ.
2. WHEN um Producer publica um Evento_de_Domínio via `EventBusService.publish()`, THE Event_Bus SHALL persistir o evento no Redis antes de retornar confirmação ao Producer.
3. THE Event_Bus SHALL utilizar a instância Redis já configurada no docker-compose da Plataforma (redis:7-alpine, porta 6379) sem necessidade de infraestrutura adicional.
4. WHEN a Plataforma inicializa, THE Event_Bus SHALL registrar automaticamente as filas BullMQ correspondentes aos eventos de domínio configurados.
5. THE Event_Bus SHALL suportar múltiplas instâncias da Plataforma consumindo da mesma fila, garantindo que cada evento seja processado por exatamente um Consumer (competing consumers pattern).
6. IF a conexão com Redis for perdida, THEN THE Event_Bus SHALL armazenar eventos em buffer local por até 30 segundos e tentar reconexão automática com Exponential_Backoff de intervalos 1s, 2s, 4s, 8s e 16s.
7. THE Event_Bus SHALL prefixar todas as chaves Redis com o namespace `beautygrowth:events:` para evitar colisão com outras utilizações do Redis na Plataforma.

### Requisito 2: Migração de Eventos Críticos de Domínio

**User Story:** Como desenvolvedor da plataforma, eu quero migrar os eventos críticos existentes do EventEmitter2 para o Event Bus distribuído, para que esses eventos sobrevivam a crashes e sejam processados em deployments multi-instância.

#### Acceptance Criteria

1. WHEN um novo tenant é criado, THE Event_Bus SHALL publicar o evento `tenant.created` com payload contendo `tenantId`, `timestamp` e `correlationId`, acionando os consumers de provisão de Agent Config, Knowledge Hub e Business Memory.
2. WHEN uma Identidade_da_Marca é atualizada, THE Event_Bus SHALL publicar o evento `brand.updated` com payload contendo `tenantId`, `brandId`, `action` e `timestamp`, acionando o consumer de sincronização com a Memória_de_Negócio dentro do SLA de 60 segundos.
3. WHEN uma regra de Guardrails é criada ou atualizada, THE Event_Bus SHALL publicar o evento `guardrails.changed` com payload contendo `tenantId`, `guardrailId`, `action` (created/updated/deleted) e `timestamp`, acionando o consumer de invalidação de cache.
4. WHEN uma violação de Guardrails é detectada, THE Event_Bus SHALL publicar o evento `guardrails.violation` com payload contendo `tenantId`, `agentId`, `guardrailName`, `violationType` e `timestamp` para processamento assíncrono pelo módulo de Observabilidade.
5. THE Event_Bus SHALL manter compatibilidade retroativa emitindo eventos simultaneamente via EventEmitter2 e BullMQ durante o período de transição, até que todos os consumers migrem para o Event_Bus.
6. WHEN todos os consumers de um evento específico forem migrados para o Event_Bus, THE Plataforma SHALL permitir desativar a emissão duplicada via EventEmitter2 por meio de configuração sem alteração de código.

### Requisito 3: Retry com Exponential Backoff e Dead-Letter Queue

**User Story:** Como desenvolvedor da plataforma, eu quero que eventos com falha de processamento sejam retentados automaticamente com backoff exponencial e movidos para uma dead-letter queue após esgotamento das tentativas, para que nenhum evento crítico seja perdido silenciosamente.

#### Acceptance Criteria

1. WHEN um Consumer falha ao processar um Evento_de_Domínio, THE Event_Bus SHALL agendar uma nova tentativa com Exponential_Backoff utilizando a fórmula `delay = baseDelay * 2^(tentativa - 1)` com baseDelay de 1000ms.
2. THE Event_Bus SHALL configurar o número máximo de tentativas por tipo de evento: 5 tentativas para `tenant.created`, 3 tentativas para `brand.updated`, 3 tentativas para `guardrails.changed` e 1 tentativa para `guardrails.violation`.
3. IF um Evento_de_Domínio esgota todas as tentativas de retry sem sucesso, THEN THE Event_Bus SHALL mover o evento para a Dead_Letter_Queue correspondente preservando o payload original, o histórico de erros de cada tentativa e o timestamp de cada falha.
4. THE Event_Bus SHALL expor um método `reprocessFromDLQ(eventName, jobId)` que permite reprocessar manualmente um evento específico da Dead_Letter_Queue.
5. THE Event_Bus SHALL expor um método `listDLQ(eventName, pagination)` que retorna os eventos na Dead_Letter_Queue com paginação, ordenados do mais recente ao mais antigo.
6. IF um evento é reprocessado com sucesso a partir da Dead_Letter_Queue, THEN THE Event_Bus SHALL remover o evento da Dead_Letter_Queue e registrar o reprocessamento no log de auditoria.

### Requisito 4: Filas com Prioridade por Tipo de Evento

**User Story:** Como desenvolvedor da plataforma, eu quero que eventos de domínio sejam processados com prioridades diferentes de acordo com seu impacto no negócio, para que eventos críticos de provisioning tenham precedência sobre eventos informacionais.

#### Acceptance Criteria

1. THE Event_Bus SHALL suportar 3 níveis de prioridade: alta (1), média (5) e baixa (10), onde valores menores indicam maior prioridade de processamento.
2. THE Event_Bus SHALL classificar os eventos com as seguintes prioridades padrão: `tenant.created` com prioridade alta (1), `brand.updated` com prioridade média (5), `guardrails.changed` com prioridade média (5) e `guardrails.violation` com prioridade baixa (10).
3. WHEN múltiplos eventos estão pendentes na mesma fila, THE Event_Bus SHALL processar primeiro os eventos com menor valor de prioridade (maior prioridade de negócio).
4. THE Event_Bus SHALL permitir que o Producer sobrescreva a prioridade padrão ao publicar um evento, passando o parâmetro `priority` na chamada de `publish()`.

### Requisito 5: Isolamento de Tenant no Processamento de Eventos

**User Story:** Como arquiteto da plataforma, eu quero que o processamento de eventos respeite o isolamento multi-tenant, para que um erro ou sobrecarga em um tenant não afete o processamento de eventos de outros tenants.

#### Acceptance Criteria

1. THE Event_Bus SHALL incluir o campo `tenantId` obrigatório no payload de todo Evento_de_Domínio publicado.
2. WHEN um Consumer processa um Evento_de_Domínio, THE Event_Bus SHALL configurar o contexto de tenant (`app.current_tenant`) na sessão do banco de dados antes de executar a lógica de negócio, garantindo que o RLS seja aplicado.
3. IF um Consumer falha ao processar um evento de um tenant específico, THEN THE Event_Bus SHALL garantir que o retry ocorra isoladamente sem bloquear o processamento de eventos de outros tenants.
4. THE Event_Bus SHALL incluir o `tenantId` em todos os logs e métricas relacionados ao processamento de eventos para permitir diagnóstico por tenant.
5. THE Event_Bus SHALL limitar a concorrência de processamento por tenant a no máximo 5 jobs simultâneos para evitar que um tenant monopolize os workers.

### Requisito 6: Persistência de Eventos para Auditoria e Replay

**User Story:** Como operador da plataforma, eu quero que todos os eventos de domínio processados sejam persistidos com metadados completos, para que eu possa auditar o histórico de eventos e fazer replay quando necessário.

#### Acceptance Criteria

1. WHEN um Evento_de_Domínio é processado com sucesso, THE Event_Bus SHALL persistir um registro de auditoria contendo: nome do evento, payload completo, tenantId, correlationId, timestamp de publicação, timestamp de processamento, duração do processamento e status (success).
2. WHEN um Evento_de_Domínio falha definitivamente (movido para DLQ), THE Event_Bus SHALL persistir um registro de auditoria contendo: nome do evento, payload, tenantId, correlationId, timestamp de publicação, número de tentativas, erro de cada tentativa e status (failed).
3. THE Event_Bus SHALL reter os registros de auditoria de eventos por no mínimo 90 dias antes de serem elegíveis para archival.
4. THE Event_Bus SHALL expor um método `replay(eventName, filters)` que permite republicar eventos históricos filtrados por `tenantId`, intervalo de datas e status.
5. WHEN um evento é republicado via replay, THE Event_Bus SHALL marcar o Job com metadado `isReplay: true` para que consumers possam distinguir replays de eventos originais.
6. THE Event_Bus SHALL gerar um `correlationId` único (UUID v4) para cada evento publicado, permitindo rastreamento end-to-end do evento através de todos os consumers e retries.

### Requisito 7: Observabilidade do Event Bus

**User Story:** Como operador da plataforma, eu quero monitorar o status, a latência e a taxa de falha do processamento de eventos, para que eu possa identificar gargalos e reagir a problemas antes que impactem os usuários.

#### Acceptance Criteria

1. THE Event_Bus SHALL expor métricas de processamento contendo: total de eventos publicados por tipo, total de eventos processados com sucesso por tipo, total de eventos falhados por tipo, latência média de processamento por tipo de evento (em ms) e tamanho atual de cada fila (waiting, active, delayed, failed).
2. WHEN a latência média de processamento de um tipo de evento exceder 2x o SLA configurado, THE Event_Bus SHALL emitir um alerta via log estruturado com nível WARN contendo o nome do evento, a latência média atual e o SLA configurado.
3. WHEN o tamanho de uma fila (waiting + delayed) exceder 1000 eventos pendentes, THE Event_Bus SHALL emitir um alerta via log estruturado com nível WARN contendo o nome da fila e o total de eventos pendentes.
4. THE Event_Bus SHALL expor um endpoint HTTP `GET /events/health` que retorna o status de saúde do Event_Bus incluindo: conexão com Redis (up/down), total de filas ativas, total de workers ativos e métricas agregadas das últimas 5 minutos.
5. THE Event_Bus SHALL registrar em log estruturado (JSON) cada evento processado com os campos: eventName, tenantId, correlationId, durationMs, status (success/failed/retrying), attempt e workerInstance.

### Requisito 8: Compatibilidade com EventEmitter2 para Eventos Não-Críticos

**User Story:** Como desenvolvedor da plataforma, eu quero manter o EventEmitter2 para eventos intra-módulo não-críticos, para que eventos de baixa importância que não necessitam de persistência continuem funcionando de forma simples e com baixa latência.

#### Acceptance Criteria

1. THE Plataforma SHALL manter o EventEmitter2 ativo e funcional para eventos que não requerem entrega garantida, persistência ou processamento cross-instância.
2. THE Event_Bus SHALL fornecer um decorator `@OnDistributedEvent(eventName)` como equivalente distribuído ao `@OnEvent()` do EventEmitter2, facilitando a migração incremental de consumers.
3. WHEN um desenvolvedor registra um handler com `@OnDistributedEvent(eventName)`, THE Event_Bus SHALL registrar automaticamente o consumer no BullMQ worker correspondente ao nome do evento.
4. THE Plataforma SHALL documentar em comentário de código ou constante exportada quais eventos utilizam o Event_Bus distribuído e quais permanecem no EventEmitter2, mantendo essa lista atualizada.
5. IF um evento é configurado para emissão dual (EventEmitter2 + BullMQ), THEN THE Event_Bus SHALL garantir que a emissão no EventEmitter2 ocorra de forma síncrona no processo local e a publicação no BullMQ ocorra de forma assíncrona, sem bloquear o fluxo principal.

### Requisito 9: Configuração e Extensibilidade

**User Story:** Como desenvolvedor da plataforma, eu quero que a configuração do Event Bus seja declarativa e extensível, para que novos eventos possam ser adicionados facilmente sem alteração do core do módulo.

#### Acceptance Criteria

1. THE Event_Bus SHALL aceitar configuração declarativa de novos eventos por meio de um registro centralizado (objeto TypeScript exportado) contendo: nome do evento, prioridade padrão, número de retries, TTL do job, concorrência máxima e flag de emissão dual.
2. WHEN um novo evento é adicionado ao registro centralizado, THE Event_Bus SHALL criar automaticamente a fila BullMQ correspondente na inicialização da Plataforma sem necessidade de código adicional.
3. THE Event_Bus SHALL validar o payload de cada evento publicado contra um schema definido (usando class-validator ou tipo TypeScript com validação runtime), retornando erro descritivo ao Producer se o payload for inválido.
4. THE Event_Bus SHALL suportar configuração de concorrência por fila, permitindo que filas de alto throughput (como `guardrails.violation`) processem mais jobs simultaneamente que filas de baixa frequência.
5. WHEN a variável de ambiente `EVENT_BUS_ENABLED` está definida como `false`, THE Event_Bus SHALL operar em modo fallback publicando todos os eventos exclusivamente via EventEmitter2, permitindo execução local sem Redis.
