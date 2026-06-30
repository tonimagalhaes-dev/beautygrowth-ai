# Requirements Document

## Introduction

O **Content Agent MVP** é o primeiro agente funcional de IA da plataforma BeautyGrowth AI, orquestrado pelo serviço LangGraph via gRPC. Este agente recebe um briefing do usuário da clínica e gera conteúdo textual para redes sociais (Instagram, Facebook, TikTok), incluindo legenda adaptada por rede, hashtags e sugestão de formato visual. O workflow carrega contexto da clínica (Business Memory + Knowledge Hub), resolve o prompt via Prompt Registry, gera o conteúdo via Model Registry, valida contra Guardrails regulatórios e persiste a interação na Agent Memory. Não inclui geração de imagens, publicação direta, agendamento, criação de campanhas ou dashboard de analytics.

## Glossary

- **Content_Agent**: Agente de IA especializado em geração de conteúdo textual para redes sociais, executado como workflow no LangGraph Service.
- **Briefing**: Conjunto de informações fornecidas pelo usuário para direcionar a geração de conteúdo, incluindo: tema, procedimento, override de público-alvo e seleção de redes sociais.
- **Rede_Social**: Plataforma de mídia social alvo para o conteúdo gerado. Redes suportadas no MVP: Instagram, Facebook e TikTok.
- **Legenda**: Texto principal do post gerado pelo Content_Agent, adaptado às restrições e boas práticas de cada Rede_Social.
- **Sugestão_Visual**: Recomendação textual de formato e composição visual para acompanhar a legenda, sem geração de imagem real.
- **Refinamento**: Solicitação do usuário para ajustar o conteúdo gerado previamente, mantendo o contexto da interação original.
- **Workflow_LangGraph**: Grafo de execução definido no LangGraph Service que orquestra os nós do Content_Agent (load context → resolve prompt → generate → validate → output).
- **Guardrail_Violation**: Ocorrência em que o conteúdo gerado viola uma ou mais regras de segurança de conteúdo (ANVISA, CFM, políticas do tenant).
- **Contexto_Clinica**: Conjunto de dados carregados da Business Memory e Knowledge Hub que informam o Content_Agent sobre identidade da marca, público-alvo, especialidades e tom de voz da clínica.

## Requirements

### Requirement 1: Recebimento e Validação do Briefing

**User Story:** Como profissional de marketing de uma clínica, eu quero submeter um briefing com tema, procedimento e redes desejadas, para que o Content Agent gere conteúdo direcionado ao meu contexto.

#### Acceptance Criteria

1. WHEN o usuário submete um Briefing via endpoint da API, THE Content_Agent SHALL aceitar os seguintes campos: tema (obrigatório, máximo 500 caracteres), procedimento (opcional, referência a procedimento cadastrado na Knowledge_Hub), override de público-alvo (opcional, máximo 300 caracteres), seleção de redes sociais (obrigatório, ao menos 1 Rede_Social dentre Instagram, Facebook e TikTok) e idioma (opcional, padrão pt-BR).
2. IF o Briefing for submetido sem tema ou sem ao menos uma Rede_Social selecionada, THEN THE Content_Agent SHALL rejeitar a requisição com código de erro 422 e mensagem indicando os campos obrigatórios ausentes.
3. IF o campo tema exceder 500 caracteres ou o campo override de público-alvo exceder 300 caracteres, THEN THE Content_Agent SHALL rejeitar a requisição com código de erro 422 e mensagem indicando o limite violado.
4. WHEN o Briefing é aceito, THE Content_Agent SHALL associar a execução ao tenant_id e user_id extraídos do contexto de autenticação e gerar um execution_id único para rastreabilidade.

### Requirement 2: Carregamento de Contexto da Clínica

**User Story:** Como profissional de marketing de uma clínica, eu quero que o agente considere a identidade da marca, tom de voz e conhecimento específico da clínica ao gerar conteúdo, para que o resultado seja coerente com a comunicação da minha clínica.

#### Acceptance Criteria

1. WHEN a execução do Content_Agent inicia, THE Content_Agent SHALL carregar da Business Memory do tenant: identidade da marca (tom de voz, paleta de cores, valores), público-alvo, especialidades e diferenciais.
2. WHEN a execução do Content_Agent inicia, THE Content_Agent SHALL realizar busca semântica na Knowledge_Hub do tenant nas categorias Marketing, Procedimentos e Compliance, utilizando o tema e procedimento do Briefing como query, retornando até 5 chunks relevantes.
3. IF o Briefing especifica um procedimento, THEN THE Content_Agent SHALL priorizar chunks da Knowledge_Hub da categoria Procedimentos que correspondam ao procedimento informado.
4. IF a Business Memory do tenant não possuir identidade da marca configurada (tom de voz ausente), THEN THE Content_Agent SHALL rejeitar a execução com código de erro 412 e mensagem indicando que a clínica precisa configurar a identidade da marca antes de gerar conteúdo.
5. WHEN o Briefing inclui override de público-alvo, THE Content_Agent SHALL utilizar o público-alvo informado no Briefing em vez do público-alvo armazenado na Business Memory para esta execução específica.

### Requirement 3: Geração de Conteúdo Multi-Rede

**User Story:** Como profissional de marketing de uma clínica, eu quero receber legendas adaptadas para cada rede social selecionada, com hashtags e sugestão de formato visual, para que eu possa publicar conteúdo otimizado em cada plataforma.

#### Acceptance Criteria

1. WHEN o contexto é carregado e o prompt resolvido, THE Content_Agent SHALL gerar uma Legenda adaptada para cada Rede_Social selecionada no Briefing, respeitando os limites: Instagram (máximo 2200 caracteres), Facebook (máximo 63206 caracteres) e TikTok (máximo 2200 caracteres).
2. THE Content_Agent SHALL gerar entre 5 e 15 hashtags relevantes ao tema, procedimento e público-alvo, compartilhadas entre as redes ou adaptadas quando necessário.
3. THE Content_Agent SHALL gerar uma Sugestão_Visual por Rede_Social contendo: formato de imagem recomendado (Instagram: 1:1 ou 4:5, Facebook: 1.91:1, TikTok: 9:16) e descrição textual da composição visual sugerida (máximo 200 caracteres).
4. THE Content_Agent SHALL resolver o prompt template do Prompt_Registry para o agent_type content, substituindo variáveis de template (nome_clinica, tom_de_voz, especialidades, publico_alvo, tema, procedimento) com dados do Contexto_Clinica e do Briefing.
5. THE Content_Agent SHALL selecionar o modelo de IA a partir do Model_Registry conforme configuração do tenant, utilizando o modelo primário configurado para o Content_Agent.
6. IF o modelo primário estiver indisponível, THEN THE Content_Agent SHALL utilizar o modelo de fallback configurado no Model_Registry e incluir flag indicando uso de fallback na resposta.
7. THE Content_Agent SHALL retornar a resposta com status "draft" contendo: legendas por rede, hashtags, sugestões visuais, execution_id, modelo utilizado, tokens consumidos (input e output) e flag de fallback.

### Requirement 4: Validação de Guardrails

**User Story:** Como administrador de uma clínica, eu quero que todo conteúdo gerado seja validado contra regras regulatórias antes de ser entregue, para que a clínica não corra riscos de violação da ANVISA ou CFM.

#### Acceptance Criteria

1. WHEN o Content_Agent gera conteúdo, THE Content_Agent SHALL validar todas as legendas geradas contra os Guardrails padrão da plataforma (proibição de promessas de resultado, diagnósticos, prescrições e alegações de saúde não autorizadas) e os Guardrails personalizados do tenant, antes de retornar o resultado.
2. IF uma Guardrail_Violation é detectada, THEN THE Content_Agent SHALL descartar o conteúdo violador e regenerar automaticamente, utilizando o feedback da violação como contexto adicional para a nova geração.
3. IF o Content_Agent falhar na regeneração após 3 tentativas consecutivas para a mesma Guardrail_Violation, THEN THE Content_Agent SHALL interromper a execução, retornar código de erro 422 com mensagem indicando que o conteúdo solicitado não pode ser gerado em conformidade com as políticas vigentes e registrar o bloqueio no log de Observabilidade.
4. WHEN uma Guardrail_Violation é detectada em qualquer tentativa, THE Content_Agent SHALL registrar no log de Observabilidade: execution_id, trace_id, regra violada, tentativa número e trecho do conteúdo que causou a violação.

### Requirement 5: Refinamento Iterativo de Conteúdo

**User Story:** Como profissional de marketing de uma clínica, eu quero solicitar ajustes no conteúdo gerado sem perder o contexto da geração original, para que eu possa iterar até obter o resultado desejado.

#### Acceptance Criteria

1. WHEN o usuário submete uma solicitação de Refinamento referenciando um execution_id existente, THE Content_Agent SHALL carregar o contexto da execução original (Briefing, contexto da clínica, conteúdo gerado anteriormente) e aplicar os ajustes solicitados.
2. THE Content_Agent SHALL aceitar no máximo 5 Refinamentos por execution_id original, retornando código de erro 429 com mensagem indicando o limite atingido quando excedido.
3. WHEN um Refinamento é processado, THE Content_Agent SHALL aplicar validação de Guardrails ao conteúdo refinado com as mesmas regras da geração original (incluindo limite de 3 tentativas de regeneração por violação).
4. WHEN um Refinamento é aceito, THE Content_Agent SHALL retornar a resposta atualizada mantendo o mesmo execution_id e incrementando um campo version (iniciando em 1 na geração original).
5. IF o execution_id referenciado no Refinamento não existir ou não pertencer ao tenant do usuário, THEN THE Content_Agent SHALL retornar código de erro 404 sem revelar se o execution_id existe para outro tenant.

### Requirement 6: Persistência, Observabilidade e Tratamento de Erros

**User Story:** Como administrador da plataforma, eu quero que todas as execuções do Content Agent sejam rastreáveis e que falhas sejam tratadas de forma resiliente, para que eu possa monitorar o comportamento do agente e diagnosticar problemas.

#### Acceptance Criteria

1. WHEN o Content_Agent finaliza uma execução (sucesso ou falha), THE Content_Agent SHALL persistir a interação na Agent Memory de curto prazo do tenant, incluindo: Briefing, contexto carregado, conteúdo gerado, violações de guardrail e metadados de execução.
2. WHEN o Content_Agent finaliza uma execução, THE Content_Agent SHALL registrar no log de Observabilidade: trace_id, execution_id, tenant_id, user_id, duração total em milissegundos, tokens consumidos (input e output), modelo utilizado, quantidade de violações de guardrail e status final (success, guardrail_blocked, error).
3. IF o serviço LLM (Model Registry) estiver indisponível e nenhum modelo de fallback responder, THEN THE Content_Agent SHALL retornar código de erro 503 com mensagem indicando indisponibilidade temporária do serviço de geração, e registrar o evento como alerta crítico na Observabilidade.
4. IF a Business Memory ou Knowledge_Hub estiver indisponível durante o carregamento de contexto, THEN THE Content_Agent SHALL retornar código de erro 503 com mensagem indicando falha no carregamento de contexto e registrar o evento na Observabilidade.
5. IF a persistência na Agent Memory falhar após a geração bem-sucedida de conteúdo, THEN THE Content_Agent SHALL retornar o conteúdo gerado ao usuário normalmente e registrar a falha de persistência como warning na Observabilidade.
