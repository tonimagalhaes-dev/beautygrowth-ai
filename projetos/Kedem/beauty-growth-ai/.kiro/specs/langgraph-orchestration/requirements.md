# Requirements Document

## Introduction

Este documento define os requisitos para a camada de orquestração LangGraph — um microsserviço Python separado responsável pela execução de workflows de agentes baseados em grafos direcionados acíclicos (DAG). O NestJS existente atua como API gateway e CRUD, delegando a execução de pipelines de IA para o serviço LangGraph via gRPC com Protocol Buffers. O sistema mantém isolamento multi-tenant, fallback gracioso via circuit breaker, gerenciamento de estado distribuído (Redis + PostgreSQL), suporte a streaming e cancelamento de execuções.

## Glossary

- **LangGraph_Service**: Microsserviço Python responsável pela execução de workflows de agentes baseados em grafos (DAG)
- **NestJS_Gateway**: Aplicação NestJS existente que atua como API gateway, roteando requests para o LangGraph_Service via gRPC
- **Circuit_Breaker**: Componente de resiliência que monitora falhas na comunicação com o LangGraph_Service e ativa fallback automático
- **State_Manager**: Componente responsável pelo gerenciamento de estado de workflows usando Redis (em voo) e PostgreSQL (persistência)
- **Workflow_Engine**: Motor de execução de grafos baseado na API do LangGraph que processa DAGs de agentes
- **Agent_Router**: Componente que resolve qual workflow executar baseado na configuração do agente
- **gRPC_Client**: Cliente no NestJS para comunicação com o LangGraph_Service via Protocol Buffers
- **Fallback_Handler**: Componente que executa pipeline simplificado local quando o LangGraph_Service está indisponível
- **DAG**: Grafo Direcionado Acíclico que define o fluxo de execução de um workflow
- **Tenant**: Entidade organizacional que representa um cliente isolado no sistema multi-tenant
- **Execution**: Uma instância de execução de um workflow, com estado rastreável e resultado persistido

## Requirements

### Requisito 1: Comunicação gRPC entre NestJS e LangGraph

**User Story:** Como desenvolvedor, quero que o NestJS se comunique com o LangGraph Service via gRPC com protobuf, para que a comunicação seja tipada, performática e com contratos claros.

#### Critérios de Aceitação

1. WHEN o NestJS_Gateway recebe um request de execução de agente, THE gRPC_Client SHALL serializar o request em formato protobuf conforme o schema do AgentOrchestrationService e enviá-lo ao LangGraph_Service dentro de um timeout de 30 segundos por chamada
2. WHEN o LangGraph_Service retorna uma resposta, THE gRPC_Client SHALL deserializar a resposta protobuf em um objeto TypeScript correspondente ao tipo definido no schema protobuf (ExecuteWorkflowResponse, ExecutionState, CancelExecutionResponse ou HealthCheckResponse)
3. THE gRPC_Client SHALL propagar `tenant_id`, `trace_id` e `user_id` como metadata gRPC (keys: `x-tenant-id`, `x-trace-id`, `x-user-id`) em todas as chamadas ao LangGraph_Service
4. WHEN uma mensagem protobuf é serializada e depois deserializada, THE gRPC_Client SHALL produzir um objeto com deep equality estrutural ao original, preservando tipos, valores e campos aninhados
5. THE gRPC_Client SHALL manter um pool de no mínimo 1 e no máximo 10 conexões gRPC reutilizáveis para o LangGraph_Service
6. IF uma chamada gRPC falha com erro UNAVAILABLE, DEADLINE_EXCEEDED ou erro de deserialização, THEN THE gRPC_Client SHALL retornar um erro tipado contendo o código gRPC, uma mensagem indicando a causa da falha, e o trace_id da chamada original
7. IF o LangGraph_Service não responde dentro do timeout de 30 segundos, THEN THE gRPC_Client SHALL encerrar a chamada e propagar um erro de timeout ao chamador sem manter a conexão pendente

### Requisito 2: Circuit Breaker e Fallback

**User Story:** Como operador do sistema, quero que o NestJS tenha um mecanismo de fallback automático quando o LangGraph Service estiver indisponível, para que os usuários continuem recebendo respostas mesmo em modo degradado.

#### Critérios de Aceitação

1. WHEN o número de falhas consecutivas ao contactar o LangGraph_Service atinge o `failureThreshold` (default: 5), THE Circuit_Breaker SHALL transicionar do estado CLOSED para OPEN e resetar o contador de sucessos para zero
2. WHILE o Circuit_Breaker está no estado OPEN, THE NestJS_Gateway SHALL direcionar requests ao Fallback_Handler sem tentar contatar o LangGraph_Service
3. WHEN o `resetTimeout` (default: 60000ms) expira com o Circuit_Breaker no estado OPEN, THE Circuit_Breaker SHALL transicionar para HALF_OPEN e permitir no máximo uma chamada de teste ao LangGraph_Service
4. WHEN uma chamada ao LangGraph_Service é bem-sucedida no estado HALF_OPEN e o `successThreshold` (default: 3) é atingido, THE Circuit_Breaker SHALL transicionar para CLOSED e resetar os contadores de falhas e sucessos para zero
5. WHEN qualquer chamada ao LangGraph_Service falha no estado HALF_OPEN, THE Circuit_Breaker SHALL transicionar imediatamente para OPEN e reiniciar o `resetTimeout`
6. WHEN o Fallback_Handler é ativado, THE Fallback_Handler SHALL executar o pipeline local simplificado chamando o LLM diretamente, retornar a resposta com flag `usedFallback=true`, e não produzir efeitos colaterais no LangGraph_Service
7. THE Circuit_Breaker SHALL transicionar apenas entre estados válidos (CLOSED→OPEN, OPEN→HALF_OPEN, HALF_OPEN→CLOSED, HALF_OPEN→OPEN), rejeitando qualquer transição não listada
8. IF uma chamada ao LangGraph_Service excede o `timeout` (default: 30000ms) ou retorna erro de conexão ou erro gRPC UNAVAILABLE, THEN THE Circuit_Breaker SHALL contabilizar a chamada como falha para fins de incremento do contador de falhas consecutivas
9. WHEN uma chamada ao LangGraph_Service é bem-sucedida no estado CLOSED, THE Circuit_Breaker SHALL resetar o contador de falhas consecutivas para zero

### Requisito 3: Execução de Workflows DAG

**User Story:** Como desenvolvedor de agentes, quero definir e executar workflows baseados em grafos direcionados acíclicos, para que eu possa compor agentes em pipelines complexos com roteamento condicional e execução paralela.

#### Critérios de Aceitação

1. WHEN um `ExecuteWorkflowRequest` contendo `agent_id`, `tenant_id` e `user_input` não-vazio é recebido, THEN o Workflow_Engine SHALL resolver o grafo do agente, executar todos os nós no caminho de execução e retornar um `ExecuteWorkflowResponse` com status COMPLETED, a lista de `steps` contendo um registro por nó visitado, e um campo `output` com comprimento maior que 0 caracteres
2. THE Workflow_Engine SHALL executar nós dos tipos `llm_call`, `tool_call`, `condition` e `parallel`, onde cada nó produz um `StepResult` contendo `node_id`, `node_type`, `output`, `duration_ms` e `status`
3. WHEN dois ou mais nós no DAG não possuem arestas de dependência entre si, THEN o Workflow_Engine SHALL executá-los em paralelo e aguardar a conclusão de todos antes de prosseguir para nós dependentes
4. WHEN uma aresta condicional é avaliada, THEN o Workflow_Engine SHALL avaliar a expressão de condição associada à aresta contra o estado atual do workflow e rotear a execução para o nó-alvo correspondente ao resultado da avaliação (verdadeiro ou falso)
5. WHEN uma `WorkflowDefinition` é submetida para registro, THEN o Workflow_Engine SHALL validar que o grafo resultante é acíclico (DAG válido), que contém pelo menos um nó, e que o `entry_point` referencia um nó existente; IF o grafo contém ciclos ou viola essas restrições, THEN o Workflow_Engine SHALL rejeitar a definição e retornar um erro indicando a razão da invalidação
6. WHEN uma execução é completada com sucesso, THEN o Workflow_Engine SHALL garantir que todos os nós no caminho de execução foram visitados e registrados em `steps` com status individual, e o `output` final contém pelo menos 1 caractere
7. WHEN o número de passos atinge o `recursion_limit` (padrão: 50), THEN o Workflow_Engine SHALL interromper a execução, registrar os nós já executados em `steps`, e retornar status FAILED com uma mensagem indicando que o limite de recursão foi atingido e o valor do limite
8. IF um nó individual falha durante a execução do workflow, THEN o Workflow_Engine SHALL interromper a execução do caminho afetado, registrar o nó com status FAILED e a mensagem de erro no `StepResult` correspondente, e retornar o `ExecuteWorkflowResponse` com status FAILED preservando os `steps` dos nós já executados com sucesso
9. IF o tempo de execução total do workflow excede o `timeout_ms` configurado (padrão: 120000ms), THEN o Workflow_Engine SHALL interromper a execução e retornar status TIMEOUT com os `steps` parciais dos nós já completados

### Requisito 4: Gerenciamento de Estado

**User Story:** Como desenvolvedor, quero que o estado de execução dos workflows seja gerenciado de forma distribuída e persistente, para que eu possa consultar execuções em andamento, recuperar de falhas e manter histórico.

#### Critérios de Aceitação

1. WHEN um workflow inicia execução, THEN o State_Manager SHALL criar o estado inicial no Redis com TTL configurável (padrão: 3600 segundos) contendo no mínimo os campos `user_input`, `tenant_id`, `agent_id`, `conversation_id`, `status` e `created_at`
2. WHEN um nó do workflow completa, THEN o State_Manager SHALL atualizar o estado no Redis de forma atômica (via MULTI/EXEC) e resetar o TTL da chave para o valor configurado
3. WHEN uma execução atinge um status terminal (COMPLETED, FAILED, CANCELLED ou TIMEOUT), THEN o State_Manager SHALL persistir o estado final no PostgreSQL na tabela `workflow_executions` incluindo `status`, `steps`, `tokens_input`, `tokens_output`, `duration_ms` e `completed_at`
4. THE State_Manager SHALL utilizar o padrão de chave `tenant:{tenant_id}:exec:{execution_id}` para isolamento no Redis
5. WHEN o State_Manager atualiza estado, THEN o State_Manager SHALL preservar todos os campos existentes e apenas adicionar ou atualizar campos do `state_update`
6. WHEN o TTL de um estado no Redis expira, THEN o State_Manager SHALL permitir limpeza automática sem afetar o estado persistido no PostgreSQL
7. IF o Redis está indisponível durante a criação ou atualização de estado, THEN o State_Manager SHALL registrar o erro com `trace_id` e propagar a falha ao chamador sem comprometer o estado já persistido no PostgreSQL
8. IF o `get_state` não encontra a chave no Redis para um `execution_id` e `tenant_id` fornecidos, THEN o State_Manager SHALL retornar `null` sem erro, indicando que o estado em voo não está disponível
9. IF a persistência no PostgreSQL falha ao gravar o estado final, THEN o State_Manager SHALL realizar até 3 tentativas de retry e, caso todas falhem, registrar o erro com `execution_id` e `trace_id` para recuperação posterior

### Requisito 5: Isolamento Multi-Tenant

**User Story:** Como operador do sistema, quero garantia de isolamento completo entre tenants, para que dados de um tenant nunca sejam acessíveis por outro tenant.

#### Critérios de Aceitação

1. THE System SHALL garantir que operações de leitura e escrita de estado de workflow retornem e modifiquem apenas dados pertencentes ao `tenant_id` autenticado no request, sem possibilidade de acesso a dados de outros tenants
2. THE PostgreSQL SHALL aplicar Row Level Security (RLS) na tabela `workflow_executions` com policy baseada na variável de sessão `app.current_tenant`, seguindo o mesmo padrão já utilizado nas demais tabelas do sistema
3. THE State_Manager SHALL prefixar todas as chaves Redis com `tenant:{tenant_id}:` e aplicar TTL de 3600 segundos (configurável) às chaves de estado em voo, garantindo que nenhuma operação de leitura ou escrita no Redis ocorra sem o prefixo de tenant validado
4. WHEN um request tenta acessar dados de outro tenant (tenant_id do recurso difere do tenant_id autenticado), THEN THE System SHALL rejeitar a operação com erro PERMISSION_DENIED, registrar o incidente no audit_logs com o `trace_id`, `tenant_id` solicitante e `tenant_id` alvo do recurso
5. THE gRPC_Client SHALL propagar `tenant_id` como metadata gRPC no header `x-tenant-id` em todas as chamadas ao LangGraph_Service
6. WHEN o LangGraph_Service recebe uma chamada gRPC sem `tenant_id` no metadata ou com `tenant_id` em formato inválido (não UUID), THEN THE LangGraph_Service SHALL rejeitar a chamada com erro INVALID_ARGUMENT antes de executar qualquer operação de workflow
7. THE LangGraph_Service SHALL validar que o `tenant_id` do metadata gRPC corresponde ao `tenant_id` presente no payload do request em todas as operações, rejeitando com erro PERMISSION_DENIED em caso de divergência

### Requisito 6: Streaming de Resultados Parciais

**User Story:** Como usuário do sistema, quero receber resultados parciais durante a execução de workflows longos, para que eu tenha feedback em tempo real sobre o progresso.

#### Critérios de Aceitação

1. WHEN `enable_streaming` é `true` no `ExecutionOptions` e o cliente invoca o RPC `ExecuteWorkflowStream`, THEN o LangGraph_Service SHALL emitir eventos `WorkflowStreamEvent` via stream gRPC server-side na ordem cronológica em que ocorrem durante a execução
2. WHEN um nó inicia execução, THEN o LangGraph_Service SHALL emitir evento `StepStarted` com `node_id` e `node_type` antes de emitir qualquer outro evento relativo a esse nó
3. WHEN um nó completa execução, THEN o LangGraph_Service SHALL emitir evento `StepCompleted` com o `StepResult` correspondente ao nó executado
4. WHEN tokens são gerados durante uma chamada LLM, THEN o LangGraph_Service SHALL emitir eventos `TokenGenerated` com o token individual e o `node_id` do nó que gerou o token
5. WHEN o workflow completa com sucesso, THEN o LangGraph_Service SHALL emitir evento `WorkflowCompleted` como último evento do stream e fechar o stream gRPC
6. WHEN o workflow falha durante a execução, THEN o LangGraph_Service SHALL emitir evento `WorkflowError` com `error_code` e `error_message` como último evento do stream e fechar o stream gRPC
7. IF o cliente invoca `ExecuteWorkflowStream` com `enable_streaming` igual a `false` ou ausente no `ExecutionOptions`, THEN o LangGraph_Service SHALL executar o workflow sem emitir eventos intermediários e emitir apenas o evento terminal (`WorkflowCompleted` ou `WorkflowError`) antes de fechar o stream
8. IF a conexão gRPC é interrompida durante o streaming, THEN o LangGraph_Service SHALL continuar a execução do workflow até a conclusão e persistir o resultado final no State Manager, permitindo consulta posterior via `GetExecutionState`

### Requisito 7: Cancelamento de Execução

**User Story:** Como usuário, quero poder cancelar uma execução em andamento, para que eu não precise esperar por resultados que não são mais necessários.

#### Critérios de Aceitação

1. WHEN um request `CancelExecution` é recebido com `execution_id` e `tenant_id` válidos, THEN o LangGraph_Service SHALL interromper a execução no nó atual e atualizar o status para CANCELLED
2. WHEN uma execução é cancelada, THEN o State_Manager SHALL persistir o estado parcial incluindo os `steps` dos nós já completados, o `current_node` no momento do cancelamento, e `duration_ms` até o momento da interrupção
3. IF uma execução já foi concluída (status COMPLETED, FAILED, TIMEOUT ou CANCELLED) WHEN um request de cancelamento é recebido, THEN o LangGraph_Service SHALL retornar `success=false` com mensagem indicando o status atual da execução
4. IF o `execution_id` fornecido não existe ou não pertence ao `tenant_id` do request, THEN o LangGraph_Service SHALL retornar `success=false` com mensagem indicando que a execução não foi encontrada, sem revelar se o ID existe para outro tenant

### Requisito 8: Health Check e Readiness

**User Story:** Como operador de infraestrutura, quero que o LangGraph Service exponha endpoints de health check, para que readiness probes do Kubernetes possam verificar se o serviço está pronto para receber tráfego.

#### Critérios de Aceitação

1. WHEN um `HealthCheckRequest` é recebido, THE LangGraph_Service SHALL retornar `HealthCheckResponse` com `status`, `version` (string correspondente à versão deployada do serviço) e `details` (mapa contendo ao menos as chaves `redis` e `postgres` com seus respectivos estados) em no máximo 500ms
2. WHILE as dependências obrigatórias (Redis e PostgreSQL) estão acessíveis e respondendo, THE LangGraph_Service SHALL retornar status `SERVICE_STATUS_SERVING`
3. WHILE ao menos uma dependência obrigatória (Redis ou PostgreSQL) está inacessível ou não respondendo dentro de 2 segundos, THE LangGraph_Service SHALL retornar status `SERVICE_STATUS_NOT_SERVING` e indicar no campo `details` qual dependência está indisponível
4. IF o LangGraph_Service encontra um erro interno ao executar a verificação de saúde, THEN THE LangGraph_Service SHALL retornar status `SERVICE_STATUS_NOT_SERVING` com o campo `details` contendo indicação do erro encontrado

### Requisito 9: Resolução de Workflow por Agente

**User Story:** Como desenvolvedor de agentes, quero que o sistema resolva automaticamente qual workflow executar baseado na configuração do agente, para que novos agentes possam ser adicionados sem alteração no motor de execução.

#### Critérios de Aceitação

1. WHEN um `agent_id` e `tenant_id` são fornecidos ao Agent_Router, THEN o Agent_Router SHALL consultar o `agent_type` do agente na tabela `agent_configs` e buscar na tabela `workflow_definitions` o registro com `is_active = true` correspondente ao `agent_type` e `tenant_id` fornecidos, retornando o `ResolvedWorkflow` com workflow_id, graph_definition, config e agent_type
2. WHEN um workflow global (`tenant_id` IS NULL) e um workflow específico de tenant existem ambos ativos para o mesmo `agent_type`, THEN o Agent_Router SHALL selecionar o workflow específico do tenant, ignorando o workflow global
3. WHEN múltiplas versões ativas existem na tabela `workflow_definitions` para o mesmo `agent_type` e `tenant_id`, THEN o Agent_Router SHALL selecionar o registro com o maior valor no campo `version`
4. IF nenhum workflow ativo é encontrado para o `agent_type` do agente, THEN o Agent_Router SHALL retornar erro indicando que o agente não possui workflow configurado, incluindo o `agent_id` e `tenant_id` na mensagem de erro
5. IF o `agent_id` fornecido não existe na tabela `agent_configs`, THEN o Agent_Router SHALL retornar erro indicando que o agente não foi encontrado, incluindo o `agent_id` fornecido na mensagem de erro

### Requisito 10: Tratamento de Erros e Timeout

**User Story:** Como operador do sistema, quero que erros e timeouts sejam tratados de forma previsível e rastreável, para que eu possa diagnosticar problemas e o sistema se comporte de forma resiliente.

#### Critérios de Aceitação

1. WHEN a execução de um workflow excede o `timeout_ms` configurado (padrão: 120000ms), THEN o Workflow_Engine SHALL interromper a execução, persistir o estado parcial incluindo os `steps` dos nós já completados e o `current_node` no momento da interrupção, e retornar status TIMEOUT com `duration_ms` igual ou superior ao `timeout_ms`
2. WHEN um nó do grafo viola regras de guardrails, THEN o Workflow_Engine SHALL interromper a execução do workflow, registrar cada violação como entrada no array `guardrail_violations` contendo o `node_id` violador e a regra violada, retornar `blocked_reason` com identificação do nó e da regra, e persistir o estado parcial com status FAILED
3. IF um erro inesperado ocorre durante a execução, THEN o Workflow_Engine SHALL capturar o erro, registrar com o `trace_id` propagado via gRPC metadata, e retornar status FAILED com mensagem de erro contendo o tipo do erro e o `node_id` onde ocorreu (quando aplicável), limitada a 1024 caracteres
4. THE Workflow_Engine SHALL garantir que toda execução (sucesso ou falha) persiste estado final no PostgreSQL via State_Manager e gera métricas de `duration_ms` e `tokens_used` (input + output)
5. IF a persistência de estado falha durante o tratamento de um erro, THEN o Workflow_Engine SHALL registrar a falha de persistência com `trace_id` e `execution_id`, e retornar status FAILED ao chamador com indicação de que o estado pode não ter sido persistido

### Requisito 11: Contabilização de Tokens

**User Story:** Como administrador de custos, quero que o consumo de tokens seja rastreado por execução, para que eu possa monitorar e controlar custos de LLM por tenant.

#### Critérios de Aceitação

1. FOR ALL execuções que atingem um status terminal (COMPLETED, FAILED, TIMEOUT ou CANCELLED), a soma de `tokens_used` (input + output) nos `StepResult` individuais SHALL ser igual ao `tokens_used` total reportado na `ExecuteWorkflowResponse`
2. WHEN um nó do tipo `llm_call` é executado, THEN o Workflow_Engine SHALL registrar `input_tokens` e `output_tokens` no `StepResult` correspondente com valores obtidos da resposta do LLM provider
3. THE tabela `workflow_executions` SHALL armazenar `tokens_input` e `tokens_output` para cada execução persistida, refletindo a soma agregada de todos os `StepResult` até o momento da terminação
4. FOR ALL nós dos tipos `tool_call`, `condition` e `parallel`, o `StepResult` SHALL reportar `input_tokens = 0` e `output_tokens = 0`
5. IF o LLM provider não retorna informação de token usage na resposta, THEN o Workflow_Engine SHALL registrar `input_tokens = 0` e `output_tokens = 0` no `StepResult` correspondente e registrar um warning com `trace_id` e `node_id` indicando ausência de dados de tokens
