# Implementation Plan: Designer Agent Frontend

## Overview

Implementação incremental da integração do Designer Agent no frontend React. Começa pelos tipos e interfaces (fundação), segue para o serviço de API, hook customizado com polling, componentes individuais, integração nos componentes existentes, e finaliza com verificação e testes property-based.

## Tasks

- [x] 1. Tipos, interfaces e serviço de API
  - [x] 1.1 Criar módulo de tipos `src/types/designer-agent.ts`
    - Definir `DesignerAgentStatus`, `DesignerAgentState`, `GenerateFromContentRequest`, `GenerateAcceptedResponse`, `ImageResult`, `DesignerAgentExecution`, `UseDesignerAgentReturn`
    - Importar `RedeSocial` de `@/types/content-agent`
    - Seguir convenção existente de `types/content-agent.ts`
    - _Requirements: 5.5_

  - [x] 1.2 Criar serviço `src/services/designer-agent.service.ts`
    - Implementar método `fromContent(data: GenerateFromContentRequest): Promise<GenerateAcceptedResponse>` com POST para `/api/designer-agent/from-content`
    - Implementar método `getExecution(executionId: string): Promise<DesignerAgentExecution>` com GET para `/api/designer-agent/executions/:id`
    - Usar `apiClient` existente (axios com interceptors de auth)
    - Seguir padrão de object literal de `content-agent.service.ts`
    - _Requirements: 5.1, 5.2, 5.3_

  - [ ]* 1.3 Escrever property test para métodos do serviço
    - **Property 1: Service method request mapping**
    - **Validates: Requirements 5.2, 5.3**
    - Verificar que `fromContent()` produz POST correto para qualquer input válido
    - Verificar que `getExecution()` produz GET correto para qualquer executionId

- [x] 2. Hook customizado `useDesignerAgent`
  - [x] 2.1 Criar hook `src/hooks/useDesignerAgent.ts`
    - Implementar máquina de estados: idle → processing → generated | error
    - Implementar `triggerGeneration(contentExecutionId)` que chama `designerAgentService.fromContent`
    - Implementar polling com `setInterval` a cada 3s (ref-based)
    - Implementar lógica de timeout (40 tentativas = 120s)
    - Implementar retry de rede (3 falhas consecutivas → erro)
    - Implementar cleanup do interval no unmount via `useEffect`
    - Implementar `reset()` para limpar estado
    - Usar `showErrorToast` para erros e `toast` para feedback
    - _Requirements: 1.2, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 5.4, 6.5_

  - [ ]* 2.2 Escrever property test para state machine do hook
    - **Property 2: Hook state machine correctness**
    - **Validates: Requirements 5.4, 1.4, 2.2**
    - Verificar transições corretas para qualquer sequência de respostas da API

  - [ ]* 2.3 Escrever property test para polling interval e terminação
    - **Property 3: Polling interval and termination**
    - **Validates: Requirements 2.1**
    - Verificar número correto de requests e espaçamento para qualquer N responses

  - [ ]* 2.4 Escrever property test para cleanup no unmount
    - **Property 6: Polling cleanup on unmount**
    - **Validates: Requirements 6.5**
    - Verificar que unmount cancela polling para qualquer estado processing ativo

- [x] 3. Checkpoint - Verificar fundação
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Componentes individuais
  - [x] 4.1 Criar componente `src/components/CopyButton.tsx`
    - Implementar botão com ícone `Copy` (lucide-react) que copia texto via `navigator.clipboard.writeText()`
    - Sucesso: ícone muda para `Check` por 2s + toast de confirmação
    - Falha: toast de erro sugerindo cópia manual
    - Props: `text: string`, `ariaLabel: string`
    - Acessibilidade: `aria-label`, foco visível, ativação por Enter/Space
    - _Requirements: 4.2, 4.3, 4.4, 4.5_

  - [ ]* 4.2 Escrever property test para CopyButton
    - **Property 5: Clipboard copy correctness**
    - **Validates: Requirements 4.2, 4.5**
    - Verificar que clipboard recebe texto exato e aria-label correto para qualquer rede social

  - [x] 4.3 Criar componente `src/components/GenerateImageButton.tsx`
    - Props: `onClick`, `isLoading`, `isProcessing`, `hasResult`, `disabled`
    - Estado idle sem resultado: "Gerar Imagem" (habilitado, cor primária)
    - Estado idle com resultado: "Gerar Nova Imagem" (habilitado)
    - isLoading ou isProcessing: "Gerando..." + spinner (desabilitado)
    - Usar componente `Button` do shadcn/ui e `Loader2` do lucide-react
    - _Requirements: 1.1, 1.3, 1.6, 6.1, 6.2, 6.3_

  - [x] 4.4 Criar componente `src/components/ImagePreview.tsx`
    - Props: `images: Record<RedeSocial, ImageResult>`, `warnings?: string[]`
    - Renderizar card por rede social com thumbnail (`urlThumbnail`)
    - Legenda: nome capitalizado + aspect ratio
    - Clique no thumbnail → abre Dialog (shadcn/ui) com imagem em resolução completa
    - Botão "Download" → download da imagem original
    - `onError` no `<img>` → placeholder com ícone de imagem quebrada
    - Badges de warnings quando presentes
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [ ]* 4.5 Escrever property test para ImagePreview
    - **Property 4: ImagePreview rendering completeness**
    - **Validates: Requirements 3.1, 3.2, 3.6**
    - Verificar renderização correta para qualquer combinação de imagens e warnings

  - [x] 4.6 Criar componente `src/components/ImagePreviewLoader.tsx`
    - Sem props — componente de apresentação pura
    - Skeleton cards com animação de pulso (TailwindCSS `animate-pulse`)
    - Texto "Gerando imagem..." centralizado
    - Layout consistente com `ImagePreview` para evitar layout shift
    - _Requirements: 2.7, 6.2_

- [x] 5. Checkpoint - Verificar componentes isolados
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Integração nos componentes existentes
  - [x] 6.1 Integrar `CopyButton` no `VisualSuggestionCard`
    - Adicionar `CopyButton` no header de cada card, ao lado do título
    - `text`: campo `descricao` da sugestão correspondente
    - `ariaLabel`: "Copiar descrição visual para {rede social}"
    - _Requirements: 4.1, 4.2, 4.5_

  - [x] 6.2 Integrar seção Designer Agent no `ResultPanel`
    - Adicionar props: `designerState`, `designerResult`, `onGenerateImage`, `isGenerating`
    - Após seção "Sugestões Visuais": renderizar `GenerateImageButton`
    - Se `designerState === 'processing'`: renderizar `ImagePreviewLoader`
    - Se `designerState === 'generated'` e `designerResult`: renderizar `ImagePreview`
    - Se `designerState === 'error'`: mensagem de erro inline
    - Transição suave (fade-in) ao exibir ImagePreview
    - _Requirements: 1.1, 1.6, 6.1, 6.2, 6.3, 6.4, 6.6_

  - [x] 6.3 Conectar `useDesignerAgent` na página que usa `ResultPanel`
    - Instanciar `useDesignerAgent` no componente pai (ContentPage)
    - Passar `triggerGeneration` como callback para `onGenerateImage`
    - Passar `state`, `result`, `isGenerating` como props para `ResultPanel`
    - Usar `contentResult.executionId` como argumento para `triggerGeneration`
    - _Requirements: 1.2, 5.4, 6.6_

- [x] 7. Instalar dependência e testes finais
  - [x] 7.1 Adicionar `fast-check` como devDependency
    - Executar `npm install --save-dev fast-check` no diretório `frontend/`
    - _Requirements: (suporte a testes property-based)_

  - [ ]* 7.2 Escrever unit tests para cenários example-based
    - Testar botão oculto sem resultado no ResultPanel
    - Testar spinner durante POST no GenerateImageButton
    - Testar skeleton durante polling no ImagePreviewLoader
    - Testar Dialog abre ao clicar thumbnail no ImagePreview
    - Testar placeholder em imagem quebrada no ImagePreview
    - Testar toast em erro de clipboard no CopyButton
    - Testar toast em guardrail_blocked no useDesignerAgent
    - Testar timeout após 120s no useDesignerAgent
    - _Requirements: 1.3, 1.5, 2.3, 2.4, 2.5, 2.6, 3.3, 3.5, 4.3, 4.4_

- [x] 8. Checkpoint final
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- O projeto usa `vitest` + `@testing-library/react` para testes e `msw` para mocking de API
- Todos os componentes usam shadcn/ui (Card, Dialog, Button, Badge) e lucide-react para ícones
- O hook `useDesignerAgent` usa `setInterval` com refs (não react-query) para controle fino do polling

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3", "2.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "2.4", "4.1", "4.3", "4.6"] },
    { "id": 4, "tasks": ["4.2", "4.4"] },
    { "id": 5, "tasks": ["4.5", "6.1"] },
    { "id": 6, "tasks": ["6.2"] },
    { "id": 7, "tasks": ["6.3"] },
    { "id": 8, "tasks": ["7.1"] },
    { "id": 9, "tasks": ["7.2"] }
  ]
}
```
