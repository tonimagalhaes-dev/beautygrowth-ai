# Implementation Plan: Frontend MVP

## Overview

Implementação da SPA React (Vite + TypeScript + Tailwind CSS + shadcn/ui) para demonstração do BeautyGrowth AI Content Agent. Inclui autenticação JWT, onboarding da clínica em 2 etapas, geração de conteúdo multi-rede social e refinamento iterativo (até 5x). A arquitetura usa TanStack Query para estado do servidor, React Router para navegação com rotas protegidas e Axios como HTTP client com interceptors.

## Tasks

- [ ] 1. Project Setup e Configuração Base
  - [x] 1.1 Inicializar projeto Vite com template React + TypeScript (`npm create vite@latest frontend -- --template react-ts`)
    - _Requirements: 6.1_
  - [x] 1.2 Instalar dependências: tailwindcss, postcss, autoprefixer, @tanstack/react-query, react-router-dom, axios, class-variance-authority, clsx, tailwind-merge, lucide-react
    - _Requirements: 6.1_
  - [x] 1.3 Configurar Tailwind CSS (tailwind.config.ts, postcss.config.js, globals.css com diretivas @tailwind)
    - _Requirements: 6.1, 6.5_
  - [x] 1.4 Inicializar shadcn/ui (npx shadcn-ui@latest init) e instalar componentes: button, input, textarea, select, checkbox, tabs, card, toast, badge, dialog, sheet, label, form
    - _Requirements: 6.1, 6.7_
  - [x] 1.5 Criar estrutura de diretórios: src/components, src/pages, src/hooks, src/services, src/types, src/lib
    - _Requirements: 6.1_
  - [x] 1.6 Configurar cn helper em src/lib/utils.ts (clsx + tailwind-merge)
    - _Requirements: 6.1_
  - [x] 1.7 Criar arquivo .env com VITE_API_URL=http://localhost:3000
    - _Requirements: 6.8_
  - [x] 1.8 Configurar path aliases no tsconfig.json (@/ → src/)
    - _Requirements: 6.1_

- [ ] 2. Types e Interfaces TypeScript
  - [x] 2.1 Criar src/types/auth.ts com interfaces User, LoginRequest, LoginResponse, AuthState
    - _Requirements: 1.2, 1.3_
  - [x] 2.2 Criar src/types/clinic.ts com interfaces Clinic, CreateClinicRequest, BrandIdentity, CreateBrandRequest
    - _Requirements: 2.1, 3.1_
  - [x] 2.3 Criar src/types/content-agent.ts com interfaces/types RedeSocial, GenerateBriefing, SugestaoVisual, ContentAgentResult, RefineRequest
    - _Requirements: 4.2, 5.1_

- [ ] 3. Service Layer (API Client e Services)
  - [x] 3.1 Criar src/services/api.ts com instância axios, baseURL de env var, request interceptor (Bearer token de localStorage) e response interceptor (tratamento global de 401 → remove token + redirect /login)
    - _Requirements: 1.5, 1.6, 6.2, 6.8_
  - [x] 3.2 Criar src/services/auth.service.ts com métodos login(email, password) e logout()
    - _Requirements: 1.2, 1.3_
  - [x] 3.3 Criar src/services/clinic.service.ts com métodos create(data), createBrand(data com FormData para upload), getStatus()
    - _Requirements: 2.2, 3.2_
  - [x] 3.4 Criar src/services/content-agent.service.ts com métodos generate(briefing) e refine(executionId, instrucoes)
    - _Requirements: 4.3, 5.2_

- [ ] 4. Hooks Customizados (TanStack Query)
  - [x] 4.1 Criar src/hooks/useAuth.ts — mutation para login, estado isAuthenticated baseado em localStorage token, função logout, verificação de clinicSetup para redirect
    - _Requirements: 1.2, 1.3, 1.5_
  - [x] 4.2 Criar src/hooks/useClinic.ts — mutations para createClinic e createBrand, query para getClinicStatus
    - _Requirements: 2.2, 3.2_
  - [x] 4.3 Criar src/hooks/useContentAgent.ts — mutations para generate e refine, estado local currentResult, refinementCount derivado de version, computed isAtRefinementLimit (version >= 6)
    - _Requirements: 4.3, 5.2, 5.4_

- [x] 5. Checkpoint - Verificar fundação
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Roteamento e Proteção de Rotas
  - [x] 6.1 Criar src/components/ProtectedRoute.tsx — verifica token em localStorage, redireciona para /login se ausente, renderiza children se presente
    - _Requirements: 1.1, 6.4_
  - [x] 6.2 Criar src/components/ProtectedLayout.tsx — layout wrapper com Outlet para rotas protegidas, inclui Toaster provider
    - _Requirements: 6.3, 6.4_
  - [x] 6.3 Criar src/router.tsx com rotas: /login (público), / com ProtectedLayout contendo /onboarding e /content como children
    - _Requirements: 1.1, 6.4_
  - [x] 6.4 Configurar React Router em src/App.tsx com RouterProvider e QueryClientProvider (com defaultOptions para error handling global)
    - _Requirements: 6.1, 6.3_
  - [x] 6.5 Atualizar src/main.tsx para renderizar App com providers
    - _Requirements: 6.1_
  - [x]* 6.6 Write property test for protected routes authentication
    - **Property 1: Rotas protegidas requerem autenticação**
    - **Validates: Requirements 1.1, 1.6, 6.4**

- [x] 7. Tela de Login
  - [x] 7.1 Criar src/pages/LoginPage.tsx — layout centralizado (flex center, max-w-md), card com logo/título "BeautyGrowth AI"
    - _Requirements: 1.2, 6.5, 6.6_
  - [x] 7.2 Implementar formulário com campos e-mail (Input type="email" obrigatório) e senha (Input type="password" obrigatório)
    - _Requirements: 1.2, 6.7_
  - [x] 7.3 Implementar validação client-side (campos vazios, formato de email) com mensagens de erro inline
    - _Requirements: 1.4_
  - [x] 7.4 Integrar com useAuth hook — chamar login mutation no submit, exibir loading spinner no botão, desabilitar form durante loading
    - _Requirements: 1.2, 1.7_
  - [x] 7.5 Implementar tratamento de erro 401 — exibir mensagem "Credenciais inválidas" inline (não toast)
    - _Requirements: 1.4_
  - [x] 7.6 Implementar redirect pós-login — /onboarding se clinicSetup=false, /content se clinicSetup=true
    - _Requirements: 1.3_
  - [x]* 7.7 Write property test for form submission blocking
    - **Property 3: Formulários impedem submissão com campos obrigatórios vazios**
    - **Validates: Requirements 1.4**

- [ ] 8. Tela de Onboarding — Step Indicator e Layout
  - [x] 8.1 Criar src/components/StepIndicator.tsx — componente visual mostrando etapa atual (1/2 ou 2/2) com circles + line connector
    - _Requirements: 2.6, 3.7_
  - [x] 8.2 Criar src/pages/OnboardingPage.tsx — layout com StepIndicator no topo, renderização condicional do step atual, estado local para dados de ambas etapas
    - _Requirements: 2.6, 3.6, 3.7_

- [ ] 9. Onboarding — Etapa 1 (Dados da Clínica)
  - [x] 9.1 Criar src/pages/onboarding/ClinicRegistrationStep.tsx — formulário com campos: nome (Input), telefone (Input com máscara brasileira), email (Input type="email"), especialidades (multi-select com opções predefinidas), público-alvo (Textarea)
    - _Requirements: 2.1_
  - [x] 9.2 Implementar validação client-side — todos campos obrigatórios, formato de email, formato de telefone brasileiro (com DDD)
    - _Requirements: 2.3_
  - [x] 9.3 Integrar com useClinic hook — chamar createClinic mutation no submit, loading state no botão
    - _Requirements: 2.2, 2.5_
  - [x] 9.4 Implementar tratamento de erro — toast para erros da API, manter dados no formulário
    - _Requirements: 2.4_
  - [x] 9.5 Implementar transição para Etapa 2 no sucesso — callback onSuccess que avança o step
    - _Requirements: 2.2_

- [ ] 10. Onboarding — Etapa 2 (Identidade da Marca)
  - [x] 10.1 Criar src/components/ColorPicker.tsx — input de cor (hex) com preview, suporte a múltiplas cores (add/remove), mínimo 1 cor
    - _Requirements: 3.1_
  - [x] 10.2 Criar src/components/FileUpload.tsx — drag & drop / click to upload, preview de imagem, validação de formato (PNG/JPG/SVG) e tamanho (max 5MB), mensagem de erro inline
    - _Requirements: 3.1, 3.4_
  - [x] 10.3 Criar src/components/DynamicList.tsx — componente para listas dinâmicas (diferenciais, valores): add item, remove item, max 5 itens, max 200 chars por item
    - _Requirements: 3.1_
  - [x] 10.4 Criar src/pages/onboarding/BrandIdentityStep.tsx — formulário com campos: tom de voz (Textarea max 500), paleta de cores (ColorPicker), logotipo (FileUpload opcional), público-alvo (Textarea max 300), diferenciais (DynamicList), valores (DynamicList)
    - _Requirements: 3.1_
  - [x] 10.5 Implementar validação — campos obrigatórios, limites de caracteres, ao menos 1 cor, ao menos 1 diferencial, ao menos 1 valor
    - _Requirements: 3.3_
  - [x] 10.6 Integrar com useClinic hook — chamar createBrand mutation (com FormData) no submit, loading state
    - _Requirements: 3.2_
  - [x] 10.7 Implementar botão "Voltar" para retornar à Etapa 1 sem perder dados da Etapa 2
    - _Requirements: 3.6_
  - [x] 10.8 Implementar redirect para /content no sucesso do submit
    - _Requirements: 3.2_
  - [x]* 10.9 Write property test for onboarding data preservation
    - **Property 7: Onboarding preserva dados entre etapas**
    - **Validates: Requirements 3.6**

- [x] 11. Checkpoint - Verificar fluxo de autenticação e onboarding
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 12. Tela de Geração de Conteúdo — Layout e Briefing
  - [x] 12.1 Criar src/pages/ContentGenerationPage.tsx — layout flex com dois painéis (esquerdo 40%, direito 60%), responsivo (colapsa em mobile stack vertical)
    - _Requirements: 4.1, 6.5_
  - [x] 12.2 Criar src/components/BriefingForm.tsx — formulário com campos: tema (Textarea obrigatório), procedimento (Input opcional), redes sociais (Checkboxes: Instagram, Facebook, TikTok — ao menos 1), público-alvo override (Textarea opcional), idioma (Select com opções pt-BR, en, es — padrão pt-BR)
    - _Requirements: 4.2_
  - [x] 12.3 Implementar validação do briefing — tema obrigatório, ao menos 1 rede social selecionada
    - _Requirements: 4.7_
  - [x] 12.4 Implementar botão "Gerar Conteúdo" com loading state — integrar com useContentAgent.generate mutation, desabilitar durante loading
    - _Requirements: 4.3, 4.8_

- [ ] 13. Tela de Geração de Conteúdo — Result Panel
  - [x] 13.1 Criar src/components/SocialMediaTabs.tsx — componente Tabs (shadcn/ui) com uma tab por rede social selecionada, exibindo a legenda correspondente com formatação de texto preservada
    - _Requirements: 4.4_
  - [x] 13.2 Criar src/components/HashtagChips.tsx — lista de hashtags renderizadas como Badge (shadcn/ui), layout flex wrap
    - _Requirements: 4.4_
  - [x] 13.3 Criar src/components/VisualSuggestionCard.tsx — Card (shadcn/ui) por rede social com formato (ex: "1:1") e descrição da sugestão visual
    - _Requirements: 4.4_
  - [x] 13.4 Criar src/components/ExecutionMetadata.tsx — exibição discreta dos metadados: execution_id (truncado com copy), modelo utilizado, tokens (input/output), duração em ms
    - _Requirements: 4.4_
  - [x] 13.5 Criar src/components/ResultPanel.tsx — composição dos componentes acima, com 3 estados: empty (placeholder), loading (spinner + mensagem), success (conteúdo completo)
    - _Requirements: 4.3, 4.4, 4.8_
  - [x] 13.6 Integrar ResultPanel com ContentGenerationPage — renderizar baseado no estado do useContentAgent hook
    - _Requirements: 4.1, 4.4_

- [ ] 14. Refinamento (Overlay/Panel)
  - [x] 14.1 Criar src/components/RefinementCounter.tsx — indicador visual "X/5 refinamentos" com barra de progresso ou dots
    - _Requirements: 5.4_
  - [x] 14.2 Criar src/components/RefinementOverlay.tsx — Sheet lateral (shadcn/ui Sheet) com: conteúdo atual resumido, textarea para instruções de ajuste, botão "Refinar", RefinementCounter, loading state
    - _Requirements: 5.1, 5.7_
  - [x] 14.3 Integrar com useContentAgent.refine — chamar mutation com executionId + instruções, atualizar resultado no sucesso, incrementar versão
    - _Requirements: 5.2, 5.3_
  - [x] 14.4 Implementar lógica de limite — desabilitar botão "Refinar" quando version >= 6 (5 refinamentos), toast informativo se API retorna 429
    - _Requirements: 5.4, 5.5_
  - [x] 14.5 Adicionar botão "Refinar" na ContentGenerationPage que abre o RefinementOverlay (visível apenas após geração bem-sucedida)
    - _Requirements: 4.6, 5.1_
  - [ ]* 14.6 Write property test for refinement limit enforcement
    - **Property 6: Refinamento respeita limite de 5 iterações**
    - **Validates: Requirements 5.4, 5.5**
  - [ ]* 14.7 Write property test for loading states blocking duplicates
    - **Property 5: Loading states bloqueiam ações duplicadas**
    - **Validates: Requirements 1.7, 2.5, 4.8, 5.2**

- [ ] 15. Toast Notifications e Error Handling Global
  - [x] 15.1 Configurar Toaster (shadcn/ui) no ProtectedLayout e no LoginPage para cobertura global
    - _Requirements: 6.3_
  - [x] 15.2 Implementar utility function showErrorToast(error) que extrai mensagem do AxiosError e exibe toast destructive
    - _Requirements: 6.3_
  - [x] 15.3 Configurar QueryClient com defaultOptions.mutations.onError para chamar showErrorToast globalmente
    - _Requirements: 6.3_
  - [x] 15.4 Implementar tratamentos específicos: 422 (exibir mensagem da API), 429 (limite atingido), 503 (serviço indisponível), network error (erro de conexão)
    - _Requirements: 2.4, 4.5, 5.5, 5.6_
  - [ ]* 15.5 Write property test for API errors resulting in toast
    - **Property 4: Erros da API resultam em toast notification**
    - **Validates: Requirements 2.4, 3.5, 4.5, 5.6, 6.3**

- [x] 16. Checkpoint - Verificar fluxo completo de geração e refinamento
  - Ensure all tests pass, ask the user if questions arise.

- [x] 17. Responsividade e Polish UI
  - [x] 17.1 Implementar breakpoints Tailwind para layout de dois painéis: stack vertical em mobile (< md), side-by-side em desktop (>= md)
    - _Requirements: 6.5_
  - [x] 17.2 Ajustar OnboardingPage para largura máxima (max-w-2xl mx-auto) e espaçamento consistente
    - _Requirements: 6.5_
  - [x] 17.3 Ajustar LoginPage para centralização vertical/horizontal e max-w-md
    - _Requirements: 6.5_
  - [x] 17.4 Adicionar transições suaves (Tailwind transition) em hover states de botões e cards
    - _Requirements: 6.5_
  - [x] 17.5 Revisar espaçamento e tipografia — consistência em headings, labels, descriptions conforme estética SaaS (Linear/Notion)
    - _Requirements: 6.5_
  - [x] 17.6 Garantir todos os labels e textos de interface em Português (Brasil)
    - _Requirements: 6.6_

- [x] 18. Testes e Verificação Final
  - [x] 18.1 Instalar dependências de teste: vitest, @testing-library/react, @testing-library/jest-dom, @testing-library/user-event, msw, jsdom
    - _Requirements: 6.1_
  - [x] 18.2 Configurar Vitest (vitest.config.ts com environment jsdom, setup file com jest-dom)
    - _Requirements: 6.1_
  - [x] 18.3 Criar MSW handlers para todos os endpoints (login, clinics, brands, generate, refine) com respostas mock
    - _Requirements: 6.1_
  - [ ]* 18.4 Escrever testes para LoginPage: submit válido, erro 401, loading state, redirect
    - _Requirements: 1.2, 1.4, 1.7_
  - [ ]* 18.5 Escrever testes para ProtectedRoute: redirect sem token, render com token
    - _Requirements: 1.1, 6.4_
  - [ ]* 18.6 Escrever testes para BriefingForm: validação de campos obrigatórios, submit com dados válidos
    - _Requirements: 4.7_
  - [ ]* 18.7 Escrever testes para RefinementOverlay: submit, incremento de versão, limite de refinamentos (desabilita botão em 5/5)
    - _Requirements: 5.2, 5.4, 5.5_
  - [x] 18.8 Verificar build de produção sem erros (`npm run build`)
    - _Requirements: 6.1_

- [x] 19. Final checkpoint - Verificar build e testes
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The application uses TypeScript throughout with shadcn/ui components
- All UI text should be in Portuguese (Brazil) as per Requirement 6.6
- The design uses Axios interceptors for auth token management and global 401 handling

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.5", "1.7", "1.8"] },
    { "id": 2, "tasks": ["1.3", "1.4", "1.6"] },
    { "id": 3, "tasks": ["2.1", "2.2", "2.3"] },
    { "id": 4, "tasks": ["3.1", "3.2", "3.3", "3.4"] },
    { "id": 5, "tasks": ["4.1", "4.2", "4.3"] },
    { "id": 6, "tasks": ["6.1", "6.2", "6.3"] },
    { "id": 7, "tasks": ["6.4", "6.5", "6.6"] },
    { "id": 8, "tasks": ["7.1", "8.1", "8.2"] },
    { "id": 9, "tasks": ["7.2", "7.3", "9.1", "10.1", "10.2", "10.3"] },
    { "id": 10, "tasks": ["7.4", "7.5", "7.6", "9.2", "10.4"] },
    { "id": 11, "tasks": ["7.7", "9.3", "9.4", "9.5", "10.5", "10.6", "10.7", "10.8"] },
    { "id": 12, "tasks": ["10.9", "12.1"] },
    { "id": 13, "tasks": ["12.2", "12.3", "12.4"] },
    { "id": 14, "tasks": ["13.1", "13.2", "13.3", "13.4"] },
    { "id": 15, "tasks": ["13.5", "13.6"] },
    { "id": 16, "tasks": ["14.1", "14.2"] },
    { "id": 17, "tasks": ["14.3", "14.4", "14.5"] },
    { "id": 18, "tasks": ["14.6", "14.7", "15.1", "15.2"] },
    { "id": 19, "tasks": ["15.3", "15.4", "15.5"] },
    { "id": 20, "tasks": ["17.1", "17.2", "17.3", "17.4", "17.5", "17.6"] },
    { "id": 21, "tasks": ["18.1"] },
    { "id": 22, "tasks": ["18.2", "18.3"] },
    { "id": 23, "tasks": ["18.4", "18.5", "18.6", "18.7", "18.8"] }
  ]
}
```
