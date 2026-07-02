# Implementation Plan: LangGraph Orchestration Layer

## Overview

Implementação da camada de orquestração LangGraph como microsserviço Python separado, com comunicação gRPC a partir do NestJS existente. O plano segue uma abordagem incremental: primeiro a infraestrutura (protobuf, Docker, estrutura do projeto Python), depois os componentes core (State Manager, Workflow Engine, Agent Router), em seguida a integração no NestJS (gRPC client, circuit breaker, fallback), e finalmente streaming, cancelamento e health checks.

## Tasks

- [ ] 1. Configurar infraestrutura do projeto LangGraph e definição Protobuf
  - [x] 1.1 Criar schema Protobuf do AgentOrchestrationService
    - Criar arquivo `proto/agent_orchestration.proto` com todas as mensagens e RPCs definidos no design (ExecuteWorkflow, ExecuteWorkflowStream, GetExecutionState, CancelExecution, HealthCheck)
    - Incluir enums `ExecutionStatus` e `ServiceStatus`, mensagens `StepResult`, `WorkflowStreamEvent`, `TokenUsage`, etc.
    - _Requirements: 1.1, 1.2_

  - [x] 1.2 Criar estrutura do projeto Python (LangGraph Service)
    - Criar diretório `langgraph-service/` com estrutura: `src/`, `src/core/`, `src/grpc/`, `src/models/`, `tests/`
    - Criar `pyproject.toml` com dependências: langgraph, langchain-core, grpcio, redis, asyncpg, pydantic, opentelemetry-sdk, hypothesis (dev)
    - Criar `Dockerfile` multi-stage para o serviço Python
    - _Requirements: 8.1_

  - [x] 1.3 Configurar compilação Protobuf para Python e TypeScript
    - Adicionar script de compilação protobuf gerando stubs Python (grpcio-tools) e TypeScript (ts-proto)
    - Gerar arquivos `*_pb2.py`, `*_pb2_grpc.py` para Python e tipos TypeScript correspondentes
    - _Requirements: 1.1, 1.2_

  - [x] 1.4 Criar migration PostgreSQL para tabelas `workflow_executions` e `workflow_definitions`
    - Criar migration TypeORM no NestJS com as tabelas conforme definidas no design
    - Incluir RLS policies, índices e constraints de validação
    - _Requirements: 4.3, 5.2, 9.1_

  - [x] 1.5 Atualizar `docker-compose.yml` para incluir o serviço LangGraph
    - Adicionar service `langgraph` com build context, variáveis de ambiente, portas gRPC e dependências (redis, postgres)
    - _Requirements: 8.1_

- [ ] 2. Implementar State Manager (Python)
  - [x] 2.1 Implementar `StateManager` com Redis para estado em voo
    - Criar classe `RedisStateManager` implementando a interface `StateManager` do design
    - Implementar `create_state` com TTL configurável (padrão 3600s) e padrão de chave `tenant:{tenant_id}:exec:{execution_id}`
    - Implementar `get_state` retornando `None` se chave não encontrada
    - Implementar `update_state` com operação atômica via MULTI/EXEC e reset de TTL
    - _Requirements: 4.1, 4.2, 4.4, 4.5, 4.6, 4.8_

  - [x] 2.2 Implementar persistência de estado final no PostgreSQL
    - Implementar `persist_final_state` gravando na tabela `workflow_executions` com campos: status, steps, tokens_input, tokens_output, duration_ms, completed_at
    - Implementar retry (até 3 tentativas) em caso de falha na persistência
    - _Requirements: 4.3, 4.9_

  - [x] 2.3 Implementar tratamento de erros no State Manager
    - Se Redis indisponível: registrar erro com trace_id e propagar falha sem comprometer PostgreSQL
    - Se PostgreSQL falha: retry com backoff e logging de execution_id + trace_id para recuperação
    - _Requirements: 4.7, 4.9_

  - [ ]* 2.4 Escrever property test para preservação de estado no merge
    - **Property 8: Preservação de Estado no Merge**
    - Gerar estados iniciais e state_updates arbitrários com hypothesis; validar que campos não presentes no update permanecem inalterados
    - **Validates: Requirements 4.5**

  - [ ]* 2.5 Escrever property test para isolamento de tenant no State Manager
    - **Property 2: Isolamento de Tenant no State Manager**
    - Gerar pares de tenant_ids distintos; validar que operações de um tenant nunca retornam dados de outro (Redis e PostgreSQL)
    - **Validates: Requirements 5.1, 5.3, 5.4, 4.4**

- [ ] 3. Implementar Workflow Engine (Python)
  - [x] 3.1 Implementar construção de grafo a partir de `WorkflowDefinition`
    - Criar função `build_agent_graph` que converte `WorkflowDefinition` em `StateGraph` compilado do LangGraph
    - Implementar resolução de funções de nó por tipo: `llm_call`, `tool_call`, `condition`, `parallel`
    - Validar que o grafo é acíclico (DAG válido), possui pelo menos um nó, e entry_point referencia nó existente
    - _Requirements: 3.2, 3.4, 3.5_

  - [x] 3.2 Implementar execução de workflow com timeout e recursion_limit
    - Criar classe `LangGraphWorkflowEngine` implementando interface `WorkflowEngine`
    - Implementar `execute` com `asyncio.wait_for` para timeout e `recursion_limit` via config do LangGraph
    - Registrar cada nó executado em `steps` com `StepResult` (node_id, node_type, output, duration_ms, status)
    - _Requirements: 3.1, 3.6, 3.7, 3.9, 10.1_

  - [x] 3.3 Implementar execução paralela de nós independentes
    - Quando dois ou mais nós não possuem arestas de dependência entre si, executá-los em paralelo via `asyncio.gather`
    - Aguardar conclusão de todos antes de prosseguir para nós dependentes
    - _Requirements: 3.3_

  - [x] 3.4 Implementar tratamento de falha por nó e guardrails
    - Se um nó falha: interromper caminho afetado, registrar nó com status FAILED e mensagem de erro no StepResult
    - Se guardrail violado: interromper workflow, registrar violações em `guardrail_violations`, retornar `blocked_reason`
    - Garantir mensagem de erro limitada a 1024 caracteres
    - _Requirements: 3.8, 10.2, 10.3_

  - [x] 3.5 Implementar contabilização de tokens por nó
    - Para nós `llm_call`: registrar input_tokens e output_tokens obtidos do LLM provider
    - Para nós `tool_call`, `condition`, `parallel`: registrar tokens = 0
    - Se LLM provider não retorna token usage: registrar 0 e emitir warning com trace_id e node_id
    - Agregar totais no `ExecuteWorkflowResponse`
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

  - [ ]* 3.6 Escrever property test para DAG válido (sem ciclos)
    - **Property 4: DAG Válido - Sem Ciclos**
    - Gerar WorkflowDefinitions aleatórias com hypothesis; validar que grafos aceitos são acíclicos
    - **Validates: Requirements 3.5**

  - [ ]* 3.7 Escrever property test para completude de execução
    - **Property 5: Completude de Execução**
    - Para workflows executados com sucesso, validar que todos os nós no caminho foram visitados e registrados em steps, e output é não-vazio
    - **Validates: Requirements 3.6**

  - [ ]* 3.8 Escrever property test para consistência de tokens
    - **Property 7: Consistência de Tokens**
    - Para qualquer execução completa, validar que soma de tokens nos StepResults individuais = tokens_used total
    - **Validates: Requirements 11.1, 11.2**

- [x] 4. Checkpoint - Verificar serviço Python
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implementar Agent Router (Python)
  - [x] 5.1 Implementar resolução de workflow por agent_id e tenant_id
    - Criar classe `PostgresAgentRouter` implementando interface `AgentRouter`
    - Consultar `agent_configs` para obter `agent_type`, depois `workflow_definitions` para workflow ativo
    - Implementar priorização: workflow específico de tenant tem precedência sobre global (tenant_id IS NULL)
    - Se múltiplas versões ativas existem: selecionar maior `version`
    - _Requirements: 9.1, 9.2, 9.3_

  - [x] 5.2 Implementar tratamento de erros no Agent Router
    - Se nenhum workflow ativo encontrado: retornar erro com agent_id e tenant_id na mensagem
    - Se agent_id não existe em agent_configs: retornar erro indicando agente não encontrado
    - _Requirements: 9.4, 9.5_

  - [ ]* 5.3 Escrever property test para priorização de workflow por tenant
    - **Property 9: Priorização de Workflow por Tenant**
    - Gerar cenários com workflow global + específico de tenant; validar que o específico sempre é selecionado
    - **Validates: Requirements 9.2**

- [ ] 6. Implementar gRPC Server no LangGraph Service (Python)
  - [x] 6.1 Implementar servidor gRPC com handlers para todos os RPCs
    - Criar classe `AgentOrchestrationServicer` implementando o service protobuf gerado
    - Implementar handler `ExecuteWorkflow` integrando Agent Router + Workflow Engine + State Manager
    - Implementar handler `GetExecutionState` consultando State Manager
    - _Requirements: 3.1, 4.1_

  - [x] 6.2 Implementar validação de tenant_id no metadata gRPC
    - Extrair `x-tenant-id`, `x-trace-id`, `x-user-id` do metadata gRPC em cada chamada
    - Rejeitar chamadas sem tenant_id ou com tenant_id em formato inválido (não UUID) com erro INVALID_ARGUMENT
    - Validar que tenant_id do metadata corresponde ao tenant_id do payload
    - _Requirements: 5.5, 5.6, 5.7_

  - [x] 6.3 Implementar Health Check RPC
    - Verificar conectividade com Redis e PostgreSQL (timeout 2s por dependência)
    - Retornar SERVICE_STATUS_SERVING se ambas disponíveis, SERVICE_STATUS_NOT_SERVING caso contrário
    - Incluir `version` e `details` (mapa com status de cada dependência)
    - Responder em no máximo 500ms
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [ ] 7. Implementar gRPC Client no NestJS (TypeScript)
  - [x] 7.1 Criar `LangGraphClientService` com pool de conexões gRPC
    - Implementar interface `ILangGraphClient` conforme design
    - Configurar pool de conexões (min: 1, max: 10) reutilizáveis
    - Propagar `tenant_id`, `trace_id` e `user_id` como metadata gRPC em todas as chamadas
    - Configurar timeout de 30s por chamada
    - _Requirements: 1.1, 1.3, 1.5, 1.7_

  - [x] 7.2 Implementar serialização/deserialização protobuf no client
    - Serializar requests em formato protobuf conforme schema do AgentOrchestrationService
    - Deserializar respostas em objetos TypeScript correspondentes (ExecuteWorkflowResponse, ExecutionState, etc.)
    - _Requirements: 1.2, 1.4_

  - [x] 7.3 Implementar tratamento de erros gRPC no client
    - Para erros UNAVAILABLE, DEADLINE_EXCEEDED ou deserialização: retornar erro tipado com código gRPC, mensagem e trace_id
    - Em timeout: encerrar chamada e propagar erro sem manter conexão pendente
    - _Requirements: 1.6, 1.7_

  - [ ]* 7.4 Escrever property test para round-trip de serialização protobuf
    - **Property 1: Round-trip de Serialização Protobuf**
    - Gerar ExecuteWorkflowRequest e ExecuteWorkflowResponse arbitrários com fast-check; validar deep equality após serialização/deserialização
    - **Validates: Requirements 1.4**

- [x] 8. Implementar Circuit Breaker e Fallback (TypeScript)
  - [x] 8.1 Implementar `CircuitBreakerService` com transições de estado
    - Implementar interface `ICircuitBreaker` conforme design
    - Estados: CLOSED, OPEN, HALF_OPEN com transições válidas conforme requisito 2.7
    - Configuração: failureThreshold=5, successThreshold=3, timeout=30000ms, resetTimeout=60000ms
    - Em CLOSED: chamada com sucesso reseta contador de falhas; falhas incrementam contador
    - Em OPEN: redirecionar para fallback; após resetTimeout, transicionar para HALF_OPEN
    - Em HALF_OPEN: permitir uma chamada teste; sucesso incrementa successCount, falha volta para OPEN
    - _Requirements: 2.1, 2.3, 2.4, 2.5, 2.7, 2.8, 2.9_

  - [x] 8.2 Implementar `FallbackHandler` para pipeline local simplificado
    - Chamar LLM diretamente sem passar pelo LangGraph Service
    - Retornar resposta com flag `usedFallback=true`
    - Não produzir efeitos colaterais no LangGraph Service
    - _Requirements: 2.2, 2.6_

  - [ ]* 8.3 Escrever property test para transições válidas do Circuit Breaker
    - **Property 3: Circuit Breaker - Transições Válidas**
    - Gerar sequências arbitrárias de sucesso/falha com fast-check; validar que apenas transições válidas ocorrem
    - **Validates: Requirements 2.1, 2.3, 2.4, 2.5, 2.7**

  - [ ]* 8.4 Escrever property test para idempotência de fallback
    - **Property 6: Idempotência de Fallback**
    - Com circuit breaker OPEN, validar que fallback sempre retorna resultado com usedFallback=true e não tenta contatar LangGraph
    - **Validates: Requirements 2.2, 2.6**

- [x] 9. Checkpoint - Verificar integração NestJS ↔ LangGraph
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Implementar Streaming de Resultados Parciais
  - [x] 10.1 Implementar handler `ExecuteWorkflowStream` no gRPC server (Python)
    - Emitir eventos `WorkflowStreamEvent` via stream gRPC server-side na ordem cronológica
    - Emitir `StepStarted` ao iniciar nó, `StepCompleted` ao completar, `TokenGenerated` durante LLM
    - Emitir `WorkflowCompleted` ou `WorkflowError` como último evento e fechar stream
    - Se `enable_streaming=false`: emitir apenas evento terminal
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

  - [x] 10.2 Implementar consumo de stream gRPC no NestJS client
    - Implementar `executeWorkflowStream` retornando `AsyncIterable<WorkflowStreamEvent>`
    - Se conexão interrompida: LangGraph continua execução e persiste resultado para consulta posterior
    - _Requirements: 6.8_

- [x] 11. Implementar Cancelamento de Execução
  - [x] 11.1 Implementar handler `CancelExecution` no gRPC server (Python)
    - Interromper execução no nó atual e atualizar status para CANCELLED
    - Persistir estado parcial com steps completados, current_node e duration_ms
    - Se execução já concluída: retornar success=false com mensagem indicando status atual
    - Se execution_id não existe ou não pertence ao tenant: retornar success=false sem revelar existência para outro tenant
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

- [x] 12. Integrar AgentExecutionModule do NestJS com gRPC Client
  - [x] 12.1 Refatorar `AgentExecutionService` para delegar ao LangGraph via gRPC
    - Modificar o service existente para usar `LangGraphClientService` em vez de execução local
    - Integrar circuit breaker na cadeia de chamadas
    - Manter interface pública do controller inalterada
    - _Requirements: 1.1, 2.2_

  - [x] 12.2 Registrar módulo gRPC e dependências no `AgentExecutionModule`
    - Adicionar `LangGraphClientService`, `CircuitBreakerService` e `FallbackHandler` como providers
    - Configurar variáveis de ambiente para host/porta do LangGraph e configuração do circuit breaker
    - _Requirements: 1.5_

- [x] 13. Implementar isolamento multi-tenant end-to-end
  - [x] 13.1 Implementar validação de tenant cross-cutting no LangGraph Service
    - Interceptor gRPC que extrai e valida tenant_id em todas as chamadas
    - Rejeitar com PERMISSION_DENIED se tenant_id do metadata diverge do payload
    - Registrar tentativas de acesso cross-tenant no audit_logs
    - _Requirements: 5.4, 5.6, 5.7_

  - [x] 13.2 Implementar RLS e set de session variable no acesso ao PostgreSQL
    - Antes de cada query, setar `app.current_tenant` via `SET LOCAL` na transação
    - Garantir que RLS policies estão ativas nas tabelas workflow_executions e workflow_definitions
    - _Requirements: 5.2_

- [x] 14. Implementar persistência e métricas de execução
  - [x] 14.1 Garantir que toda execução (sucesso ou falha) persiste estado final e métricas
    - Toda execução com status terminal (COMPLETED, FAILED, CANCELLED, TIMEOUT) deve gravar no PostgreSQL
    - Registrar duration_ms e tokens_used (input + output) em todas as execuções
    - Se persistência falha: logar com trace_id e execution_id, retornar FAILED com indicação
    - _Requirements: 10.4, 10.5, 11.3_

- [ ] 15. Checkpoint Final - Validação completa
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marcadas com `*` são opcionais e podem ser ignoradas para um MVP mais rápido
- Cada task referencia requisitos específicos para rastreabilidade
- Checkpoints garantem validação incremental
- Property tests validam propriedades universais de corretude
- Unit tests validam exemplos específicos e edge cases
- O projeto utiliza TypeScript (NestJS) e Python (LangGraph) — ambas linguagens coexistem
- A comunicação entre os serviços usa gRPC com Protocol Buffers como contrato tipado

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "1.4", "1.5"] },
    { "id": 2, "tasks": ["2.1", "3.1", "5.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "3.2", "3.3", "5.2"] },
    { "id": 4, "tasks": ["2.4", "2.5", "3.4", "3.5", "5.3"] },
    { "id": 5, "tasks": ["3.6", "3.7", "3.8", "6.1"] },
    { "id": 6, "tasks": ["6.2", "6.3", "7.1"] },
    { "id": 7, "tasks": ["7.2", "7.3", "8.1"] },
    { "id": 8, "tasks": ["7.4", "8.2", "8.3", "8.4"] },
    { "id": 9, "tasks": ["10.1", "11.1", "12.1"] },
    { "id": 10, "tasks": ["10.2", "12.2", "13.1"] },
    { "id": 11, "tasks": ["13.2", "14.1"] }
  ]
}
```
