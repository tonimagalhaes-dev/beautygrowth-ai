# Requirements Document

## Introduction

Integração do Designer Agent no frontend da plataforma BeautyGrowth AI. Após o Content Agent gerar conteúdo textual (legendas, hashtags e sugestões visuais), o usuário poderá acionar a geração de imagens reais diretamente pela interface, visualizando o resultado como preview no painel de resultados. A integração utiliza a API backend já implementada (POST /api/designer-agent/from-content, POST /api/designer-agent/generate, GET /api/designer-agent/executions/:id) com fluxo assíncrono (polling) para acompanhar o status da geração. Adicionalmente, o componente VisualSuggestionCard recebe um botão de copiar descrição para facilitar o uso do texto da sugestão visual.

## Glossary

- **Designer_Agent_Frontend**: Conjunto de componentes, hooks e serviços no frontend React responsáveis pela interação com a API do Designer Agent backend.
- **ResultPanel**: Componente React existente que exibe os resultados do Content Agent (legendas, hashtags, sugestões visuais) e passará a exibir também as imagens geradas pelo Designer Agent.
- **VisualSuggestionCard**: Componente React existente que exibe as sugestões visuais textuais por rede social, incluindo formato e descrição.
- **ImagePreview**: Componente React que exibe a imagem gerada pelo Designer Agent como preview (thumbnail) com opção de visualizar em tamanho completo.
- **Polling_Service**: Mecanismo de consulta periódica ao endpoint GET /api/designer-agent/executions/:id para obter o status atualizado e a URL da imagem quando a geração é concluída.
- **Content_Agent_Result**: Objeto de resultado retornado pelo Content Agent contendo executionId, legendas, hashtags e sugestões visuais por rede social.
- **Designer_Agent_Response**: Objeto de resposta retornado pela API do Designer Agent contendo executionId, status, imagens por rede social com URLs, metadados e warnings.
- **Clipboard_API**: API nativa do navegador (navigator.clipboard.writeText) utilizada para copiar texto para a área de transferência do usuário.

## Requirements

### Requirement 1: Botão de Geração de Imagem no Painel de Resultados

**User Story:** Como profissional de marketing de uma clínica, eu quero acionar a geração de imagens diretamente após visualizar o conteúdo gerado pelo Content Agent, para que eu possa obter artes visuais prontas sem sair do painel de resultados.

#### Acceptance Criteria

1. WHEN o Content_Agent_Result é exibido com sucesso no ResultPanel, THE Designer_Agent_Frontend SHALL renderizar um botão "Gerar Imagem" na seção de sugestões visuais do ResultPanel.
2. WHEN o usuário clica no botão "Gerar Imagem", THE Designer_Agent_Frontend SHALL enviar uma requisição POST ao endpoint /api/designer-agent/from-content com o campo contentExecutionId extraído do Content_Agent_Result exibido.
3. WHILE a requisição POST está em andamento (aguardando resposta 202), THE Designer_Agent_Frontend SHALL desabilitar o botão "Gerar Imagem" e exibir um indicador de carregamento (spinner) no botão.
4. WHEN a API retorna resposta 202 com executionId e status "processing", THE Designer_Agent_Frontend SHALL armazenar o executionId retornado e iniciar o Polling_Service para consultar o status da geração.
5. IF a requisição POST ao endpoint /api/designer-agent/from-content retorna erro HTTP (4xx ou 5xx), THEN THE Designer_Agent_Frontend SHALL exibir uma notificação toast com a mensagem de erro retornada pela API e reabilitar o botão "Gerar Imagem".
6. WHILE o Content_Agent_Result não está disponível no ResultPanel (resultado nulo ou carregando), THE Designer_Agent_Frontend SHALL ocultar o botão "Gerar Imagem".

### Requirement 2: Polling de Status da Geração de Imagem

**User Story:** Como profissional de marketing de uma clínica, eu quero que o sistema acompanhe automaticamente o progresso da geração de imagem, para que eu receba o resultado assim que estiver pronto sem precisar atualizar a página manualmente.

#### Acceptance Criteria

1. WHEN o Polling_Service é iniciado com um executionId, THE Designer_Agent_Frontend SHALL enviar requisições GET ao endpoint /api/designer-agent/executions/:id a cada 3 segundos até receber um status terminal ("generated", "guardrail_blocked" ou "error").
2. WHEN o Polling_Service recebe resposta com status "generated", THE Designer_Agent_Frontend SHALL interromper o polling, armazenar o Designer_Agent_Response completo e acionar a exibição do ImagePreview com as URLs das imagens retornadas.
3. IF o Polling_Service recebe resposta com status "guardrail_blocked", THEN THE Designer_Agent_Frontend SHALL interromper o polling e exibir uma notificação toast informando que a imagem não pôde ser gerada por restrições de conformidade.
4. IF o Polling_Service recebe resposta com status "error", THEN THE Designer_Agent_Frontend SHALL interromper o polling e exibir uma notificação toast com mensagem de erro genérica informando falha na geração da imagem.
5. IF o Polling_Service não receber status terminal após 120 segundos (40 tentativas a cada 3 segundos), THEN THE Designer_Agent_Frontend SHALL interromper o polling e exibir uma notificação toast informando timeout na geração, com opção de tentar novamente.
6. IF uma requisição GET do Polling_Service falhar com erro de rede (sem resposta do servidor), THEN THE Designer_Agent_Frontend SHALL realizar até 3 tentativas consecutivas antes de interromper o polling e exibir mensagem de erro de conectividade.
7. WHILE o Polling_Service está ativo, THE Designer_Agent_Frontend SHALL exibir um indicador de progresso (skeleton loader ou animação) na área onde o ImagePreview será renderizado.

### Requirement 3: Exibição de Preview da Imagem Gerada

**User Story:** Como profissional de marketing de uma clínica, eu quero visualizar as imagens geradas diretamente no painel de resultados, para que eu possa avaliar a arte antes de baixar ou publicar.

#### Acceptance Criteria

1. WHEN o Designer_Agent_Response com status "generated" é recebido, THE Designer_Agent_Frontend SHALL renderizar o ImagePreview para cada rede social que possui imagem gerada, utilizando a URL do thumbnail (urlThumbnail) do Designer_Agent_Response.
2. THE Designer_Agent_Frontend SHALL exibir o ImagePreview agrupado por rede social, mostrando o nome da rede social e o aspecto ratio como legenda abaixo de cada imagem.
3. WHEN o usuário clica em um ImagePreview (thumbnail), THE Designer_Agent_Frontend SHALL abrir a imagem em resolução completa (url original) em um componente dialog modal com opção de fechar.
4. THE Designer_Agent_Frontend SHALL exibir junto ao ImagePreview um botão "Download" que inicia o download da imagem em resolução completa (url original do Designer_Agent_Response) no navegador do usuário.
5. IF a URL do thumbnail retornar erro de carregamento (imagem não encontrada ou expirada), THEN THE Designer_Agent_Frontend SHALL exibir um placeholder com ícone de imagem quebrada e texto informando que o preview não está disponível.
6. WHEN o Designer_Agent_Response contém o campo warnings com itens, THE Designer_Agent_Frontend SHALL exibir os warnings como badges informativas abaixo do ImagePreview correspondente.

### Requirement 4: Botão de Copiar Descrição na Sugestão Visual

**User Story:** Como profissional de marketing de uma clínica, eu quero copiar a descrição da sugestão visual com um único clique, para que eu possa usar o texto em outras ferramentas sem ter que selecionar e copiar manualmente.

#### Acceptance Criteria

1. THE Designer_Agent_Frontend SHALL renderizar um botão com ícone de "copiar" (clipboard icon) no VisualSuggestionCard, posicionado na área de ações do card junto à descrição da sugestão visual.
2. WHEN o usuário clica no botão de copiar, THE Designer_Agent_Frontend SHALL copiar o texto completo do campo "descricao" da sugestão visual correspondente para a área de transferência do sistema operacional utilizando a Clipboard_API.
3. WHEN a cópia para a área de transferência é concluída com sucesso, THE Designer_Agent_Frontend SHALL exibir feedback visual temporário (ícone mudando para "check" por 2 segundos) e uma notificação toast confirmando que a descrição foi copiada.
4. IF a Clipboard_API não estiver disponível ou a operação de cópia falhar (permissão negada ou erro de execução), THEN THE Designer_Agent_Frontend SHALL exibir uma notificação toast informando que a cópia falhou e sugerindo copiar manualmente.
5. THE Designer_Agent_Frontend SHALL posicionar o botão de copiar de forma acessível, com atributo aria-label descritivo ("Copiar descrição visual para {rede social}") e suportando ativação por teclado (Enter e Space).

### Requirement 5: Serviço de API do Designer Agent no Frontend

**User Story:** Como desenvolvedor do frontend, eu quero um serviço dedicado para comunicação com a API do Designer Agent, para que a integração seja encapsulada, reutilizável e testável.

#### Acceptance Criteria

1. THE Designer_Agent_Frontend SHALL expor um módulo de serviço (designer-agent.service) que encapsula todas as chamadas HTTP à API do Designer Agent, utilizando a instância apiClient existente com interceptors de autenticação e tratamento de erro 401.
2. THE Designer_Agent_Frontend SHALL expor no serviço o método fromContent que aceita contentExecutionId (obrigatório), aplicarLogoOverlay (opcional, booleano) e estiloVisualAdicional (opcional, string) e retorna uma Promise com o objeto {executionId, status}.
3. THE Designer_Agent_Frontend SHALL expor no serviço o método getExecution que aceita executionId (obrigatório) e retorna uma Promise com o Designer_Agent_Response completo.
4. THE Designer_Agent_Frontend SHALL expor um hook customizado (useDesignerAgent) que gerencia o ciclo de vida completo: trigger da geração, polling automático, estado da geração (idle, processing, generated, error) e o resultado final.
5. THE Designer_Agent_Frontend SHALL tipar todas as interfaces de request e response do Designer Agent em um módulo de tipos dedicado (types/designer-agent.ts), incluindo: GenerateFromContentRequest, DesignerAgentExecution, ImageResult e DesignerAgentStatus.

### Requirement 6: Estados de Interface e Feedback ao Usuário

**User Story:** Como profissional de marketing de uma clínica, eu quero feedback visual claro durante todo o processo de geração de imagem, para que eu saiba o que está acontecendo e o que esperar em cada momento.

#### Acceptance Criteria

1. WHILE o Designer_Agent_Frontend está no estado "idle" (nenhuma geração em andamento), THE Designer_Agent_Frontend SHALL exibir o botão "Gerar Imagem" em estado habilitado com estilo padrão (cor primária).
2. WHILE o Designer_Agent_Frontend está no estado "processing" (polling ativo), THE Designer_Agent_Frontend SHALL exibir: botão "Gerar Imagem" desabilitado, indicador de carregamento na área de preview com texto "Gerando imagem..." e uma barra de progresso indeterminada (animação de pulso).
3. WHEN o Designer_Agent_Frontend transiciona para o estado "generated", THE Designer_Agent_Frontend SHALL substituir o indicador de carregamento pelo ImagePreview com transição suave (fade-in) e reabilitar o botão "Gerar Imagem" com texto "Gerar Nova Imagem".
4. WHEN o Designer_Agent_Frontend transiciona para o estado "error" ou "guardrail_blocked", THE Designer_Agent_Frontend SHALL substituir o indicador de carregamento por uma mensagem de erro contextual na área de preview e reabilitar o botão "Gerar Imagem" para permitir nova tentativa.
5. IF o usuário navegar para outra página enquanto o polling está ativo, THEN THE Designer_Agent_Frontend SHALL cancelar o polling para evitar vazamento de memória e requisições desnecessárias ao servidor.
6. WHEN o usuário retorna ao ResultPanel e existe uma geração previamente concluída (Designer_Agent_Response armazenado), THE Designer_Agent_Frontend SHALL exibir o ImagePreview com os dados da última geração sem necessidade de nova requisição.
