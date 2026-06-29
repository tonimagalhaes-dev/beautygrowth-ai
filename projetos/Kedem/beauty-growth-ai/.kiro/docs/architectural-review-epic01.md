# Revisão Arquitetural — BeautyGrowth AI

## Pós-EPIC 01: Platform Foundation
**Data:** 2026-06-26  
**Objetivo:** Avaliar se a arquitetura atual suporta a evolução para uma plataforma multiagentes baseada em AI-DLC

---

## 1. Estado Atual da Arquitetura

### Stack Implementada

| Camada | Tecnologia | Status |
|--------|-----------|--------|
| Backend API | NestJS (TypeScript) | ✅ Produção |
| Banco Relacional | PostgreSQL 16+ com RLS | ✅ Produção |
| Banco Vetorial | Qdrant | ✅ Produção |
| Cache/Eventos | Redis 7 | ✅ Configurado |
| Object Storage | MinIO (S3-compatible) | ✅ Produção |
| Orquestração IA | LangGraph (Python) | ⚠️ Planejado, não implementado |
| Observabilidade LLM | Langfuse | ⚠️ Planejado, não implementado |
| Observabilidade Infra | OpenTelemetry + Grafana | ⚠️ Parcialmente (logging interno) |

### Módulos Implementados (14 módulos)

```
AppModule
├── AuthModule (JWT, RBAC, Invitations)
├── ClinicModule
├── BrandModule
├── AgentConfigModule
├── AgentExecutionModule ← pipeline stub
├── AgentMemoryModule (curto/longo prazo)
├── BusinessMemoryModule
├── KnowledgeHubModule (RAG com Qdrant)
├── ModelRegistryModule (catálogo + fallback)
├── PromptRegistryModule (versionamento)
├── GuardrailsModule (sistema + tenant)
├── PrivacyModule (LGPD)
├── ObservabilityModule (audit logs)
└── IntegrationModule (event wiring)
```

---

## 2. Análise por Dimensão

### 2.1 Acoplamento entre Componentes

**Score: 7/10 — Bom, com pontos de atenção**

**Pontos Positivos:**
- Interface-driven design (`IAgentConfigService`, `IObservabilityService`, etc.)
- Comunicação event-driven via `EventEmitter2` para fluxos entre módulos
- DI nativa do NestJS com injeção por token (ex: `EMBEDDING_SERVICE`, `VECTOR_STORE_SERVICE`, `STORAGE_SERVICE`)
- `IntegrationModule` centraliza listeners cross-module

**Pontos Críticos:**

| Problema | Localização | Impacto |
|----------|-------------|---------|
| `AgentExecutionService` importa 6 services concretos diretamente | `agent-execution.service.ts` | Alto acoplamento — qualquer mudança em um service afeta o pipeline |
| `loadAgentConfig()` usa `list('__all__')` e faz filter in-memory | `agent-execution.service.ts` | Hack para contornar o filtro de tenant — viola a abstração RLS |
| `EventEmitter2` é in-process e síncrono por default | Todo o projeto | Não escala para multi-instância; perda de eventos em crash |
| GuardrailsService com cache in-memory por instância | `guardrails.service.ts` | Inconsistência em deploy multi-réplica |

**Recomendação:**
- Extrair um `AgentPipeline` interface com steps plugáveis (Strategy/Chain of Responsibility)
- Migrar eventos críticos para Redis Pub/Sub ou Bull Queue (já tem Redis configurado)
- Implementar cache distribuído para guardrails (Redis)

---

### 2.2 Extensibilidade para Novos Agentes

**Score: 8/10 — Muito bom**

**O que já funciona:**
- `AgentType` é um enum extensível no banco
- `AgentConfigService.provisionDefaults()` aceita novos tipos trivialmente
- O pipeline `AgentExecutionService.execute()` é genérico — funciona para qualquer agent type
- PromptRegistry e Guardrails se aplicam a qualquer agente sem modificação
- Knowledge Hub com category-based access já suporta permissioning por agente

**Gaps para multiagentes:**

| Gap | Descrição | Criticidade |
|-----|-----------|-------------|
| Sem conceito de "agent-to-agent" communication | Agentes operam isoladamente | Alta |
| Sem orquestrador multiagente | Falta LangGraph ou equivalente | Alta |
| Sem conceito de "workflow" ou "task delegation" | Um agente não pode invocar outro | Alta |
| Sem shared working memory | Agentes no mesmo workflow não compartilham estado | Média |
| `AgentType` é enum — requer migration para adicionar | Falta flexibilidade dinâmica | Baixa |
| Sem lifecycle hooks (pre/post execution) | Dificulta instrumentação | Média |

**Recomendação:**
- Implementar Agent Communication Protocol (message bus entre agentes)
- Definir conceito de `AgentWorkflow` com DAG de execução
- Considerar migrar `AgentType` de enum PostgreSQL para tabela (soft-extensible)
- Implementar LangGraph como orchestrator layer separado

---

### 2.3 Isolamento Multi-Tenant

**Score: 9/10 — Excelente**

**Implementação robusta:**
- RLS em todas as tabelas tenant-scoped (11 tabelas)
- `app.current_tenant` session variable no PostgreSQL
- TenantGuard extrai tenant_id do JWT antes de qualquer query
- Qdrant usa payload filter com `tenant_id` obrigatório
- Guardrails "system" usam `tenant_id = NULL` (correto)
- Audit logs são imutáveis via trigger `prevent_modification()`

**Gaps:**

| Gap | Descrição | Risco |
|-----|-----------|-------|
| Sem rate limiting por tenant | Um tenant pode consumir recursos desproporcionais | Médio |
| Sem quotas de tokens por tenant | Custo de LLM descontrolado por tenant | Alto |
| Qdrant: coleção compartilhada vs separada | Performance degrada com muitos tenants | Médio |
| Redis sem namespace por tenant | Possível colisão de keys | Baixo |
| Sem tenant billing/metering | Impossível monetizar SaaS | Alto (negócio) |

**Recomendação:**
- Implementar rate limiting com Redis (token bucket por tenant)
- Adicionar quotas de tokens configuráveis no `tenant.settings`
- Avaliar tenant-per-collection no Qdrant quando volume crescer
- Implementar namespaced keys no Redis (`tenant:{id}:*`)

---

### 2.4 Gerenciamento de Memória

**Score: 7.5/10 — Bom fundamento, precisa evoluir**

**O que existe:**

```
Business Memory (org-level, shared, read-only para agentes)
  └── Categories: brand, audience, campaigns, procedures, preferences

Agent Memory (per-agent, per-tenant)
  ├── Short-Term: últimas 50 interações
  └── Long-Term: learnings, patterns, preferences (com confidence score)
```

**Gaps para multiagentes:**

| Gap | Impacto nos Épicos Futuros |
|-----|---------------------------|
| Sem "Working Memory" compartilhada entre agentes em um workflow | EPIC 4-8: agentes não conseguem colaborar em uma task |
| Promoção curto→longo prazo é simplista (summarize oldest) | Perda de contexto importante |
| Sem mecanismo de "forgetting" inteligente | Memory bloat ao longo do tempo |
| Sem memory retrieval por relevância (só by agent_id) | Agentes não conseguem buscar memória contextual |
| Business Memory não suporta "campaign results" structured | EPIC 7-8: Ads agents precisam de métricas históricas |
| Sem episodic memory (sequência de eventos) | Perda de causalidade |

**Recomendação:**
- Adicionar `WorkflowMemory` — memória temporária compartilhada durante execução de um workflow
- Implementar retrieval semântico na Agent Memory (embeddings das interações)
- Adicionar TTL configurável por tipo de memória
- Estruturar Business Memory com schemas tipados por categoria

---

### 2.5 Prompt Registry

**Score: 8.5/10 — Sólido**

**O que funciona bem:**
- Versionamento semântico (major.minor.patch)
- Template variables com `{{variable_name}}`
- Rollback para qualquer versão
- Sandbox testing mode
- Organizado por agent_type + function (system, task, formatting)

**Gaps:**

| Gap | Descrição |
|-----|-----------|
| Sem A/B testing de prompts | Impossível otimizar iterativamente |
| Sem métricas de performance por versão de prompt | Não sabe qual prompt gera melhor output |
| Sem "prompt chains" (composição de prompts) | Workflows complexos precisam múltiplos prompts encadeados |
| Sem suporte a "dynamic system prompts" | Prompt fixo por agent_type — limita personalização por contexto |
| Sem prompt templates marketplace | Cada tenant reinventa do zero |

**Recomendação:**
- Adicionar métricas (success_rate, avg_tokens, user_satisfaction) por versão
- Implementar prompt chains para workflows multi-step
- Considerar "prompt inheritance" (base template + overrides por tenant)

---

### 2.6 Knowledge Hub (RAG)

**Score: 7.5/10 — Funcional, precisa de sofisticação**

**O que existe:**
- Pipeline: upload → S3 → extraction → chunking → embedding → Qdrant
- Semantic search com category filtering
- Tenant isolation via payload filter
- Predefined categories + custom

**Gaps para plataforma madura:**

| Gap | Impacto |
|-----|---------|
| Chunking fixo (~2000 chars) | Qualidade do RAG degradada em documentos estruturados |
| Sem re-ranking após retrieval | Relevância sub-ótima |
| Sem hybrid search (keyword + semantic) | Perde matches exatos importantes |
| Sem metadata enrichment dos chunks | Contexto pobre para o LLM |
| Sem suporte a dados estruturados (tabelas, JSON) | Procedures e protocolos ficam flat |
| Sem feedback loop (user marks useful chunks) | Não aprende o que é relevante |
| Embedding model hardcoded | Lock-in, sem upgrade path |

**Recomendação:**
- Implementar chunking adaptativo (por heading, parágrafo, tabela)
- Adicionar re-ranker (cross-encoder) pós-retrieval
- Implementar hybrid search (BM25 + semantic via Qdrant)
- Abstrair embedding model (interface já existe, mas precisa de hot-swap)

---

### 2.7 Observabilidade

**Score: 6.5/10 — Fundação ok, mas longe de production-ready**

**O que existe:**
- Audit logs imutáveis no PostgreSQL
- `trace_id` propagation manual
- Agent action logging (duration, tokens, guardrail violations)
- Alert system (error rate > 10%)
- Dashboard metrics endpoint

**O que falta (crítico):**

| Gap | Criticidade |
|-----|-------------|
| Sem OpenTelemetry integration real | Alta — traces/spans não existem |
| Sem Langfuse ou equivalente para LLM observability | Alta — não consegue debugar prompts |
| Observabilidade é "in-database" (PostgreSQL) | Médio — não escala para volume de produção |
| Sem distributed tracing (apenas trace_id manual) | Alta — impossível correlacionar em microserviços |
| Sem métricas de latência por componente do pipeline | Média — não sabe onde está o gargalo |
| Sem cost tracking real (apenas tokens, não custo $) | Média — impossível controlar budget |
| Alerts apenas por polling | Baixa — delay na detecção |

**Recomendação:**
- Integrar OpenTelemetry SDK (traces + metrics + logs)
- Deploy Langfuse self-hosted para LLM observability
- Migrar audit logs para time-series DB (InfluxDB/TimescaleDB) ou log aggregator
- Implementar cost calculation real com preços do Model Registry

---

### 2.8 Segurança

**Score: 8/10 — Muito bom para MVP**

**O que está implementado:**
- JWT com rotação (15min access, 7d refresh)
- bcrypt (rounds implícito na lib)
- Account lockout (5 attempts, 15min)
- RBAC com 3 roles + permission matrix
- RLS no banco
- Guardrails de conteúdo (no health promises, no diagnoses, etc.)
- Email verification + password reset tokens

**Gaps:**

| Gap | Risco |
|-----|-------|
| Sem rate limiting em endpoints de API | DDoS, brute force |
| Sem MFA/2FA | Risco de credential stuffing |
| JWT secret em `.env` sem rotation | Comprometimento = acesso total |
| Sem API key management para integrações externas | Meta Ads, Google Ads precisarão |
| Sem secrets management (Vault/SSM) | Secrets em plaintext |
| Sem CORS configuration visível | Potencial XSS |
| Sem input sanitization centralizada | Injection risks |
| Sem audit trail de quem alterou secrets/configs | Compliance gap |

**Recomendação:**
- Implementar rate limiting (helmet + custom guard)
- Adicionar MFA antes do EPIC 4 (agentes com acesso a APIs pagas)
- Migrar secrets para HashiCorp Vault ou AWS SSM
- Implementar API Key management module

---

## 3. Pontos que Podem Gerar Refatoração nos Próximos Épicos

### EPIC 2 — AI Governance (Alto Risco)
- `AgentExecutionService` é monolítico — precisará ser decomposto em pipeline steps
- `generateContent()` é um stub — integração com LangGraph exigirá redesign do fluxo
- EventEmitter2 in-process não suporta orquestração distribuída

### EPIC 3 — Knowledge Hub Avançado (Médio Risco)
- Chunking fixo precisará refatoração
- Embedding model tightly coupled (apesar da interface)
- Sem hybrid search — adição posterior pode exigir nova collection no Qdrant

### EPIC 4 — Executive Agent (Alto Risco)
- Sem agent-to-agent communication protocol
- Sem conceito de workflow/DAG
- Sem working memory compartilhada
- Business Memory não suporta métricas de negócio (KPIs, dashboard data)

### EPIC 5-8 — Agentes Especializados (Médio Risco)
- `AgentType` como enum requer migration para cada novo tipo
- Sem lifecycle hooks para customização por tipo de agente
- Guardrails podem precisar de regras por "domínio" (conteúdo vs ads vs atendimento)
- Sem suporte a ferramentas/tools por agente (function calling)

---

## 4. Architectural Decision Records (ADRs) Recomendados

### ADR-001: Migração do EventEmitter2 para Message Broker Distribuído
- **Status:** Proposto
- **Contexto:** EventEmitter2 é in-process, síncrono, sem persistência. Em multi-instância, eventos são perdidos.
- **Decisão Proposta:** Migrar eventos críticos para Redis Streams ou BullMQ. Manter EventEmitter2 apenas para eventos intra-módulo não-críticos.
- **Épico Impactado:** EPIC 2, 4

### ADR-002: Introdução da Camada de Orquestração LangGraph
- **Status:** Proposto
- **Contexto:** O design original prevê LangGraph (Python) via gRPC/HTTP, mas o NestJS hoje contém um stub de geração.
- **Decisão Proposta:** Implementar LangGraph como serviço separado (Python); NestJS se torna API gateway + CRUD. Comunicação via gRPC com protobuf.
- **Alternativas:** CrewAI, AutoGen, implementação custom em TypeScript.
- **Épico Impactado:** EPIC 2, 4-8

### ADR-003: Agent Communication Protocol (ACP)
- **Status:** Proposto
- **Contexto:** Agentes hoje operam isoladamente. Épicos futuros requerem colaboração (Executive → Social Media → Designer).
- **Decisão Proposta:** Definir protocolo de mensagens inter-agente (topic-based, async) com working memory compartilhada por workflow.
- **Épico Impactado:** EPIC 4-8

### ADR-004: Estratégia de Cache Distribuído
- **Status:** Proposto
- **Contexto:** GuardrailsService e PromptRegistry usam cache in-memory. Inconsistente em multi-réplica.
- **Decisão Proposta:** Migrar para Redis com invalidation por events. TTL configurável por tipo de dado.
- **Épico Impactado:** EPIC 2

### ADR-005: Migração de AgentType de Enum para Tabela
- **Status:** Proposto
- **Contexto:** Enum PostgreSQL requer migration para cada novo tipo de agente. Bloqueia adição dinâmica.
- **Decisão Proposta:** Criar tabela `agent_types` com metadados (capabilities, default_config, icon, description). Manter validação via FK.
- **Épico Impactado:** EPIC 4-8

### ADR-006: Integração OpenTelemetry + Langfuse
- **Status:** Proposto
- **Contexto:** Observabilidade atual é "in-database" sem tracing distribuído real. Impossível debugar pipelines de LLM.
- **Decisão Proposta:** Integrar OpenTelemetry SDK para traces/metrics. Deploy Langfuse self-hosted para LLM tracing (prompts, completions, cost, latency, evaluations).
- **Épico Impactado:** EPIC 2

### ADR-007: Tenant Billing & Metering
- **Status:** Proposto
- **Contexto:** Token tracking existe mas não há cálculo de custo real nem quotas enforcement. Impossível operar como SaaS.
- **Decisão Proposta:** Implementar metering service com: quotas por tenant (tokens/mês), cost calculation por execution, billing integration (Stripe), usage alerts.
- **Épico Impactado:** EPIC 2-3

### ADR-008: Knowledge Hub — Hybrid Search + Re-ranking
- **Status:** Proposto
- **Contexto:** RAG atual usa apenas busca semântica com chunking fixo. Qualidade sub-ótima para documentos estruturados.
- **Decisão Proposta:** Implementar: chunking adaptativo, BM25 + semantic hybrid search (via Qdrant sparse+dense vectors), cross-encoder re-ranking, metadata enrichment.
- **Épico Impactado:** EPIC 3

### ADR-009: Decomposição do AgentExecutionService em Pipeline Modular
- **Status:** Proposto
- **Contexto:** AgentExecutionService hoje orquestra 9 steps inline com imports diretos de 6 services. Viola SRP e dificulta extensão.
- **Decisão Proposta:** Extrair `AgentPipeline` com steps plugáveis via Chain of Responsibility. Cada step implementa `IPipelineStep.execute(context)`. Permite: hooks, conditional steps, parallel execution, custom pipelines por agent type.
- **Épico Impactado:** EPIC 2

### ADR-010: Secrets Management
- **Status:** Proposto
- **Contexto:** Secrets (JWT, API keys, DB password) estão em `.env`. Sem rotation, sem audit, sem encryption at rest.
- **Decisão Proposta:** Migrar para HashiCorp Vault (self-hosted) ou AWS Secrets Manager. Implementar rotation para JWT signing keys.
- **Épico Impactado:** EPIC 2 (pré-requisito para API integrations)

---

## 5. Avaliação de Riscos Técnicos

### Matriz de Riscos

| # | Risco | Probabilidade | Impacto | Severidade | Mitigação |
|---|-------|--------------|---------|-----------|-----------|
| R1 | AgentExecutionService monolítico não escala para multiagentes | Alta | Alto | **Crítico** | ADR-009: Pipeline modular |
| R2 | EventEmitter2 perde eventos em multi-instância | Alta | Alto | **Crítico** | ADR-001: Message broker |
| R3 | Ausência de LangGraph bloqueia EPIC 4+ | Alta | Alto | **Crítico** | ADR-002: Implementar LangGraph |
| R4 | Sem agent-to-agent protocol impossibilita workflows | Alta | Alto | **Crítico** | ADR-003: ACP |
| R5 | RAG com qualidade insuficiente para casos reais | Média | Alto | **Alto** | ADR-008: Hybrid search |
| R6 | Sem billing impede modelo SaaS | Alta | Médio | **Alto** | ADR-007: Metering |
| R7 | Observabilidade insuficiente para debugging de LLM | Alta | Médio | **Alto** | ADR-006: Langfuse |
| R8 | Secrets em plaintext = vulnerabilidade | Média | Alto | **Alto** | ADR-010: Vault |
| R9 | Cache in-memory inconsistente em multi-réplica | Média | Médio | **Médio** | ADR-004: Redis cache |
| R10 | Enum AgentType bloqueia adição dinâmica | Baixa | Médio | **Médio** | ADR-005: Tabela |
| R11 | Sem rate limiting permite abuse | Média | Médio | **Médio** | Implementar guard + Redis |
| R12 | Chunking fixo degrada RAG em docs complexos | Média | Médio | **Médio** | ADR-008 |
| R13 | Sem MFA antes de integrar APIs pagas | Baixa | Alto | **Médio** | Adicionar MFA no EPIC 2 |

### Classificação por Severidade

- **Crítico (4):** R1, R2, R3, R4 — Bloqueiam a evolução para multiagentes
- **Alto (4):** R5, R6, R7, R8 — Impactam qualidade, operação ou segurança
- **Médio (5):** R9, R10, R11, R12, R13 — Impactam eficiência mas têm workarounds

---

## 6. Roadmap de Resolução Recomendado

### Antes do EPIC 2 (pre-requisitos)
1. ✅ ADR-009 — Decomposição do AgentExecutionService em pipeline modular
2. ✅ ADR-001 — Migrar eventos críticos para BullMQ/Redis Streams
3. ✅ ADR-004 — Cache distribuído (Redis) para Guardrails e Prompts
4. ✅ ADR-006 — Integrar OpenTelemetry + Langfuse

### Durante o EPIC 2 (AI Governance)
5. ✅ ADR-002 — Implementar LangGraph como serviço separado
6. ✅ ADR-003 — Definir Agent Communication Protocol
7. ✅ ADR-005 — Migrar AgentType para tabela

### Durante o EPIC 3 (Knowledge Hub Avançado)
8. ✅ ADR-008 — Hybrid Search + Re-ranking + Chunking adaptativo

### Antes do EPIC 4 (pré-requisito para APIs externas)
9. ✅ ADR-010 — Secrets Management
10. ✅ ADR-007 — Tenant Billing & Metering

---

## 7. Conclusão

A arquitetura do EPIC 01 é uma **base sólida e bem projetada** para a fundação de uma plataforma multi-tenant. As decisões de RLS, interface-driven design, event-driven integration, e separação em módulos coesos foram acertadas.

No entanto, a evolução para **multiagentes com AI-DLC** requer **refatorações planejadas** nos seguintes eixos:

1. **Orquestração** — O gap mais crítico. O monólito NestJS precisa de um orchestrator externo (LangGraph) para suportar workflows multi-agente.
2. **Comunicação** — Agentes precisam de um protocolo de comunicação e working memory compartilhada.
3. **Observabilidade** — A stack atual (PostgreSQL audit logs) não suporta o volume e a granularidade necessários para debugging de LLM pipelines.
4. **Resiliência** — EventEmitter2 in-process e cache in-memory são single points of failure em produção.

**Veredicto:** Aprovar início do EPIC 2, desde que os ADRs 001, 004, 006 e 009 sejam implementados como pré-requisito (estimativa: 1-2 sprints de refatoração).
