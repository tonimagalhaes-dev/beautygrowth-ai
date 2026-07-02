# Requirements Document

## Introduction

O **Frontend MVP** é a aplicação SPA (Single Page Application) construída com Vite + React 18 + TypeScript + Tailwind CSS + shadcn/ui para demonstração do BeautyGrowth AI Content Agent a clientes. A aplicação contém 4 telas principais: Login, Onboarding da Clínica (2 etapas), Geração de Conteúdo e Refinamento. Integra-se ao backend NestJS via API REST com autenticação JWT. O objetivo é fornecer uma interface limpa, moderna e funcional (estética SaaS similar a Linear/Notion) para que clientes possam experimentar o fluxo completo do Content Agent — desde o cadastro da clínica até a geração e refinamento de conteúdo para redes sociais. Não inclui: registro de usuários, multi-tenant switching, settings page, Knowledge Hub upload UI, agent configuration UI ou observability dashboard.

## Glossary

- **SPA**: Single Page Application — aplicação web que carrega uma única página HTML e atualiza o conteúdo dinamicamente via JavaScript.
- **JWT**: JSON Web Token — token de autenticação utilizado para autorizar requisições à API backend.
- **Onboarding**: Fluxo guiado de cadastro inicial da clínica e configuração de identidade da marca.
- **Briefing**: Conjunto de informações fornecidas pelo usuário para direcionar a geração de conteúdo (tema, procedimento, redes sociais, público-alvo, idioma).
- **Refinamento**: Processo iterativo de ajuste do conteúdo gerado, com limite de 5 iterações por execução.
- **Content_Agent**: Agente de IA do backend responsável por gerar conteúdo textual para redes sociais.
- **Identidade_da_Marca**: Configuração visual e textual da clínica (tom de voz, paleta de cores, logotipo, público-alvo, diferenciais, valores).
- **Toast**: Notificação visual temporária exibida no canto da tela para feedback de sucesso ou erro.
- **Protected_Route**: Rota que requer autenticação válida (JWT) para ser acessada.

## Requirements

### Requirement 1: Autenticação e Gerenciamento de Sessão

**User Story:** Como usuário da plataforma, eu quero fazer login com e-mail e senha e manter minha sessão ativa, para que eu possa acessar as funcionalidades do Content Agent de forma segura.

#### Acceptance Criteria

1. WHEN o usuário acessa a aplicação sem token JWT válido em localStorage, THE aplicação SHALL redirecionar automaticamente para a tela de Login.
2. WHEN o usuário submete o formulário de login com e-mail e senha, THE aplicação SHALL enviar uma requisição POST para /api/auth/login com as credenciais e aguardar a resposta.
3. WHEN a API retorna sucesso (200) com um token JWT, THE aplicação SHALL armazenar o token em localStorage e redirecionar o usuário para a tela apropriada: Onboarding (se a clínica não estiver configurada) ou Geração de Conteúdo (se a clínica já estiver configurada).
4. IF a API retorna erro de autenticação (401), THEN THE aplicação SHALL exibir uma mensagem de erro inline no formulário indicando credenciais inválidas, sem limpar o campo de e-mail.
5. WHEN o usuário está autenticado, THE aplicação SHALL incluir o token JWT no header Authorization (formato Bearer) em todas as requisições subsequentes à API.
6. IF qualquer requisição à API retornar erro 401 (token expirado ou inválido), THEN THE aplicação SHALL remover o token de localStorage e redirecionar o usuário para a tela de Login.
7. WHEN o formulário de login é submetido, THE aplicação SHALL exibir um loading spinner no botão de submit e desabilitar o formulário até receber a resposta da API.

### Requirement 2: Onboarding da Clínica — Etapa 1 (Dados da Clínica)

**User Story:** Como proprietário de uma clínica de estética, eu quero cadastrar as informações básicas da minha clínica no primeiro acesso, para que o Content Agent possa personalizar o conteúdo gerado.

#### Acceptance Criteria

1. WHEN o usuário autenticado acessa a aplicação e a clínica não está configurada, THE aplicação SHALL exibir a tela de Onboarding na Etapa 1 com um formulário contendo os campos: nome da clínica (obrigatório, texto), telefone (obrigatório, máscara brasileira), e-mail (obrigatório, validação de formato), especialidades (obrigatório, multi-select) e público-alvo (obrigatório, textarea).
2. WHEN o usuário preenche todos os campos obrigatórios e submete o formulário, THE aplicação SHALL enviar uma requisição POST para /api/clinics com os dados e, em caso de sucesso (201), avançar para a Etapa 2 do Onboarding.
3. IF algum campo obrigatório estiver vazio ou com formato inválido, THEN THE aplicação SHALL exibir mensagens de validação inline junto ao campo correspondente e impedir a submissão.
4. IF a API retornar erro (422 ou 5xx), THEN THE aplicação SHALL exibir um toast de erro com a mensagem retornada pela API e manter os dados preenchidos no formulário.
5. WHEN o formulário está sendo submetido, THE aplicação SHALL exibir um loading spinner no botão de submit e desabilitar o formulário até a resposta.
6. THE aplicação SHALL exibir um indicador de progresso (step indicator) mostrando que o usuário está na etapa 1 de 2.

### Requirement 3: Onboarding da Clínica — Etapa 2 (Identidade da Marca)

**User Story:** Como proprietário de uma clínica de estética, eu quero definir a identidade visual e tom de voz da minha marca, para que todo conteúdo gerado reflita a personalidade da minha clínica.

#### Acceptance Criteria

1. WHEN o usuário completa a Etapa 1 do Onboarding, THE aplicação SHALL exibir a Etapa 2 com um formulário contendo os campos: tom de voz (obrigatório, textarea, máximo 500 caracteres), paleta de cores (obrigatório, ao menos 1 cor, color pickers), logotipo (opcional, upload de imagem PNG/JPG/SVG até 5MB), público-alvo (obrigatório, textarea, máximo 300 caracteres), diferenciais (obrigatório, ao menos 1 item, máximo 5 itens de até 200 caracteres cada) e valores da clínica (obrigatório, ao menos 1 item, máximo 5 itens de até 200 caracteres cada).
2. WHEN o usuário preenche os campos obrigatórios e submete o formulário, THE aplicação SHALL enviar uma requisição POST para /api/brands com os dados (incluindo upload do logotipo se fornecido) e, em caso de sucesso (201), redirecionar para a tela de Geração de Conteúdo.
3. IF algum campo obrigatório estiver vazio ou acima dos limites de caracteres, THEN THE aplicação SHALL exibir mensagens de validação inline e impedir a submissão.
4. IF o usuário tenta fazer upload de logotipo com formato não suportado ou tamanho acima de 5MB, THEN THE aplicação SHALL exibir mensagem de erro junto ao campo de upload indicando a restrição violada.
5. IF a API retornar erro, THEN THE aplicação SHALL exibir um toast de erro e manter os dados preenchidos no formulário.
6. THE aplicação SHALL permitir ao usuário voltar para a Etapa 1 para corrigir dados sem perder os dados já preenchidos na Etapa 2.
7. THE aplicação SHALL exibir o indicador de progresso mostrando que o usuário está na etapa 2 de 2.

### Requirement 4: Geração de Conteúdo

**User Story:** Como profissional de marketing de uma clínica, eu quero preencher um briefing e receber conteúdo gerado por IA para diferentes redes sociais, para que eu possa publicar conteúdo otimizado rapidamente.

#### Acceptance Criteria

1. WHEN o usuário autenticado com clínica configurada acessa a tela de Geração de Conteúdo, THE aplicação SHALL exibir um layout dividido em dois painéis: painel esquerdo com formulário de briefing e painel direito para exibição do resultado.
2. THE aplicação SHALL exibir no painel esquerdo um formulário de briefing contendo: tema (obrigatório, textarea), procedimento (opcional, select/input), redes sociais (obrigatório, checkboxes para Instagram, Facebook e TikTok, ao menos 1 selecionada), público-alvo override (opcional, textarea) e idioma (opcional, select com padrão pt-BR).
3. WHEN o usuário preenche o briefing e clica em "Gerar Conteúdo", THE aplicação SHALL enviar uma requisição POST para /api/content-agent/generate com os dados do briefing e exibir um estado de loading no painel direito.
4. WHEN a API retorna sucesso com o conteúdo gerado, THE aplicação SHALL exibir no painel direito: legendas separadas por rede social em tabs (uma tab por rede selecionada), hashtags como tags visuais (chips/badges), sugestões visuais como cards por rede e metadados da execução (execution_id, modelo utilizado, tokens consumidos, duração).
5. IF a API retornar erro (422, 503 ou outro), THEN THE aplicação SHALL exibir um toast de erro com mensagem descritiva e remover o estado de loading.
6. WHEN o conteúdo é gerado com sucesso, THE aplicação SHALL exibir um botão para abrir o painel/overlay de Refinamento.
7. IF o formulário de briefing for submetido sem tema ou sem ao menos uma rede social selecionada, THEN THE aplicação SHALL exibir validação inline nos campos obrigatórios e impedir a submissão.
8. WHEN o conteúdo está sendo gerado (loading), THE aplicação SHALL desabilitar o botão "Gerar Conteúdo" e exibir um spinner com mensagem indicando que o conteúdo está sendo gerado.

### Requirement 5: Refinamento de Conteúdo

**User Story:** Como profissional de marketing de uma clínica, eu quero solicitar ajustes no conteúdo gerado sem perder o contexto original, para que eu possa iterar até obter o resultado desejado.

#### Acceptance Criteria

1. WHEN o usuário clica no botão de refinamento após uma geração bem-sucedida, THE aplicação SHALL exibir um overlay/painel lateral mostrando o conteúdo atual gerado e um campo de texto para instruções de ajuste.
2. WHEN o usuário digita instruções e clica em "Refinar", THE aplicação SHALL enviar uma requisição POST para /api/content-agent/refine com o execution_id e as instruções, exibindo um estado de loading durante o processamento.
3. WHEN a API retorna sucesso com o conteúdo refinado, THE aplicação SHALL atualizar a exibição do conteúdo com a nova versão e incrementar o indicador de versão visível ao usuário.
4. THE aplicação SHALL exibir um indicador de limite de refinamentos mostrando "X/5 refinamentos" (onde X é o número de refinamentos já realizados para a execução atual).
5. IF o limite de 5 refinamentos for atingido (API retorna 429), THEN THE aplicação SHALL desabilitar o botão "Refinar", exibir um toast informando que o limite foi atingido e exibir visualmente que o indicador está no máximo (5/5).
6. IF a API retornar erro durante o refinamento (422, 503), THEN THE aplicação SHALL exibir um toast de erro e manter o conteúdo da versão anterior visível sem alterações.
7. WHEN o overlay/painel de refinamento está aberto, THE aplicação SHALL manter o conteúdo original visível para referência durante a digitação das instruções.

### Requirement 6: Infraestrutura e Experiência do Usuário

**User Story:** Como desenvolvedor, eu quero uma arquitetura frontend organizada com tratamento de erros consistente e UX responsiva, para que a aplicação seja manutenível e ofereça boa experiência ao cliente durante demos.

#### Acceptance Criteria

1. THE aplicação SHALL utilizar o stack Vite + React 18 + TypeScript + Tailwind CSS + shadcn/ui + React Router + TanStack Query, com a estrutura de diretórios: src/components, src/pages, src/hooks, src/services, src/types, src/lib.
2. THE aplicação SHALL implementar um cliente HTTP centralizado (serviço em src/services) que intercepta todas as requisições para adicionar o header Authorization com o token JWT e trata respostas 401 globalmente.
3. THE aplicação SHALL exibir toast notifications (via shadcn/ui Toast) para todos os erros retornados pela API, incluindo a mensagem de erro quando disponível.
4. THE aplicação SHALL implementar rotas protegidas que verificam a existência de token JWT válido antes de permitir acesso, redirecionando para Login caso contrário.
5. THE aplicação SHALL ser responsiva (mobile-friendly) utilizando Tailwind breakpoints, mas otimizada para a experiência desktop (layout de dois painéis na Geração de Conteúdo colapsa em mobile).
6. THE aplicação SHALL exibir labels e textos de interface em Português (Brasil).
7. THE aplicação SHALL utilizar componentes shadcn/ui para todos os elementos de formulário (Input, Button, Select, Checkbox, Textarea, Tabs, Card, Toast) mantendo consistência visual.
8. THE aplicação SHALL apontar todas as requisições de API para a base URL http://localhost:3000 (configurável via variável de ambiente VITE_API_URL).
