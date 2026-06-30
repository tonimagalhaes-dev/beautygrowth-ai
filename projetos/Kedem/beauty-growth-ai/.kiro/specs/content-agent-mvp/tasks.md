# Implementation Plan: Content Agent MVP

## Overview

Implementação do primeiro agente funcional de IA (Content Agent) na plataforma BeautyGrowth AI. Este plano cobre: módulo NestJS (controller, service, DTOs, validação), definição do workflow no LangGraph (Python) com 5 nós, templates de prompt, seed data de guardrails e model config, integração ponta-a-ponta via gRPC, lógica de refinamento e testes (unit + property-based).

As linguagens são TypeScript (NestJS) e Python (LangGraph). PBT usa fast-check (TypeScript) e hypothesis (Python).

## Tasks

- [x] 1. Criar ContentAgentModule no NestJS (DTOs, validação e controller)
  - [x] 1.1 Criar DTOs e validação do briefing
    - Criar `src/modules/content-agent/dto/generate-briefing.dto.ts` com class-validator decorators
    - Campos: tema (obrigatório, @IsNotEmpty, @MaxLength(500)), procedimento (opcional, @IsUUID), publicoAlvoOverride (opcional, @MaxLength(300)), redesSociais (obrigatório, @ArrayMinSize(1), @IsIn(['instagram','facebook','tiktok'])), idioma (opcional, default 'pt-BR')
    - Criar `src/modules/content-agent/dto/refine-briefing.dto.ts` com executionId (@IsUUID) e instrucoes (@MaxLength(500))
    - Criar `src/modules/content-agent/dto/content-agent-response.dto.ts` com interfaces de retorno
    - _Requirements: 1.1, 1.2, 1.3_

  - [x] 1.2 Criar ContentAgentController com endpoints REST
    - Criar `src/modules/content-agent/content-agent.controller.ts`
    - Endpoint `POST /api/content-agent/generate` — aceita GenerateBriefingDto, retorna ContentAgentResponse
    - Endpoint `POST /api/content-agent/refine` — aceita RefineBriefingDto, retorna ContentAgentResponse
    - Extrair tenant_id e user_id do contexto de autenticação (request decorator existente)
    - Aplicar ValidationPipe com transform e whitelist
    - _Requirements: 1.1, 1.4, 5.1_

  - [x] 1.3 Criar ContentAgentService com lógica de orquestração
    - Criar `src/modules/content-agent/services/content-agent.service.ts`
    - Método `generate(dto, tenantId, userId)`: valida, gera execution_id, monta payload gRPC, chama LangGraphClientService via circuit breaker, transforma resposta
    - Método `refine(dto, tenantId, userId)`: valida limite de refinamentos (max 5), carrega version anterior, monta payload com is_refinement=true, delega ao LangGraph
    - Tratar erros gRPC mapeando para códigos HTTP corretos (412, 422, 429, 503, 504)
    - _Requirements: 1.4, 3.7, 5.1, 5.2, 5.4, 5.5, 6.3, 6.4_

  - [x] 1.4 Registrar ContentAgentModule no AppModule
    - Criar `src/modules/content-agent/content-agent.module.ts` importando providers e dependências
    - Importar LangGraphClientModule, CircuitBreakerModule
    - Registrar no AppModule
    - _Requirements: 1.1_

  - [ ]* 1.5 Escrever property test para validação do briefing (TypeScript)
    - **Property 1: Validação de briefing rejeita entradas inválidas**
    - Usar fast-check para gerar briefings com tema vazio/whitespace/excedendo 500 chars, redesSociais vazia, publicoAlvoOverride > 300 chars
    - Validar que todos são rejeitados com 422 e nenhuma chamada gRPC ocorre
    - **Validates: Requirements 1.2, 1.3**

  - [ ]* 1.6 Escrever unit tests para DTOs e controller
    - Testar tema vazio → 422, redes vazia → 422, tema 501 chars → 422
    - Testar briefing válido → chamada ao service
    - Testar extração de tenant_id e user_id do contexto auth
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [x] 2. Implementar workflow Content Agent no LangGraph (Python)
  - [x] 2.1 Criar schema de estado e estrutura do workflow
    - Criar `langgraph-service/src/workflows/__init__.py`
    - Criar `langgraph-service/src/workflows/content_agent.py` com `ContentAgentState` TypedDict conforme design
    - Implementar `build_content_agent_graph()` que monta o StateGraph com 5 nós e conditional edge
    - Registrar workflow no Agent Router para agent_type='content'
    - _Requirements: 3.1, 3.4_

  - [x] 2.2 Implementar nó `load_context`
    - Carregar Business Memory do tenant via acesso PostgreSQL (RLS com tenant_id)
    - Busca semântica no Qdrant (Knowledge Hub) com tema + procedimento, max 5 chunks
    - Se refinamento: carregar execução original da Agent Memory
    - Se tom_de_voz ausente na Business Memory → levantar erro com código 412
    - Se publicoAlvoOverride presente → substituir público-alvo da Business Memory
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 2.3 Implementar nó `resolve_prompt`
    - Buscar prompt template no Prompt Registry (PostgreSQL) para agent_type='content'
    - Substituir variáveis: {{nome_clinica}}, {{tom_de_voz}}, {{especialidades}}, {{publico_alvo}}, {{tema}}, {{procedimento}}, {{redes_sociais}}, {{knowledge_context}}, {{idioma}}
    - Montar system_prompt + task_prompt no state
    - _Requirements: 3.4_

  - [x] 2.4 Implementar nó `generate_content`
    - Selecionar modelo via Model Registry (primário + fallback)
    - Chamar LLM com system_prompt + task_prompt
    - Parsear resposta: legendas por rede (respeitando limites de caracteres), 5-15 hashtags, sugestões visuais por rede
    - Registrar token usage (input + output) e model_id no state
    - Marcar used_fallback se modelo fallback utilizado
    - _Requirements: 3.1, 3.2, 3.3, 3.5, 3.6, 3.7_

  - [x] 2.5 Implementar nó `validate_guardrails`
    - Validar legendas contra guardrails do sistema (ANVISA/CFM) e guardrails do tenant
    - Se violação: incrementar guardrail_attempt, registrar violação
    - Implementar conditional edge `should_retry_or_output`:
      - Sem violação → persist_and_output
      - Violação e attempt < 3 → generate_content (retry)
      - Violação e attempt >= 3 → END (blocked, código 422)
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [x] 2.6 Implementar nó `persist_and_output`
    - Persistir na Agent Memory (short-term): briefing, contexto, conteúdo gerado, version
    - Registrar na Observabilidade: trace_id, execution_id, duração, tokens, status, violações
    - Serializar resposta final no campo output do state
    - Se persistência falhar → retornar conteúdo normalmente + warning log
    - _Requirements: 6.1, 6.2, 6.5_

  - [ ]* 2.7 Escrever property test para guardrail retry limitado (Python)
    - **Property 3: Guardrail retry é limitado a 3 tentativas**
    - Usar hypothesis para gerar sequências de guardrail pass/fail; validar que regenerações ≤ 3
    - **Validates: Requirements 4.2, 4.3**

  - [ ]* 2.8 Escrever property test para estrutura do output (Python)
    - **Property 2: Estrutura do output respeita invariantes por rede**
    - Gerar briefings válidos com hypothesis; validar legendas dentro dos limites, 5-15 hashtags, formatos visuais corretos
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.7**

  - [ ]* 2.9 Escrever property test para precondição tom_de_voz (Python)
    - **Property 8: Precondição de identidade da marca**
    - Gerar tenants com/sem tom_de_voz; validar que sem tom_de_voz → erro 412 antes de qualquer token de LLM
    - **Validates: Requirements 2.4**

- [x] 3. Checkpoint — Validar workflow LangGraph isoladamente
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Criar prompt templates e seed data
  - [x] 4.1 Criar seed SQL para prompt templates do Content Agent
    - Inserir system prompt template para agent_type='content' no Prompt Registry
    - Inserir task prompt template com variáveis substituíveis
    - Incluir variáveis: {{nome_clinica}}, {{tom_de_voz}}, {{especialidades}}, {{publico_alvo}}, {{tema}}, {{procedimento}}, {{redes_sociais}}, {{knowledge_context}}, {{idioma}}
    - _Requirements: 3.4_

  - [x] 4.2 Criar seed SQL para guardrails padrão do Content Agent
    - Inserir guardrails de sistema: proibição de promessas de resultado, diagnósticos, prescrições, alegações de saúde não autorizadas
    - Definir padrões regex e keywords para detecção
    - _Requirements: 4.1_

  - [x] 4.3 Criar seed SQL para configuração de modelo (Model Registry)
    - Inserir configuração de modelo primário para o Content Agent (ex: gpt-4o)
    - Inserir configuração de modelo fallback (ex: gpt-4o-mini)
    - Associar ao agent_type='content'
    - _Requirements: 3.5, 3.6_

- [ ] 5. Implementar integração NestJS ↔ LangGraph para Content Agent
  - [x] 5.1 Mapear payload do ContentAgentService para mensagem gRPC ExecuteWorkflow
    - Converter GenerateBriefingDto → ExecuteWorkflowRequest com agent_id, tenant_id, input (JSON do briefing), config
    - Converter RefineBriefingDto → ExecuteWorkflowRequest com metadata de refinamento (is_refinement, original_execution_id, version, instrucoes)
    - Propagar trace_id, tenant_id e user_id no gRPC metadata
    - _Requirements: 1.4, 5.1, 5.4_

  - [x] 5.2 Mapear resposta gRPC ExecuteWorkflowResponse para ContentAgentResponse
    - Extrair legendas, hashtags, sugestões visuais do campo output (JSON)
    - Mapear status: COMPLETED → 'draft', guardrail_blocked → 'guardrail_blocked'
    - Incluir execution_id, modelo, tokens, duração, flag de fallback
    - Tratar blocked_reason → retornar 422
    - _Requirements: 3.7, 4.3_

  - [x] 5.3 Implementar lógica de refinamento no ContentAgentService
    - Consultar Agent Memory para contar refinamentos existentes por execution_id
    - Se count >= 5 → rejeitar com 429
    - Se execution_id não pertence ao tenant → retornar 404 (sem leak)
    - Incrementar version no payload enviado ao LangGraph
    - _Requirements: 5.1, 5.2, 5.4, 5.5_

  - [ ]* 5.4 Escrever property test para refinamento preserva execution_id e incrementa version (TypeScript)
    - **Property 4: Refinamento preserva execution_id e incrementa version monotonicamente**
    - Usar fast-check para gerar sequências de refinamento; validar execution_id constante e version estritamente crescente
    - **Validates: Requirements 5.1, 5.4**

  - [ ]* 5.5 Escrever property test para limite de 5 refinamentos (Python)
    - **Property 5: Limite de 5 refinamentos por execução**
    - Usar hypothesis para gerar N refinamentos; validar que a partir do 6º → erro 429
    - **Validates: Requirements 5.2**

  - [ ]* 5.6 Escrever property test para isolamento de tenant (TypeScript)
    - **Property 6: Isolamento de tenant no acesso a dados**
    - Usar fast-check para gerar pares de tenants distintos; validar que refinamento com execution_id de outro tenant → 404
    - **Validates: Requirements 2.1, 2.2, 5.5**

- [x] 6. Checkpoint — Validar integração end-to-end
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implementar observabilidade e testes finais
  - [x] 7.1 Implementar registro completo de observabilidade no workflow
    - Garantir que toda execução (sucesso, guardrail_blocked, erro) registra: trace_id, execution_id, tenant_id, user_id, duração_ms, tokens (input + output), modelo, violações, status final
    - Implementar no nó persist_and_output e nos handlers de erro
    - _Requirements: 6.1, 6.2_

  - [ ]* 7.2 Escrever property test para observabilidade completa (Python)
    - **Property 7: Toda execução registra observabilidade completa**
    - Usar hypothesis para gerar execuções com diferentes outcomes; validar que todos os campos obrigatórios estão presentes no registro
    - **Validates: Requirements 4.4, 6.2**

  - [ ]* 7.3 Escrever unit tests de integração end-to-end
    - Happy path: briefing válido → geração → resposta draft com todos campos
    - Guardrail retry: conteúdo viola → regenera → sucesso na 2ª tentativa
    - Guardrail blocked: viola 3x → 422
    - Refinamento e2e: gera → refina → version incrementa → 5x → 429
    - Fallback model: primário indisponível → fallback → usedFallback=true
    - _Requirements: 3.7, 4.2, 4.3, 5.2, 3.6_

- [x] 8. Checkpoint Final — Validação completa
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marcadas com `*` são opcionais e podem ser ignoradas para um MVP mais rápido
- Cada task referencia requisitos específicos para rastreabilidade
- Checkpoints garantem validação incremental
- Property tests validam propriedades universais de corretude (8 propriedades definidas no design)
- Unit tests validam exemplos específicos e edge cases
- O projeto utiliza TypeScript (NestJS) com fast-check e Python (LangGraph) com hypothesis para PBT
- **DEPENDÊNCIA EXTERNA:** Antes de executar este spec, as seguintes tasks do spec `langgraph-orchestration` DEVEM estar concluídas:
  - Task 10.2: Streaming client gRPC no NestJS
  - Task 12.1: Refatorar AgentExecutionService para delegar ao LangGraph
  - Task 12.2: Registrar módulo gRPC no AgentExecutionModule
  - Tasks 13.1-13.2: Multi-tenant end-to-end no LangGraph
  - Task 14.1: Persistência de métricas de execução
- O NestJS foundation está COMPLETO (todos os módulos base existem)
- O LangGraph Service está parcialmente implementado (State Manager, Workflow Engine, Agent Router, gRPC Server já existem)
- Este spec foca EXCLUSIVAMENTE na lógica do Content Agent workflow, NÃO na infraestrutura LangGraph

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "4.1", "4.2", "4.3"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.2", "2.3"] },
    { "id": 2, "tasks": ["1.4", "1.5", "1.6", "2.4", "2.5"] },
    { "id": 3, "tasks": ["2.6", "2.7", "2.8", "2.9"] },
    { "id": 4, "tasks": ["5.1", "5.2", "5.3"] },
    { "id": 5, "tasks": ["5.4", "5.5", "5.6"] },
    { "id": 6, "tasks": ["7.1"] },
    { "id": 7, "tasks": ["7.2", "7.3"] }
  ]
}
```
