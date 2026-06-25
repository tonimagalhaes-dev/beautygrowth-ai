# Requirements Document

## Introduction

O **BeautyGrowth AI — EPIC 01: Platform Foundation** define a base técnica da plataforma multi-agente de inteligência artificial voltada para clínicas de estética. Este épico foca exclusivamente na infraestrutura necessária para suportar os agentes de IA que serão adicionados em épicos futuros: configuração da clínica e sua identidade de marca, arquitetura multi-tenant, autenticação e controle de acesso, configuração inicial dos agentes, gerenciamento de memória (de negócio e de agente), base de conhecimento (RAG), catálogo de modelos de IA, registro centralizado de prompts, guardrails de segurança dos agentes, conformidade com LGPD e auditoria completa de todas as ações dos agentes. A plataforma segue a metodologia AI-DLC e Spec Driven Development.

## Glossary

- **Plataforma**: O sistema BeautyGrowth AI como um todo, incluindo interface web, agentes de IA e integrações.
- **Agente_de_IA**: Componente de inteligência artificial especializado em uma função específica (marketing, conteúdo, campanhas, atendimento) que atua como colaborador virtual autônomo dentro da plataforma.
- **Clínica**: Entidade representando uma clínica de estética cadastrada na plataforma, incluindo seus dados, configurações e identidade.
- **Multi_Tenant**: Arquitetura em que cada Clínica opera como um tenant isolado, com separação lógica de dados, configurações e agentes, garantindo que informações de um tenant não sejam acessíveis por outro.
- **Usuário_Primário**: Proprietários de clínicas, enfermeiros estetas, biomédicos estetas, médicos estetas e profissionais de marketing das clínicas.
- **Usuário_Secundário**: Recepcionistas, gestores comerciais e administradores da plataforma.
- **Identidade_da_Marca**: Conjunto de elementos visuais e textuais que definem a comunicação da clínica (tom de voz, paleta de cores, público-alvo, diferenciais).
- **Memória_de_Negócio**: Camada de memória compartilhada entre todos os Agentes_de_IA de um tenant, contendo conhecimento de nível organizacional: snapshots de identidade da marca, perfis de público-alvo, histórico de campanhas, catálogo de procedimentos e preferências do cliente.
- **Memória_do_Agente**: Mecanismo de persistência de contexto individual de cada Agente_de_IA, armazenando histórico de conversas, contexto de interação, aprendizados específicos do agente e padrões de interação do usuário.
- **Knowledge_Hub**: Base de conhecimento centralizada que armazena documentos, procedimentos, protocolos e informações específicas de cada Clínica para consulta pelos Agentes_de_IA via Retrieval-Augmented Generation.
- **RAG**: Retrieval-Augmented Generation — técnica que permite aos Agentes_de_IA consultar a Knowledge_Hub para fundamentar suas respostas em informações específicas e atualizadas da Clínica.
- **Model_Registry**: Catálogo centralizado de modelos de IA disponíveis para uso pelos Agentes_de_IA, contendo informações de provedor, versão, capacidades, custo e status de cada modelo.
- **Prompt_Registry**: Repositório centralizado de prompts versionados utilizados pelos Agentes_de_IA, permitindo gerenciamento, teste e rollback de instruções sem alteração de código.
- **Guardrails**: Regras de segurança de conteúdo que restringem o que os Agentes_de_IA podem gerar, garantindo conformidade com regulamentações de saúde (ANVISA, CFM) e políticas do tenant.
- **Observabilidade**: Capacidade da Plataforma de registrar, rastrear e auditar todas as ações executadas por Agentes_de_IA e usuários, incluindo logs estruturados, métricas e traces distribuídos.
- **Briefing**: Conjunto de informações fornecidas pelo usuário sobre a clínica para que os agentes possam gerar conteúdo personalizado.
- **LGPD**: Lei Geral de Proteção de Dados — legislação brasileira que regulamenta o tratamento de dados pessoais, incluindo coleta, armazenamento, processamento e compartilhamento.
- **DPO**: Data Protection Officer (Encarregado de Proteção de Dados) — responsável por garantir a conformidade com a LGPD dentro da organização.

## Requirements

### Requisito 1: Cadastro e Configuração da Clínica

**User Story:** Como proprietário de uma clínica de estética, eu quero cadastrar minha clínica na plataforma e configurar suas informações básicas, para que os agentes de IA possam personalizar suas entregas ao contexto do meu negócio.

#### Acceptance Criteria

1. WHEN um Usuário_Primário acessa a Plataforma pela primeira vez, THE Plataforma SHALL apresentar um fluxo guiado de cadastro solicitando os seguintes campos obrigatórios: nome da clínica (máximo 120 caracteres), telefone (formato brasileiro com DDD), e-mail (formato válido conforme RFC 5322), pelo menos uma especialidade oferecida (selecionada de uma lista predefinida de procedimentos estéticos, com limite máximo de 20 seleções) e público-alvo; e os seguintes campos opcionais: endereço completo (logradouro, número, complemento, cidade, estado, CEP) e website.
2. WHEN o Usuário_Primário preenche e submete o formulário de cadastro com todos os campos obrigatórios válidos, THE Plataforma SHALL criar o perfil da Clínica dentro do tenant correspondente e exibir uma confirmação de sucesso ao Usuário_Primário em até 5 segundos após a submissão.
3. IF um campo obrigatório estiver vazio ou com formato inválido (e-mail sem estrutura válida, telefone com menos de 10 dígitos ou mais de 11 dígitos, nome da clínica vazio), THEN THE Plataforma SHALL exibir uma mensagem de erro junto ao campo correspondente indicando o problema específico e manter os dados já preenchidos nos demais campos.
4. WHEN o perfil da Clínica é criado com sucesso, THE Plataforma SHALL armazenar as informações no contexto do tenant e torná-las disponíveis para todos os Agentes_de_IA vinculados à Clínica em até 30 segundos após a criação.
5. WHEN o Usuário_Primário acessa a seção de configurações da Clínica e submete alterações nos dados cadastrais, THE Plataforma SHALL salvar as atualizações e exibir confirmação de sucesso, mantendo as informações anteriores disponíveis para os Agentes_de_IA até que a atualização seja concluída.
6. IF a submissão do formulário de cadastro falhar por erro de comunicação ou indisponibilidade do servidor, THEN THE Plataforma SHALL exibir uma mensagem de erro indicando falha temporária, preservar os dados preenchidos pelo Usuário_Primário e permitir nova tentativa de submissão sem necessidade de repreenchimento.

### Requisito 2: Configuração da Identidade da Marca

**User Story:** Como proprietário de uma clínica de estética, eu quero definir a identidade visual e o tom de voz da minha marca, para que todo conteúdo gerado pela plataforma seja consistente com a comunicação da minha clínica.

#### Acceptance Criteria

1. WHEN o Usuário_Primário acessa a seção de Identidade_da_Marca, THE Plataforma SHALL apresentar um formulário contendo os seguintes campos: tom de voz (obrigatório, máximo de 500 caracteres), paleta de cores (até 6 cores, obrigatório ao menos 1 cor primária), logotipo (opcional), público-alvo (obrigatório, máximo de 300 caracteres), diferenciais (obrigatório, máximo de 5 itens com até 200 caracteres cada) e valores da clínica (obrigatório, máximo de 5 itens com até 200 caracteres cada).
2. WHEN o Usuário_Primário aciona a opção de sugestão em um campo da Identidade_da_Marca, THE Agente_de_IA SHALL apresentar no mínimo 3 opções de preenchimento baseadas nas especialidades e público-alvo informados no cadastro da Clínica em até 15 segundos.
3. WHEN a Identidade_da_Marca é salva com todos os campos obrigatórios preenchidos, THE Plataforma SHALL confirmar o salvamento ao Usuário_Primário e disponibilizar as definições para uso pelos Agentes_de_IA vinculados ao tenant da Clínica.
4. IF o Usuário_Primário tenta salvar a Identidade_da_Marca com campos obrigatórios vazios ou acima dos limites de caracteres, THEN THE Plataforma SHALL exibir uma mensagem de erro indicando quais campos precisam ser corrigidos, sem descartar os dados já preenchidos.
5. WHEN o Usuário_Primário atualiza a Identidade_da_Marca, THE Plataforma SHALL aplicar as novas definições em todo conteúdo gerado a partir daquele momento, mantendo inalterado o conteúdo gerado anteriormente.
6. THE Plataforma SHALL permitir upload de logotipo nos formatos PNG, JPG ou SVG com tamanho máximo de 5MB e dimensões mínimas de 200x200 pixels.
7. IF o Usuário_Primário tenta fazer upload de um logotipo com formato não suportado, tamanho superior a 5MB ou dimensões abaixo do mínimo, THEN THE Plataforma SHALL rejeitar o arquivo e exibir uma mensagem de erro indicando o motivo da rejeição.

### Requisito 3: Autenticação e Controle de Acesso

**User Story:** Como administrador da plataforma, eu quero gerenciar o acesso dos usuários à plataforma, para que cada colaborador tenha permissões adequadas ao seu papel na clínica.

#### Acceptance Criteria

1. THE Plataforma SHALL exigir autenticação via e-mail e senha para acesso ao sistema, sendo a senha obrigatoriamente composta por no mínimo 8 caracteres, incluindo ao menos 1 letra maiúscula, 1 letra minúscula, 1 número e 1 caractere especial.
2. WHEN um Usuário_Primário cria uma conta, THE Plataforma SHALL enviar um e-mail de verificação com link válido por 24 horas antes de ativar o acesso.
3. THE Plataforma SHALL suportar três perfis de acesso: Administrador (acesso total incluindo gerenciamento de membros e configurações da clínica), Operador (geração de conteúdo, visualização de campanhas e agendamento no calendário editorial) e Visualizador (somente leitura do dashboard e histórico de conteúdo).
4. WHEN um Administrador convida um novo membro, THE Plataforma SHALL enviar um convite por e-mail com link de ativação válido por 72 horas, vinculando o novo membro ao tenant da Clínica do Administrador.
5. IF o link de convite expirar sem ativação, THEN THE Plataforma SHALL permitir ao Administrador reenviar o convite com um novo link de ativação.
6. IF um usuário erra a senha 5 vezes consecutivas, THEN THE Plataforma SHALL bloquear o acesso por 15 minutos e enviar notificação por e-mail ao Administrador da Clínica e ao próprio usuário.
7. WHEN um usuário solicita redefinição de senha, THE Plataforma SHALL enviar um link de redefinição válido por 1 hora.
8. WHEN um Administrador altera o perfil de acesso de um membro, THE Plataforma SHALL aplicar as novas permissões imediatamente na próxima ação do usuário afetado.
9. THE Plataforma SHALL associar cada usuário autenticado a exatamente um tenant (Clínica), garantindo que todas as operações do usuário sejam executadas no escopo do tenant correspondente.

### Requisito 4: Multiempresa (Multi-Tenant)

**User Story:** Como operador da plataforma, eu quero que cada clínica funcione como um tenant isolado, para que os dados, configurações e agentes de uma clínica não sejam acessíveis por outra.

#### Acceptance Criteria

1. THE Plataforma SHALL implementar isolamento lógico de dados entre tenants, garantindo que consultas, agentes e configurações de um tenant não retornem dados de outro tenant.
2. WHEN uma nova Clínica é cadastrada, THE Plataforma SHALL provisionar automaticamente um tenant isolado contendo: espaço de armazenamento para dados da Clínica, configuração padrão de Agentes_de_IA, instância vazia de Knowledge_Hub e registro de Memória_do_Agente próprio.
3. THE Plataforma SHALL garantir que todas as operações de leitura e escrita incluam o identificador do tenant como filtro obrigatório, impedindo acesso cruzado entre tenants.
4. WHEN um Agente_de_IA executa uma ação, THE Plataforma SHALL restringir o acesso do agente exclusivamente aos dados, memórias e knowledge base do tenant ao qual o agente está vinculado.
5. IF uma requisição for recebida sem identificador de tenant válido ou com identificador de tenant que não corresponde ao usuário autenticado, THEN THE Plataforma SHALL rejeitar a requisição com erro de autorização e registrar o evento no log de Observabilidade.
6. THE Plataforma SHALL suportar configurações independentes por tenant para: limites de uso dos Agentes_de_IA, configurações de prompts e parâmetros de Knowledge_Hub.
7. WHEN um Administrador solicita exportação dos dados do tenant, THE Plataforma SHALL gerar um pacote contendo todos os dados, configurações e históricos pertencentes exclusivamente ao tenant solicitante, excluindo dados de outros tenants.

### Requisito 5: Configuração Inicial dos Agentes

**User Story:** Como administrador de uma clínica, eu quero configurar os agentes de IA disponíveis para minha clínica, para que cada agente opere com os parâmetros adequados ao meu contexto de negócio.

#### Acceptance Criteria

1. WHEN uma nova Clínica é provisionada, THE Plataforma SHALL criar automaticamente um conjunto padrão de Agentes_de_IA pré-configurados para o tenant, incluindo ao menos: Agente de Conteúdo, Agente de Campanhas e Agente de Atendimento.
2. WHEN o Administrador acessa a seção de configuração de agentes, THE Plataforma SHALL exibir a lista de Agentes_de_IA disponíveis para o tenant com seus respectivos status (ativo, inativo, em configuração), descrição e última data de execução.
3. WHEN o Administrador ativa ou desativa um Agente_de_IA, THE Plataforma SHALL aplicar a alteração em até 30 segundos, impedindo que agentes inativos executem ações ou consumam recursos.
4. WHEN o Administrador configura parâmetros de um Agente_de_IA (modelo de linguagem, temperatura, limite de tokens, instruções de sistema), THE Plataforma SHALL validar os parâmetros contra limites predefinidos e salvar a configuração no escopo do tenant.
5. IF o Administrador tenta configurar um parâmetro fora dos limites permitidos (temperatura acima de 2.0, limite de tokens acima do máximo suportado pelo modelo), THEN THE Plataforma SHALL rejeitar a configuração e exibir os limites válidos para o parâmetro.
6. THE Plataforma SHALL manter um histórico de alterações de configuração de cada Agente_de_IA, registrando data, usuário responsável e valores anterior e novo de cada parâmetro modificado.
7. WHEN o Administrador solicita reset de um Agente_de_IA para configuração padrão, THE Plataforma SHALL restaurar todos os parâmetros do agente aos valores padrão da plataforma sem afetar a Memória_do_Agente ou dados da Knowledge_Hub.

### Requisito 6: Business Memory (Memória de Negócio)

**User Story:** Como administrador de uma clínica, eu quero que a plataforma mantenha uma memória centralizada de conhecimento organizacional compartilhada entre todos os agentes, para que cada agente tenha acesso consistente ao contexto do negócio sem redundância de informação.

#### Acceptance Criteria

1. THE Plataforma SHALL manter uma Memória_de_Negócio por tenant contendo conhecimento de nível organizacional compartilhado entre todos os Agentes_de_IA, incluindo: snapshots da Identidade_da_Marca, perfis de público-alvo, histórico de campanhas, catálogo de procedimentos e preferências de clientes.
2. WHEN a Identidade_da_Marca ou a configuração da Clínica é atualizada pelo Usuário_Primário, THE Plataforma SHALL atualizar automaticamente a Memória_de_Negócio com as novas informações em até 60 segundos após a alteração.
3. WHEN um Agente_de_IA inicia uma interação, THE Plataforma SHALL disponibilizar ao agente acesso de leitura à Memória_de_Negócio do tenant correspondente, permitindo que o agente referencie dados organizacionais em suas respostas.
4. THE Plataforma SHALL garantir que Agentes_de_IA possam ler dados da Memória_de_Negócio mas não possam escrever diretamente nela, sendo a Memória_de_Negócio populada exclusivamente a partir de configurações da Clínica, campanhas executadas e ações do Usuário_Primário.
5. WHEN uma nova campanha é executada ou concluída, THE Plataforma SHALL registrar automaticamente na Memória_de_Negócio os metadados da campanha (tipo, canal, data, métricas de resultado) para referência futura pelos Agentes_de_IA.
6. THE Plataforma SHALL garantir que a Memória_de_Negócio de um tenant não seja acessível por Agentes_de_IA de outros tenants, aplicando o isolamento Multi_Tenant ao nível de cada registro de memória.
7. WHEN o Administrador acessa a seção de Memória_de_Negócio, THE Plataforma SHALL exibir o conteúdo atual organizado por categoria (marca, público-alvo, campanhas, procedimentos, preferências) com data da última atualização de cada item.
8. IF a atualização automática da Memória_de_Negócio falhar, THEN THE Plataforma SHALL registrar o erro no log de Observabilidade e manter a versão anterior da memória disponível para os Agentes_de_IA até que a atualização seja bem-sucedida.

### Requisito 7: Agent Memory (Memória do Agente)

**User Story:** Como administrador de uma clínica, eu quero que cada agente de IA retenha seu próprio contexto operacional e aprendizados entre sessões, para que as interações se tornem progressivamente mais personalizadas e eficientes.

#### Acceptance Criteria

1. THE Plataforma SHALL manter para cada Agente_de_IA uma Memória_do_Agente individual e persistente que sobreviva entre sessões, armazenando: histórico de conversas, contexto de interação, aprendizados específicos do agente e padrões de interação do usuário.
2. WHEN um Agente_de_IA inicia uma nova sessão de interação, THE Plataforma SHALL carregar o contexto relevante da Memória_do_Agente em até 5 segundos, permitindo ao agente referenciar interações e decisões anteriores.
3. WHEN um Agente_de_IA finaliza uma interação, THE Plataforma SHALL persistir automaticamente os novos aprendizados e contextos na Memória_do_Agente do tenant correspondente em até 10 segundos.
4. THE Plataforma SHALL separar a Memória_do_Agente em dois níveis: memória de curto prazo (contexto da sessão atual, limitada às últimas 50 interações) e memória de longo prazo (aprendizados consolidados e preferências persistentes).
5. WHEN a memória de curto prazo atinge o limite de 50 interações, THE Plataforma SHALL sumarizar automaticamente as interações mais antigas e promover informações relevantes para a memória de longo prazo.
6. THE Plataforma SHALL garantir que cada Agente_de_IA possua sua própria Memória_do_Agente isolada, impedindo que um agente acesse ou modifique a memória de outro agente dentro do mesmo tenant.
7. THE Plataforma SHALL permitir que Agentes_de_IA escrevam em sua própria Memória_do_Agente ao registrar aprendizados, padrões identificados e preferências observadas durante as interações.
8. WHEN o Administrador solicita limpeza da Memória_do_Agente, THE Plataforma SHALL permitir limpeza seletiva (por período, por tipo de memória) ou total, exigindo confirmação explícita antes de executar a operação.
9. IF a persistência da Memória_do_Agente falhar, THEN THE Plataforma SHALL registrar o erro no log de Observabilidade, notificar o Administrador e manter o agente operacional utilizando apenas o contexto da sessão atual.
10. THE Plataforma SHALL garantir que a Memória_do_Agente de um tenant não seja acessível por Agentes_de_IA de outros tenants, aplicando o isolamento Multi_Tenant ao nível de cada registro de memória.

### Requisito 8: Knowledge Hub (RAG)

**User Story:** Como administrador de uma clínica, eu quero cadastrar documentos e informações na base de conhecimento organizados por categorias, para que os agentes de IA fundamentem suas respostas em dados específicos e atualizados da minha clínica com acesso controlado por tipo de conhecimento.

#### Acceptance Criteria

1. THE Plataforma SHALL fornecer uma Knowledge_Hub por tenant onde o Administrador pode fazer upload de documentos nos formatos PDF, DOCX, TXT e MD com tamanho máximo de 20MB por arquivo e limite de 500 documentos por tenant.
2. WHEN o Administrador faz upload de um documento na Knowledge_Hub, THE Plataforma SHALL processar o documento (extração de texto, chunking e geração de embeddings) e torná-lo disponível para consulta pelos Agentes_de_IA em até 5 minutos após o upload.
3. WHEN um Agente_de_IA recebe uma consulta do usuário, THE Plataforma SHALL realizar busca semântica na Knowledge_Hub do tenant e injetar os trechos mais relevantes (top-k, configurável entre 3 e 10 chunks) no contexto do agente antes de gerar a resposta.
4. THE Plataforma SHALL suportar as seguintes categorias predefinidas de conhecimento: Institucional (informações da clínica), Procedimentos (descrição de tratamentos e protocolos), Marketing (guidelines de comunicação e campanhas anteriores), FAQ (perguntas frequentes de pacientes), Compliance (regulamentações, restrições e disclaimers obrigatórios) e Protocolos_Clínicos (protocolos de atendimento e pós-procedimento).
5. THE Plataforma SHALL permitir ao Administrador criar categorias personalizadas além das predefinidas para organizar documentos na Knowledge_Hub de acordo com necessidades específicas da Clínica.
6. WHEN o Administrador configura um Agente_de_IA, THE Plataforma SHALL permitir definir quais categorias da Knowledge_Hub o agente pode consultar, restringindo o acesso a categorias não autorizadas para o agente.
7. WHEN o Administrador remove um documento da Knowledge_Hub, THE Plataforma SHALL excluir o documento e seus embeddings associados em até 5 minutos, garantindo que consultas subsequentes dos Agentes_de_IA não retornem trechos do documento removido.
8. IF o upload de um documento falhar por formato não suportado, tamanho excedido ou erro de processamento, THEN THE Plataforma SHALL informar o motivo da falha ao Administrador e sugerir ações corretivas (reduzir tamanho, converter formato).
9. THE Plataforma SHALL exibir para cada documento na Knowledge_Hub: nome do arquivo, data de upload, tamanho, categoria, status de processamento (pendente, processado, erro) e quantidade de chunks gerados.
10. WHEN o Administrador solicita reprocessamento de um documento, THE Plataforma SHALL regenerar os embeddings do documento utilizando a configuração atual de chunking e disponibilizar a versão atualizada em até 5 minutos.

### Requisito 9: Model Registry (Catálogo de Modelos)

**User Story:** Como administrador da plataforma, eu quero gerenciar centralmente os modelos de IA disponíveis para os agentes, para que eu possa controlar custos, alternar provedores e garantir continuidade de serviço com fallback automático.

#### Acceptance Criteria

1. THE Plataforma SHALL manter um Model_Registry centralizado contendo o catálogo de modelos de IA disponíveis para uso pelos Agentes_de_IA, com suporte aos seguintes provedores: OpenAI (GPT), Anthropic (Claude), Google (Gemini), Meta (Llama), Alibaba (Qwen) e DeepSeek.
2. THE Plataforma SHALL armazenar para cada modelo no Model_Registry: provedor, nome do modelo, versão, capacidades (geração de texto, visão, embeddings), custo por token (input e output), tamanho da janela de contexto e status (disponível, deprecado, em teste).
3. WHEN o Administrador acessa o Model_Registry, THE Plataforma SHALL exibir a lista de modelos disponíveis com seus atributos, filtráveis por provedor, status e capacidade.
4. THE Plataforma SHALL permitir ao Administrador configurar quais modelos do Model_Registry estão disponíveis para uso dentro do tenant, restringindo opções conforme política de custo ou conformidade.
5. WHEN o Administrador configura um Agente_de_IA, THE Plataforma SHALL permitir selecionar o modelo padrão a partir dos modelos habilitados no Model_Registry para o tenant.
6. THE Plataforma SHALL suportar uma camada de abstração que permita troca de modelo sem alteração de código, bastando atualizar a configuração no Model_Registry.
7. WHEN o modelo primário configurado para um Agente_de_IA estiver indisponível, THE Plataforma SHALL rotear automaticamente a requisição para o modelo secundário (fallback) configurado no Model_Registry e registrar o evento no log de Observabilidade.
8. IF nenhum modelo (primário ou fallback) estiver disponível para um Agente_de_IA, THEN THE Plataforma SHALL informar ao usuário que o serviço está temporariamente indisponível e registrar o evento como alerta crítico no log de Observabilidade.
9. THE Plataforma SHALL rastrear o consumo de tokens por modelo e por tenant, integrando os dados de uso com o painel de Observabilidade para visualização de custos e volume de utilização.
10. WHEN um modelo é marcado como deprecado no Model_Registry, THE Plataforma SHALL notificar os Administradores de tenants que utilizam o modelo e sugerir alternativas disponíveis com capacidades equivalentes.

### Requisito 10: Prompt Registry

**User Story:** Como administrador da plataforma, eu quero gerenciar centralmente os prompts utilizados pelos agentes de IA, para que eu possa iterar, versionar e fazer rollback de instruções sem alterar código.

#### Acceptance Criteria

1. THE Plataforma SHALL manter um Prompt_Registry centralizado contendo todos os prompts utilizados pelos Agentes_de_IA, organizados por agente e por função (system prompt, task prompt, formatting prompt).
2. WHEN o Administrador cria ou edita um prompt no Prompt_Registry, THE Plataforma SHALL salvar a nova versão mantendo o histórico completo de versões anteriores, registrando data, autor e descrição da alteração.
3. THE Plataforma SHALL suportar versionamento semântico dos prompts (major.minor.patch) e permitir ao Administrador definir qual versão está ativa para cada Agente_de_IA.
4. WHEN o Administrador solicita rollback de um prompt para uma versão anterior, THE Plataforma SHALL ativar a versão selecionada em até 30 segundos e registrar a operação no log de Observabilidade.
5. THE Plataforma SHALL suportar variáveis de template nos prompts (exemplo: {{nome_clinica}}, {{especialidades}}, {{tom_de_voz}}) que são substituídas em tempo de execução com dados do tenant correspondente.
6. WHEN um Agente_de_IA é executado, THE Plataforma SHALL resolver o prompt ativo no Prompt_Registry, substituir as variáveis de template com dados do tenant e fornecer o prompt resolvido ao agente.
7. IF o Administrador tenta ativar uma versão de prompt que referencia variáveis de template não existentes no contexto do tenant, THEN THE Plataforma SHALL exibir um aviso listando as variáveis não resolvidas e solicitar confirmação antes de ativar.
8. THE Plataforma SHALL permitir ao Administrador testar um prompt no Prompt_Registry em modo sandbox antes de ativá-lo, exibindo a saída do Agente_de_IA com o prompt candidato sem afetar a operação em produção.

### Requisito 11: Agent Safety Guardrails

**User Story:** Como administrador de uma clínica de estética, eu quero que a plataforma imponha regras de segurança de conteúdo que nenhum agente possa violar, para que todo conteúdo gerado esteja em conformidade com regulamentações de saúde e políticas da clínica.

#### Acceptance Criteria

1. THE Plataforma SHALL aplicar Guardrails padrão que não podem ser desabilitados por nenhum usuário, incluindo: agentes não devem prometer resultados específicos de tratamentos, agentes não devem realizar diagnósticos médicos, agentes não devem prescrever medicamentos ou tratamentos, agentes não devem fazer alegações de saúde proibidas conforme regulamentações da ANVISA e CFM, e agentes não devem compartilhar dados de pacientes entre tenants.
2. THE Plataforma SHALL permitir ao Administrador criar Guardrails personalizados por tenant adicionais aos padrão, definindo regras específicas de conteúdo que os Agentes_de_IA do tenant devem respeitar.
3. WHEN um Agente_de_IA gera conteúdo, THE Plataforma SHALL validar o conteúdo contra todos os Guardrails aplicáveis (padrão e personalizados do tenant) antes de apresentar o resultado ao usuário.
4. IF o conteúdo gerado por um Agente_de_IA violar um ou mais Guardrails, THEN THE Plataforma SHALL rejeitar o conteúdo, sinalizar a violação específica ao agente e solicitar regeneração do conteúdo em conformidade.
5. WHEN uma violação de Guardrail é detectada, THE Plataforma SHALL registrar no log de Observabilidade: identificador do agente, conteúdo original, Guardrail violado, timestamp e ação tomada (regeneração ou bloqueio).
6. THE Plataforma SHALL suportar versionamento de Guardrails personalizados, mantendo histórico de alterações com data, autor e descrição, permitindo rollback para versões anteriores.
7. WHEN o Administrador cria ou edita um Guardrail personalizado, THE Plataforma SHALL aplicar a nova regra em todas as gerações subsequentes dos Agentes_de_IA do tenant em até 60 segundos.
8. IF um Agente_de_IA falhar na regeneração de conteúdo após 3 tentativas consecutivas de violação do mesmo Guardrail, THEN THE Plataforma SHALL interromper a geração, informar ao usuário que o conteúdo solicitado não pode ser gerado em conformidade com as políticas vigentes e registrar o evento no log de Observabilidade.
9. THE Plataforma SHALL permitir ao Administrador visualizar relatório de violações de Guardrails, incluindo: frequência por tipo de violação, agentes com maior incidência e tendências ao longo do tempo.

### Requisito 12: Privacidade de Dados e LGPD

**User Story:** Como administrador de uma clínica de estética, eu quero que a plataforma esteja em conformidade com a LGPD, para que os dados pessoais de leads e pacientes sejam tratados com segurança e em conformidade com a legislação brasileira de proteção de dados.

#### Acceptance Criteria

1. THE Plataforma SHALL coletar e gerenciar consentimento explícito dos titulares de dados antes de qualquer processamento de dados pessoais, registrando: data do consentimento, finalidade autorizada, forma de coleta e identificação do titular.
2. THE Plataforma SHALL suportar políticas de retenção de dados configuráveis por tenant, com valores padrão de 12 meses para dados de leads e 5 anos para dados financeiros, permitindo ao Administrador ajustar dentro dos limites legais.
3. THE Plataforma SHALL fornecer capacidade de anonimização de dados pessoais para uso em analytics e treinamento de modelos de IA, garantindo que dados anonimizados não possam ser revertidos à identificação do titular.
4. WHEN um titular de dados solicita exclusão completa de seus dados pessoais (direito ao esquecimento), THE Plataforma SHALL remover todos os dados pessoais do titular em até 15 dias corridos, incluindo dados em Memória_de_Negócio, Memória_do_Agente, Knowledge_Hub e logs, confirmando a exclusão ao solicitante.
5. THE Plataforma SHALL manter registro de tratamento de dados (ROPA) documentando: categorias de dados processados, finalidades, base legal, período de retenção e compartilhamento com terceiros para cada operação de processamento.
6. WHEN um titular de dados solicita portabilidade de seus dados, THE Plataforma SHALL exportar todos os dados pessoais do titular em formato legível por máquina (JSON ou CSV) em até 15 dias corridos.
7. THE Plataforma SHALL permitir ao Administrador configurar as informações de contato do DPO (Encarregado de Proteção de Dados) do tenant, exibindo estas informações conforme exigido pela LGPD.
8. WHEN um Agente_de_IA processa dados pessoais de um titular, THE Plataforma SHALL verificar o estado de consentimento do titular antes do processamento e registrar a operação no log de Observabilidade com detalhes do dado acessado e finalidade.
9. IF o consentimento de um titular de dados for revogado ou expirar, THEN THE Plataforma SHALL interromper imediatamente o processamento de dados pessoais do titular pelos Agentes_de_IA e notificar o Administrador sobre a necessidade de revisão.
10. THE Plataforma SHALL garantir que dados pessoais de um tenant não sejam utilizados para treinamento de modelos ou processamento em contexto de outro tenant, estendendo o isolamento Multi_Tenant ao tratamento de dados pessoais conforme LGPD.

### Requisito 13: Auditoria e Observabilidade

**User Story:** Como administrador da plataforma, eu quero ter visibilidade completa sobre as ações dos agentes de IA e dos usuários, para que eu possa auditar comportamentos, diagnosticar problemas e garantir conformidade.

#### Acceptance Criteria

1. THE Plataforma SHALL registrar em log estruturado toda ação executada por um Agente_de_IA, incluindo: timestamp, identificador do tenant, identificador do agente, tipo de ação, entrada recebida, saída gerada, duração da execução e status (sucesso ou erro).
2. THE Plataforma SHALL registrar em log estruturado toda ação relevante executada por usuários, incluindo: timestamp, identificador do tenant, identificador do usuário, tipo de ação, recurso afetado e resultado.
3. WHEN um Agente_de_IA consulta a Knowledge_Hub, THE Plataforma SHALL registrar: query realizada, chunks retornados (identificadores e scores de similaridade), prompt final montado e resposta gerada.
4. THE Plataforma SHALL reter logs de auditoria por no mínimo 12 meses, com possibilidade de exportação em formato JSON ou CSV.
5. WHEN o Administrador acessa a seção de Observabilidade, THE Plataforma SHALL exibir um painel com métricas operacionais dos Agentes_de_IA incluindo: quantidade de execuções, tempo médio de resposta, taxa de erros, consumo de tokens por modelo e por tenant, e violações de Guardrails, filtráveis por agente, período e tipo de ação.
6. IF um Agente_de_IA apresentar taxa de erros superior a 10% das execuções em uma janela de 1 hora, THEN THE Plataforma SHALL gerar um alerta automático para o Administrador do tenant indicando o agente afetado e a natureza dos erros.
7. THE Plataforma SHALL garantir que logs de auditoria sejam imutáveis após a gravação, impedindo alteração ou exclusão de registros por qualquer usuário incluindo Administradores.
8. WHEN o Administrador solicita uma consulta nos logs de auditoria com filtros (período, agente, tipo de ação, status), THE Plataforma SHALL retornar os resultados em até 10 segundos para consultas cobrindo até 30 dias de dados.
9. THE Plataforma SHALL incluir um identificador de correlação (trace_id) em todas as operações que envolvam múltiplos componentes (agente, Knowledge_Hub, Prompt_Registry, Memória_do_Agente, Memória_de_Negócio, Model_Registry, Guardrails), permitindo rastreamento ponta a ponta de uma requisição.
