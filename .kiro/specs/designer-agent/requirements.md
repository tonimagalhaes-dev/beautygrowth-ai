# Requirements Document

## Introduction

O **Designer Agent** é a evolução do Content Agent MVP da plataforma BeautyGrowth AI, adicionando a capacidade de gerar imagens reais para redes sociais em vez de apenas sugestões textuais de composição visual. O agente é orquestrado como workflow LangGraph e utiliza o modelo `gemini-3.1-flash-image` para geração de imagens. Cada imagem é gerada com dimensões específicas por rede social (Instagram 4:5, Facebook 1.91:1, TikTok 9:16), com prompt automático construído a partir da descrição visual e identidade da marca da clínica. As imagens são armazenadas no MinIO com URL pública e exibidas no frontend com preview. O agente suporta edição iterativa multiturno e overlay opcional do logo da clínica. Não inclui geração de vídeo, publicação direta nas redes sociais, agendamento de posts ou gerenciamento de campanhas.

## Glossary

- **Designer_Agent**: Agente de IA especializado em geração de imagens para redes sociais, executado como workflow no LangGraph Service, utilizando modelo de geração de imagens.
- **Imagem_Gerada**: Arquivo de imagem produzido pelo Designer_Agent, armazenado no MinIO com URL pública acessível.
- **Prompt_Visual**: Texto construído automaticamente pelo Designer_Agent para instruir o modelo de geração de imagens, composto pela descrição visual do conteúdo e elementos da identidade da marca.
- **Rede_Social**: Plataforma de mídia social alvo para a imagem gerada. Redes suportadas: Instagram, Facebook e TikTok.
- **Aspecto_Ratio**: Proporção dimensional da imagem adequada para cada Rede_Social: Instagram (4:5, 1080x1350px), Facebook (1.91:1, 1200x628px), TikTok (9:16, 1080x1920px).
- **Identidade_Marca**: Conjunto de atributos visuais e textuais da clínica armazenados na Business Memory, incluindo: paleta de cores, tom de voz, estilo visual preferido e valores da marca.
- **Logo_Overlay**: Sobreposição do logotipo da clínica na imagem gerada, posicionada de forma não obstrutiva.
- **Edição_Iterativa**: Capacidade de solicitar ajustes em uma imagem previamente gerada, mantendo o contexto visual e textual da geração original.
- **MinIO_Storage**: Serviço de armazenamento de objetos compatível com S3 utilizado para persistir as imagens geradas com URL pública.
- **Nó_Generate_Visual**: Nó específico no workflow LangGraph do Designer_Agent responsável pela chamada ao modelo de geração de imagens.
- **Guardrail_Visual**: Regras de validação aplicadas às imagens geradas para garantir conformidade regulatória (ANVISA/CFM) e políticas do tenant.

## Requirements

### Requirement 1: Recebimento e Validação da Solicitação de Imagem

**User Story:** Como profissional de marketing de uma clínica, eu quero solicitar a geração de imagens informando a descrição visual desejada e as redes sociais alvo, para que o Designer Agent produza artes adequadas para cada plataforma.

#### Acceptance Criteria

1. WHEN o usuário submete uma solicitação de geração de imagem via endpoint da API, THE Designer_Agent SHALL aceitar os seguintes campos: descrição visual (obrigatório, mínimo 10 caracteres úteis excluindo espaços em branco nas extremidades, máximo 1000 caracteres), seleção de redes sociais (obrigatório, ao menos 1 e no máximo 3 valores dentre Instagram, Facebook e TikTok), execution_id do Content_Agent (opcional, para vincular à geração de conteúdo existente), aplicar logo overlay (opcional, booleano, padrão false) e estilo visual adicional (opcional, máximo 300 caracteres).
2. IF a solicitação for submetida sem descrição visual, com descrição visual contendo menos de 10 caracteres úteis após trim, ou sem ao menos uma Rede_Social selecionada, THEN THE Designer_Agent SHALL rejeitar a requisição com código de erro 422 e mensagem indicando os campos obrigatórios ausentes ou inválidos.
3. IF o campo descrição visual exceder 1000 caracteres ou o campo estilo visual adicional exceder 300 caracteres, THEN THE Designer_Agent SHALL rejeitar a requisição com código de erro 422 e mensagem indicando o campo e o limite violado.
4. IF a seleção de redes sociais contiver um valor que não pertence à lista suportada (Instagram, Facebook, TikTok), THEN THE Designer_Agent SHALL rejeitar a requisição com código de erro 422 e mensagem indicando o valor inválido e a lista de redes sociais permitidas.
5. WHEN a solicitação é aceita e passa em todas as validações, THE Designer_Agent SHALL associar a execução ao tenant_id e user_id extraídos do contexto de autenticação, gerar um execution_id único (formato UUID v4) e retornar resposta com status 202 contendo o execution_id gerado e o status "processing".
6. IF a solicitação referencia um execution_id do Content_Agent, THEN THE Designer_Agent SHALL carregar a Sugestão_Visual e o contexto do conteúdo gerado para incorporar como diretriz adicional de composição no Prompt_Visual.
7. IF a solicitação referencia um execution_id do Content_Agent que não existe ou não pertence ao tenant do usuário, THEN THE Designer_Agent SHALL rejeitar a requisição com código de erro 404 e mensagem indicando que o conteúdo referenciado não foi encontrado, sem revelar se o execution_id existe para outro tenant.

### Requirement 2: Construção Automática do Prompt Visual

**User Story:** Como profissional de marketing de uma clínica, eu quero que o agente construa automaticamente um prompt de geração de imagem que incorpore a identidade visual da minha clínica, para que as artes geradas sejam coerentes com a comunicação da marca.

#### Acceptance Criteria

1. WHEN a solicitação de imagem é aceita, THE Designer_Agent SHALL carregar da Business Memory do tenant a Identidade_Marca: paleta de cores (valores hexadecimais), estilo visual preferido, valores da marca e elementos visuais recorrentes.
2. WHEN o Designer_Agent constrói o Prompt_Visual, THE Designer_Agent SHALL combinar: a descrição visual do usuário, os atributos da Identidade_Marca do tenant, o Aspecto_Ratio correspondente à Rede_Social alvo e o estilo visual adicional quando informado.
3. THE Designer_Agent SHALL resolver o template de prompt do Prompt_Registry para o agent_type designer, substituindo variáveis de template (descricao_visual, paleta_cores, estilo_visual, aspecto_ratio, nome_clinica) com dados do contexto carregado.
4. IF a Business Memory do tenant não possuir Identidade_Marca configurada (paleta de cores ausente), THEN THE Designer_Agent SHALL utilizar valores padrão da plataforma (paleta neutra em tons de branco, cinza e dourado) e incluir flag indicando uso de defaults na resposta.
5. WHEN a solicitação referencia um execution_id do Content_Agent, THE Designer_Agent SHALL incorporar ao Prompt_Visual a Sugestão_Visual correspondente à Rede_Social sendo gerada, utilizando a descrição textual como diretriz adicional de composição.

### Requirement 3: Geração de Imagem por Rede Social

**User Story:** Como profissional de marketing de uma clínica, eu quero receber uma imagem com dimensões adequadas para cada rede social selecionada, para que eu possa publicar artes prontas sem necessidade de redimensionamento manual.

#### Acceptance Criteria

1. WHEN o Prompt_Visual é construído, THE Designer_Agent SHALL invocar o modelo de geração de imagem (via Model_Registry) para cada Rede_Social selecionada, gerando uma Imagem_Gerada com o Aspecto_Ratio correspondente: Instagram (4:5, 1080x1350px), Facebook (1.91:1, 1200x628px) e TikTok (9:16, 1080x1920px).
2. THE Designer_Agent SHALL gerar as imagens para todas as redes sociais selecionadas em paralelo, respeitando os limites de rate limiting configurados no Model_Registry para o modelo selecionado, e processando sequencialmente apenas quando o número de redes sociais selecionadas exceder o limite de requisições simultâneas permitido.
3. THE Designer_Agent SHALL selecionar o modelo de geração de imagem a partir do Model_Registry conforme configuração do tenant, utilizando o modelo primário configurado para o Designer_Agent.
4. IF o modelo primário de geração de imagem retornar erro HTTP 5xx, timeout de conexão ou não responder dentro de 60 segundos, THEN THE Designer_Agent SHALL considerar o modelo indisponível, utilizar o modelo de fallback configurado no Model_Registry e incluir flag indicando uso de fallback na resposta.
5. WHEN a geração de imagem é concluída com sucesso, THE Designer_Agent SHALL retornar a Imagem_Gerada em formato PNG com qualidade mínima de 72 DPI e tamanho máximo de 10 MB por imagem.
6. IF a geração de imagem falhar para uma ou mais redes sociais selecionadas mas for concluída com sucesso para ao menos uma, THEN THE Designer_Agent SHALL retornar as imagens geradas com sucesso juntamente com o status de erro por rede social que falhou, permitindo ao usuário solicitar nova geração apenas para as redes com falha.
7. IF a geração de imagem falhar para todas as redes sociais selecionadas após tentativa com modelo primário e fallback, THEN THE Designer_Agent SHALL retornar código de erro 503 com mensagem indicando falha na geração de imagens e registrar o evento na Observabilidade.

### Requirement 4: Upload e Armazenamento no MinIO

**User Story:** Como profissional de marketing de uma clínica, eu quero que as imagens geradas sejam armazenadas com URL pública acessível, para que eu possa visualizar, baixar e usar as artes diretamente.

#### Acceptance Criteria

1. WHEN uma Imagem_Gerada é produzida com sucesso, THE Designer_Agent SHALL realizar upload do arquivo para o MinIO_Storage no bucket do tenant, utilizando path: `{tenant_id}/designer/{execution_id}/{rede_social}_{timestamp}.png`, onde timestamp segue o formato UTC compacto `YYYYMMDDHHmmssSSS` (ano, mês, dia, hora, minuto, segundo, milissegundos).
2. WHEN o upload é concluído, THE Designer_Agent SHALL gerar uma URL pública pré-assinada com validade de 7 dias para acesso à Imagem_Gerada.
3. THE Designer_Agent SHALL persistir os metadados da Imagem_Gerada no banco de dados incluindo: execution_id, tenant_id, user_id, rede social, aspecto ratio, URL do MinIO, tamanho do arquivo em bytes, modelo utilizado e timestamp de criação.
4. IF o upload ao MinIO_Storage falhar, THEN THE Designer_Agent SHALL realizar até 3 tentativas com backoff exponencial (1s, 2s, 4s) antes de retornar código de erro 503 com mensagem indicando falha no armazenamento.
5. IF a URL pré-assinada expirar após 7 dias, THEN THE Designer_Agent SHALL gerar uma nova URL pré-assinada com validade de 7 dias quando o usuário solicitar acesso à Imagem_Gerada.
6. IF o tamanho da Imagem_Gerada exceder 10 MB, THEN THE Designer_Agent SHALL rejeitar o upload e retornar código de erro 413 com mensagem indicando que o arquivo excede o limite máximo permitido de 10 MB.

### Requirement 5: Overlay de Logo da Clínica

**User Story:** Como proprietária de uma clínica, eu quero que o logo da minha clínica seja aplicado sobre as imagens geradas quando solicitado, para que as artes publicadas reforcem a identidade visual da marca.

#### Acceptance Criteria

1. WHEN a solicitação inclui aplicar logo overlay como true e a clínica possui logo cadastrado na Business Memory, THE Designer_Agent SHALL aplicar o logo da clínica sobre a Imagem_Gerada após a geração.
2. THE Designer_Agent SHALL posicionar o Logo_Overlay no canto inferior direito da imagem com opacidade de 80%, dimensionado para ocupar no máximo 15% da largura total da imagem, mantendo a proporção (aspect ratio) original do logo.
3. THE Designer_Agent SHALL manter uma margem de segurança de 3% das bordas da imagem ao posicionar o Logo_Overlay.
4. IF a solicitação inclui aplicar logo overlay como true e a clínica não possui logo cadastrado na Business Memory, THEN THE Designer_Agent SHALL gerar a imagem sem overlay e incluir warning na resposta indicando que o logo não está cadastrado.
5. WHEN o Logo_Overlay é aplicado, THE Designer_Agent SHALL armazenar a versão final (com overlay) como a Imagem_Gerada principal e manter a versão sem overlay como variante acessível via campo "url_sem_overlay" na resposta da API.
6. IF o processamento do Logo_Overlay falhar (logo corrompido, formato incompatível ou erro de processamento), THEN THE Designer_Agent SHALL retornar a imagem sem overlay como resultado principal e incluir warning na resposta indicando falha na aplicação do logo.

### Requirement 6: Edição Iterativa de Imagens (Multiturno)

**User Story:** Como profissional de marketing de uma clínica, eu quero solicitar ajustes na imagem gerada sem perder o contexto visual da geração original, para que eu possa iterar até obter o resultado visual desejado.

#### Acceptance Criteria

1. WHEN o usuário submete uma solicitação de Edição_Iterativa referenciando um execution_id existente e uma Rede_Social específica, THE Designer_Agent SHALL carregar o contexto da execução original (Prompt_Visual utilizado, Identidade_Marca, descrição visual original e histórico cumulativo de edições anteriores) e aplicar os ajustes solicitados.
2. THE Designer_Agent SHALL aceitar no máximo 5 Edições_Iterativas por execution_id original por Rede_Social, retornando código de erro 429 com mensagem indicando o limite atingido quando excedido.
3. WHEN uma Edição_Iterativa é processada, THE Designer_Agent SHALL reconstruir o Prompt_Visual incorporando o histórico cumulativo de todas as edições anteriores e a nova instrução de edição do usuário (obrigatório, máximo 500 caracteres) como diretrizes adicionais, mantendo os elementos de Identidade_Marca e Aspecto_Ratio da geração original. IF a instrução de edição exceder 500 caracteres, THEN THE Designer_Agent SHALL rejeitar com código de erro 422.
4. WHEN uma Edição_Iterativa é concluída com sucesso, THE Designer_Agent SHALL armazenar a nova Imagem_Gerada como versão atualizada, incrementando o campo version (iniciando em 1 na geração original), mantendo todas as versões anteriores acessíveis.
5. IF o execution_id referenciado na Edição_Iterativa não existir ou não pertencer ao tenant do usuário, THEN THE Designer_Agent SHALL retornar código de erro 404 sem revelar se o execution_id existe para outro tenant.
6. IF a geração de imagem falhar durante uma Edição_Iterativa, THEN THE Designer_Agent SHALL retornar código de erro 503 sem incrementar o contador de edições e registrar o evento na Observabilidade, permitindo que o usuário tente novamente sem perder uma das 5 tentativas disponíveis.

### Requirement 7: Validação de Guardrails Visuais

**User Story:** Como administrador de uma clínica, eu quero que as imagens geradas sejam validadas contra regras regulatórias, para que a clínica não publique conteúdo visual que viole normas da ANVISA ou CFM.

#### Acceptance Criteria

1. WHEN o Designer_Agent constrói o Prompt_Visual, THE Designer_Agent SHALL incluir instruções negativas (negative prompts) proibindo: imagens de antes/depois de procedimentos, representações de profissionais não identificados, nudez explícita, elementos que configurem propaganda irregular de serviços de saúde e marcas de terceiros não autorizadas.
2. WHEN uma Imagem_Gerada é produzida, THE Designer_Agent SHALL validar o Prompt_Visual utilizado contra os Guardrails padrão da plataforma e os Guardrails personalizados do tenant antes de realizar upload ao MinIO e disponibilizar o resultado ao usuário, com timeout máximo de 10 segundos para a validação.
3. IF um Guardrail_Visual é violado na validação do prompt, THEN THE Designer_Agent SHALL reconstruir o Prompt_Visual removendo os elementos violadores e regenerar a imagem automaticamente.
4. IF o Designer_Agent falhar na regeneração após 3 tentativas consecutivas para a mesma violação de Guardrail_Visual, THEN THE Designer_Agent SHALL interromper a execução, retornar código de erro 422 com mensagem indicando que a imagem solicitada não pode ser gerada em conformidade com as políticas vigentes e registrar o bloqueio no log de Observabilidade.
5. WHEN uma violação de Guardrail_Visual é detectada em qualquer tentativa, THE Designer_Agent SHALL registrar no log de Observabilidade: execution_id, trace_id, regra violada, tentativa número e trecho do prompt que causou a violação (máximo 200 caracteres do trecho).
6. IF os Guardrails personalizados do tenant estiverem indisponíveis (timeout ou erro), THEN THE Designer_Agent SHALL aplicar apenas os Guardrails padrão da plataforma e incluir warning na resposta indicando que guardrails personalizados não foram aplicados.

### Requirement 8: Exibição de Preview no Frontend

**User Story:** Como profissional de marketing de uma clínica, eu quero visualizar as imagens geradas diretamente no painel web com preview em tempo real, para que eu possa avaliar e aprovar as artes antes de uso.

#### Acceptance Criteria

1. WHEN o Designer_Agent conclui a geração de imagens, THE Designer_Agent SHALL retornar na resposta da API: URL pública de cada Imagem_Gerada por Rede_Social, URL do thumbnail correspondente, metadados (rede social, aspecto ratio, tamanho do arquivo em bytes, modelo utilizado) e status da geração com valor "generated".
2. THE Designer_Agent SHALL gerar um thumbnail de cada Imagem_Gerada em formato JPEG com qualidade de 80%, largura máxima de 400px mantendo o Aspecto_Ratio original, resultando em arquivo de no máximo 200KB, armazenando no MinIO_Storage junto ao arquivo original.
3. WHEN o usuário solicita o download de uma Imagem_Gerada em resolução completa, THE Designer_Agent SHALL retornar a URL pré-assinada do arquivo original em formato PNG com validade de 7 dias.
4. WHEN a geração de imagens é concluída com sucesso, THE Designer_Agent SHALL retornar a resposta completa com status "generated" contendo: imagens por rede social (URL do original e URL do thumbnail), execution_id, modelo utilizado, tokens consumidos, flag de fallback, flag de logo overlay aplicado e version.
5. IF a geração do thumbnail falhar para uma ou mais Imagem_Gerada, THEN THE Designer_Agent SHALL retornar a URL do arquivo original no campo thumbnail como fallback e incluir warning na resposta indicando quais redes sociais tiveram falha na geração de thumbnail.

### Requirement 9: Integração com Content Agent

**User Story:** Como profissional de marketing de uma clínica, eu quero que o Designer Agent possa ser invocado automaticamente após a geração de conteúdo textual, para que eu receba um pacote completo de legenda e imagem prontos para publicação.

#### Acceptance Criteria

1. WHEN o Content_Agent finaliza a geração de conteúdo com sucesso, THE Designer_Agent SHALL expor um endpoint que aceita o execution_id do Content_Agent como parâmetro de entrada para iniciar a geração de imagens vinculadas ao conteúdo textual produzido, respondendo dentro de 5 segundos com o execution_id próprio do Designer_Agent ou um código de erro.
2. WHEN invocado a partir de um execution_id do Content_Agent, THE Designer_Agent SHALL carregar da Agent Memory os dados da execução do Content_Agent e utilizar automaticamente: o campo "descricao" da Sugestão_Visual correspondente a cada Rede_Social como descrição visual base do Prompt_Visual, as mesmas redes sociais presentes na execução original do Content_Agent e a Identidade_Marca do tenant já carregada na Business Memory.
3. THE Designer_Agent SHALL incluir na resposta da API o campo content_execution_id contendo o execution_id do Content_Agent vinculado, além dos campos padrão (execution_id próprio, URLs de imagens por Rede_Social, thumbnails, metadados e status), de modo que o frontend possa correlacionar legendas do Content_Agent com as imagens geradas pelo Designer_Agent em uma única visualização.
4. IF o Designer_Agent é invocado com um execution_id do Content_Agent cujo status é diferente de "draft" ou "approved", THEN THE Designer_Agent SHALL rejeitar a requisição com código de erro 409 e mensagem indicando que o conteúdo vinculado possui status incompatível, sem revelar o status atual do conteúdo na mensagem de erro.
5. IF o execution_id do Content_Agent informado não existir na Agent Memory ou não pertencer ao tenant do usuário autenticado, THEN THE Designer_Agent SHALL retornar código de erro 404 com mensagem indicando que a execução de conteúdo não foi encontrada, sem revelar se o execution_id existe para outro tenant.
6. IF a execução do Content_Agent referenciada não possuir Sugestão_Visual para ao menos uma das redes sociais selecionadas, THEN THE Designer_Agent SHALL rejeitar a requisição com código de erro 422 e mensagem indicando que o conteúdo vinculado não possui sugestão visual disponível para as redes solicitadas.

### Requirement 10: Persistência, Observabilidade e Tratamento de Erros

**User Story:** Como administrador da plataforma, eu quero que todas as execuções do Designer Agent sejam rastreáveis e que falhas sejam tratadas de forma resiliente, para que eu possa monitorar o comportamento do agente e diagnosticar problemas.

#### Acceptance Criteria

1. WHEN o Designer_Agent finaliza uma execução (sucesso ou falha), THE Designer_Agent SHALL persistir a interação na Agent Memory de curto prazo do tenant com retenção de 30 dias, incluindo: solicitação original, Prompt_Visual construído, URLs das imagens geradas, violações de guardrail e metadados de execução (execution_id, trace_id, tenant_id, user_id, timestamp de início e fim, duração em milissegundos).
2. WHEN o Designer_Agent finaliza uma execução, THE Designer_Agent SHALL registrar no log de Observabilidade com nível INFO para sucesso e nível ERROR para falha: trace_id, execution_id, tenant_id, user_id, duração total em milissegundos, tokens consumidos pelo modelo de imagem, modelo utilizado, quantidade de imagens geradas, quantidade de violações de guardrail e status final (success, guardrail_blocked, error).
3. IF o serviço de geração de imagem (Model Registry) não responder dentro de 30 segundos e nenhum modelo de fallback responder dentro de 30 segundos, THEN THE Designer_Agent SHALL retornar código de erro 503 com mensagem indicando indisponibilidade temporária do serviço de geração de imagens, e registrar o evento com nível CRITICAL na Observabilidade.
4. IF a Business Memory ou Knowledge_Hub não responder dentro de 10 segundos durante o carregamento de contexto, THEN THE Designer_Agent SHALL retornar código de erro 503 com mensagem indicando falha no carregamento de contexto e registrar o evento com nível CRITICAL na Observabilidade.
5. IF a persistência na Agent Memory falhar após até 2 tentativas com intervalo de 1 segundo entre elas, THEN THE Designer_Agent SHALL retornar as imagens geradas ao usuário normalmente e registrar a falha de persistência com nível WARNING na Observabilidade incluindo execution_id, trace_id e descrição do erro.
6. WHEN o Designer_Agent executa, THE Designer_Agent SHALL propagar o trace_id recebido na requisição (ou gerar um novo UUID v4 caso ausente) para todas as chamadas internas (Model Registry, MinIO, Business Memory, Agent Memory) permitindo correlação end-to-end.
7. IF o registro no log de Observabilidade falhar, THEN THE Designer_Agent SHALL continuar a execução normalmente sem impactar a resposta ao usuário e persistir o evento de falha de logging em fallback local (stdout) para recuperação posterior.
