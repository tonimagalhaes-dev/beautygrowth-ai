# Implementation Plan: Designer Agent

## Overview

Implementar o Designer Agent como workflow LangGraph (Python) com API NestJS (TypeScript), incluindo geração de imagens via Gemini, upload ao MinIO, overlay de logo, edição iterativa multiturno, integração com Content Agent, guardrails regulatórios e observabilidade completa. O backend NestJS gerencia validação, autenticação e polling; o LangGraph Service executa o workflow de geração com 7 nós principais.

## Tasks

- [x] 1. Configurar estrutura do projeto e modelos de dados
  - [x] 1.1 Criar migrations SQL para as tabelas designer_executions, designer_images e designer_edit_history
    - Criar migration com CREATE TABLE designer_executions (com RLS, índices)
    - Criar migration com CREATE TABLE designer_images (com RLS, índices)
    - Criar migration com CREATE TABLE designer_edit_history (com RLS, índices)
    - _Requisitos: 4.3, 6.4, 10.1_

  - [x] 1.2 Criar módulo NestJS designer-agent com estrutura base
    - Criar pasta `src/modules/designer-agent/` com controller, service, module
    - Registrar o módulo no AppModule
    - Configurar DTOs de entrada: GenerateImageDto, EditImageDto, FromContentDto
    - Configurar DTOs de saída: DesignerAgentResponse, ImageResult, GenerateAcceptedResponse
    - _Requisitos: 1.1, 1.5, 8.1, 8.4_

  - [x] 1.3 Criar estrutura base do workflow LangGraph em Python
    - Criar `langgraph-service/src/workflows/designer_agent.py`
    - Definir TypedDict `DesignerAgentState` com todos os campos do state schema
    - Criar função `build_designer_agent_graph()` com nós e edges (stubs)
    - Registrar o workflow no serviço LangGraph
    - _Requisitos: 3.1, 3.2_

- [x] 2. Implementar validação e endpoint de geração
  - [x] 2.1 Implementar endpoint POST /api/designer-agent/generate
    - Validar DTO com class-validator: descricaoVisual (trim, 10-1000 chars), redesSociais (1-3, enum), estiloVisualAdicional (max 300)
    - Extrair tenant_id e user_id do contexto de autenticação (TenantGuard)
    - Gerar execution_id (UUID v4)
    - Responder 202 com {executionId, status: "processing"}
    - Disparar execução assíncrona via gRPC ao LangGraph
    - _Requisitos: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [x] 2.2 Implementar endpoint GET /api/designer-agent/executions/:id
    - Consultar designer_executions + designer_images (is_latest=true)
    - Verificar pertencimento ao tenant via RLS
    - Retornar resposta completa com imagens, thumbnails, metadados
    - Regenerar URLs pré-assinadas se expiradas (validade > 7 dias)
    - _Requisitos: 4.5, 8.1, 8.3, 8.4_

  - [x]* 2.3 Escrever testes unitários para validação do DTO de geração
    - Testar rejeição 422 para descrição < 10 chars, sem rede social, rede inválida
    - Testar aceitação com payload válido
    - _Requisitos: 1.2, 1.3, 1.4_

- [x] 3. Implementar nó load_context do workflow
  - [x] 3.1 Implementar carregamento da Business Memory (Identidade_Marca)
    - Carregar paleta de cores, estilo visual, valores, elementos recorrentes do tenant
    - Se paleta ausente: usar defaults (branco #FFFFFF, cinza #9E9E9E, dourado #D4AF37) e setar flag brand_identity_defaults_used
    - Timeout de 10 segundos para Business Memory; se exceder → erro 503
    - _Requisitos: 2.1, 2.4, 10.4_

  - [x] 3.2 Implementar carregamento de dados do Content Agent (quando vinculado)
    - Validar existência do execution_id na Agent Memory e pertencimento ao tenant
    - Se não encontrado ou outro tenant → erro 404 sem revelar existência
    - Validar status do Content Agent (aceitar somente "draft" ou "approved") → senão erro 409
    - Validar que existem sugestões visuais para as redes solicitadas → senão erro 422
    - Carregar sugestões visuais (campo "descricao") por rede social
    - _Requisitos: 1.6, 1.7, 9.2, 9.4, 9.5, 9.6_

  - [x] 3.3 Implementar carregamento de contexto de edição iterativa
    - Se is_edit=true: carregar execução original + histórico cumulativo de edições do designer_edit_history
    - Verificar pertencimento ao tenant → senão 404
    - Verificar limite de 5 edições por rede social → senão 429
    - _Requisitos: 6.1, 6.2, 6.5_

- [x] 4. Implementar nó build_visual_prompt
  - [x] 4.1 Implementar construção do prompt visual por rede social
    - Resolver template do Prompt Registry (agent_type='designer')
    - Substituir variáveis: {{descricao_visual}}, {{paleta_cores}}, {{estilo_visual}}, {{aspecto_ratio}}, {{nome_clinica}}, {{elementos_recorrentes}}
    - Adicionar estilo visual adicional quando informado
    - Se vinculado ao Content Agent: incorporar sugestão visual por rede social
    - Se edição: incorporar histórico cumulativo + nova instrução
    - _Requisitos: 2.2, 2.3, 2.5, 6.3_

  - [x] 4.2 Implementar geração de negative prompts (guardrails embutidos)
    - Incluir instruções negativas proibindo: antes/depois de procedimentos, profissionais não identificados, nudez, propaganda irregular, marcas de terceiros
    - _Requisitos: 7.1_

- [x] 5. Implementar nó validate_guardrails_pre
  - [x] 5.1 Implementar validação de guardrails pré-geração
    - Aplicar guardrails padrão da plataforma (ANVISA/CFM)
    - Aplicar guardrails personalizados do tenant (se disponíveis, timeout 10s)
    - Se guardrails personalizados indisponíveis (timeout/erro): aplicar apenas padrão + adicionar warning "guardrails personalizados não foram aplicados" ao state.warnings para propagação à resposta final
    - Verificar termos proibidos no prompt
    - _Requisitos: 7.2, 7.6_

  - [x] 5.2 Implementar lógica condicional de retry/block
    - Se violação detectada e attempt < 3: registrar na Observabilidade, remover elementos violadores, retornar para rebuild (conditional edge)
    - Se violação e attempt >= 3: marcar como blocked, registrar, retornar 422
    - Registrar: execution_id, trace_id, regra violada, tentativa, trecho (max 200 chars)
    - _Requisitos: 7.3, 7.4, 7.5_

- [x] 6. Checkpoint — Garantir que load_context, build_prompt e guardrails funcionam
  - Garantir que todos os testes passam, perguntar ao usuário se houver dúvidas.

- [x] 7. Implementar nó generate_images
  - [x] 7.1 Implementar geração de imagens em paralelo por rede social
    - Selecionar modelo via Model Registry (primário: gemini-3.1-flash-image)
    - Para cada rede social (asyncio.gather): invocar modelo com prompt + aspecto_ratio
    - Resoluções: Instagram 4:5 (1080x1350), Facebook 1.91:1 (1200x628), TikTok 9:16 (1080x1920)
    - Timeout: 30 segundos por modelo (primário 30s, fallback 30s — NÃO 60s por imagem)
    - Se modelo primário falha (5xx, timeout 30s, sem resposta): tentar fallback do Model Registry com timeout adicional de 30s e setar flag used_fallback
    - Gerar imagens em formato PNG, 72 DPI mínimo, max 10MB por imagem
    - _Requisitos: 3.1, 3.2, 3.3, 3.4, 3.5, 10.3_

  - [x] 7.2 Implementar tratamento de falha parcial e total
    - Se ao menos uma imagem gerada com sucesso → continuar com parciais + status de erro por rede que falhou
    - Se todas falharem após primário + fallback → erro 503 + registrar CRITICAL na Observabilidade
    - _Requisitos: 3.6, 3.7_

- [x] 8. Implementar nó post_process
  - [x] 8.1 Implementar geração de thumbnails com compressão adaptativa
    - Gerar thumbnail: JPEG 80%, largura 400px, manter aspect ratio
    - Verificar se thumbnail ≤ 200KB; se exceder, reduzir qualidade iterativamente (75%, 70%, 65%... até min 40%) até atingir ≤ 200KB
    - Se após redução máxima ainda exceder 200KB: reduzir largura para 300px e repetir compressão
    - Se geração de thumbnail falhar: usar URL do original como fallback + warning
    - _Requisitos: 8.2, 8.5_

  - [x] 8.2 Implementar overlay de logo da clínica
    - Se aplicar_logo_overlay=true E logo disponível na Business Memory:
      - Carregar logo do MinIO
      - Redimensionar para max 15% da largura da imagem, mantendo proporção
      - Posicionar: canto inferior direito, margem 3% das bordas, opacidade 80%
      - Salvar versão com overlay (principal) e sem overlay (variante)
    - Se logo não cadastrado: gerar imagem sem overlay + warning
    - Se processamento falha (logo corrompido, formato incompatível): retornar imagem sem overlay + warning
    - _Requisitos: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

- [x] 9. Implementar nó upload_and_persist
  - [x] 9.1 Implementar upload ao MinIO com retry e validação de tamanho
    - Upload original: path `{tenant_id}/designer/{execution_id}/{rede}_{YYYYMMDDHHmmssSSS}.png`
    - Upload thumbnail: `{tenant_id}/designer/{execution_id}/{rede}_{YYYYMMDDHHmmssSSS}_thumb.jpg`
    - Upload overlay (se existir): `{tenant_id}/designer/{execution_id}/{rede}_{YYYYMMDDHHmmssSSS}_overlay.png`
    - Se tamanho > 10MB: rejeitar com 413
    - Retry: até 3 tentativas com backoff exponencial (1s, 2s, 4s)
    - Gerar URLs pré-assinadas com validade de 7 dias
    - _Requisitos: 4.1, 4.2, 4.4, 4.6_

  - [x] 9.2 Implementar persistência de metadados e Agent Memory
    - Persistir na tabela designer_images: execution_id, tenant_id, rede_social, aspecto_ratio, tamanho_bytes, minio_path, modelo, version, is_latest
    - Persistir/atualizar designer_executions com status final, duração, tokens, warnings
    - Persistir na Agent Memory (short-term, 30 dias): solicitação, prompt, URLs, violações, metadados
    - Se persistência na Agent Memory falhar após 2 tentativas (intervalo 1s): retornar imagens normalmente + WARNING na Observabilidade
    - _Requisitos: 4.3, 10.1, 10.5_

- [x] 10. Implementar edição iterativa (multiturno)
  - [x] 10.1 Implementar endpoint POST /api/designer-agent/edit
    - Validar EditImageDto: executionId (UUID), redeSocial (enum), instrucaoEdicao (max 500 chars, senão 422)
    - Verificar pertencimento ao tenant → senão 404
    - Verificar limite de 5 edições por rede → senão 429
    - Contar edições existentes no designer_edit_history (NOT apenas version na execução)
    - Disparar workflow LangGraph com is_edit=true
    - _Requisitos: 6.1, 6.2, 6.3, 6.5_

  - [x] 10.2 Implementar lógica de incremento de versão somente após sucesso
    - O insert no designer_edit_history e o incremento de version só devem ocorrer APÓS a geração de imagem bem-sucedida
    - Se a geração falhar durante edição: retornar 503, NÃO incrementar contador, NÃO inserir no designer_edit_history
    - Registrar falha na Observabilidade (permitir nova tentativa sem perder uma das 5 tentativas)
    - _Requisitos: 6.4, 6.6_

- [x] 11. Checkpoint — Garantir que geração, pós-processamento, upload e edição funcionam
  - Garantir que todos os testes passam, perguntar ao usuário se houver dúvidas.

- [x] 12. Implementar integração com Content Agent
  - [x] 12.1 Implementar endpoint POST /api/designer-agent/from-content
    - Validar FromContentDto: contentExecutionId (UUID), aplicarLogoOverlay (optional), estiloVisualAdicional (optional, max 300)
    - Configurar timeout de resposta de 5 segundos para aceitar/rejeitar (retornar execution_id ou erro dentro de 5s)
    - Carregar execução do Content Agent: validar existência, pertencimento ao tenant, status (draft/approved)
    - Extrair redes sociais e sugestões visuais automaticamente da execução do Content Agent
    - Responder 202 com {executionId, status: "processing"} ou código de erro apropriado
    - Disparar workflow LangGraph assincronamente
    - _Requisitos: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

  - [x]* 12.2 Escrever testes unitários para integração com Content Agent
    - Testar aceitação com Content Agent válido (status draft/approved)
    - Testar rejeição com status incompatível (409)
    - Testar rejeição com execution_id inexistente (404)
    - Testar rejeição sem sugestão visual disponível (422)
    - Testar que resposta inclui content_execution_id
    - _Requisitos: 9.1, 9.4, 9.5, 9.6_

- [x] 13. Implementar observabilidade e tratamento de erros
  - [x] 13.1 Implementar propagação de trace_id e logging estruturado
    - Propagar trace_id recebido (ou gerar UUID v4 se ausente) para todas as chamadas internas
    - Registrar log INFO para sucesso / ERROR para falha: trace_id, execution_id, tenant_id, user_id, duração_ms, tokens, modelo, qtd_imagens, qtd_violações, status final
    - Implementar try/catch no logging: se falhar, continuar execução normalmente e escrever evento em stdout como fallback
    - _Requisitos: 10.2, 10.6, 10.7_

  - [x] 13.2 Implementar tratamento de timeout e retry patterns
    - Model Registry: timeout 30s por modelo (primário 30s + fallback 30s)
    - Business Memory / Knowledge Hub: timeout 10s → erro 503 + log CRITICAL
    - MinIO upload: 3 tentativas com backoff exponencial (1s, 2s, 4s) → 503
    - Agent Memory: 2 tentativas com 1s intervalo → continuar + WARNING
    - Guardrail validation: timeout 10s
    - _Requisitos: 10.3, 10.4, 10.5_

  - [x]* 13.3 Escrever testes unitários para cenários de fallback e retry
    - Testar fallback de modelo (primário falha → usa fallback)
    - Testar fallback de logging (logging falha → stdout)
    - Testar retry de upload ao MinIO
    - Testar continuidade quando Agent Memory falha
    - _Requisitos: 10.3, 10.5, 10.7_

- [x] 14. Implementar resposta final e wiring do workflow
  - [x] 14.1 Implementar composição da resposta final do workflow
    - Montar DesignerAgentResponse com todos os campos: images, warnings, version, flags
    - Garantir que warnings de guardrails indisponíveis são propagados do state.warnings para a resposta final
    - Incluir content_execution_id se vinculado ao Content Agent
    - Incluir url_sem_overlay quando overlay aplicado
    - Serializar output como JSON no state
    - _Requisitos: 8.1, 8.4, 7.6, 9.3_

  - [x] 14.2 Conectar todos os nós do workflow e registrar no LangGraph Service
    - Garantir que o conditional edge de guardrails funciona corretamente (retry/block/pass)
    - Garantir que geração paralela respeita rate limiting do Model Registry
    - Registrar workflow compilado no LangGraph Service via endpoint de configuração
    - _Requisitos: 3.2, 7.3_

- [x] 15. Checkpoint final — Garantir integração completa
  - Garantir que todos os testes passam, perguntar ao usuário se houver dúvidas.

## Notes

- Tarefas marcadas com `*` são opcionais e podem ser puladas para um MVP mais rápido
- Cada tarefa referencia requisitos específicos para rastreabilidade
- Checkpoints garantem validação incremental
- O projeto usa TypeScript (NestJS) para a API e Python (LangGraph) para o workflow
- **Gap 1 — Timeout**: Timeout de 30s por modelo (primário 30s + fallback 30s), não 60s por imagem (Req 10 AC3)
- **Gap 2 — Thumbnail 200KB**: Compressão adaptativa iterativa até ≤ 200KB (Req 8 AC2)
- **Gap 3 — Logging fallback stdout**: try/catch no logging + fallback para stdout (Req 10 AC7)
- **Gap 4 — Contador edição apenas no sucesso**: Insert no histórico e increment de version somente após geração bem-sucedida (Req 6 AC6)
- **Gap 5 — SLA 5s /from-content**: Endpoint deve aceitar/rejeitar em no máximo 5 segundos (Req 9 AC1)
- **Gap 6 — Warning guardrails indisponíveis**: Propagar warning de guardrails do tenant indisponíveis até a resposta final (Req 7 AC6)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["2.1", "2.2", "3.1", "3.2", "3.3"] },
    { "id": 2, "tasks": ["2.3", "4.1", "4.2"] },
    { "id": 3, "tasks": ["5.1", "5.2"] },
    { "id": 4, "tasks": ["7.1", "7.2"] },
    { "id": 5, "tasks": ["8.1", "8.2"] },
    { "id": 6, "tasks": ["9.1", "9.2"] },
    { "id": 7, "tasks": ["10.1", "10.2"] },
    { "id": 8, "tasks": ["12.1", "13.1", "13.2"] },
    { "id": 9, "tasks": ["12.2", "13.3", "14.1", "14.2"] }
  ]
}
```
