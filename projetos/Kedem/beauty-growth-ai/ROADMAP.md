# BeautyGrowth AI — Product Roadmap

## Visão do Produto

Plataforma SaaS multi-agente de marketing inteligente para clínicas de estética. A proprietária da clínica responde perguntas simples e a IA executa todo o operacional: cria conteúdo, gera artes, gerencia campanhas, conversa com leads e otimiza resultados.

## Arquitetura Multi-Agente

```
                    ┌─────────────────────────────────┐
                    │     Painel Web da Clínica        │
                    └──────────────┬──────────────────┘
                                   │
                    ┌──────────────▼──────────────────┐
                    │     Agente Executivo (IA)         │
                    │   Orquestra todos os agentes     │
                    └──┬────┬────┬────┬────┬────┬─────┘
                       │    │    │    │    │    │
          ┌────────────┘    │    │    │    │    └────────────┐
          ▼                 ▼    │    ▼    ▼                 ▼
   Social Media        Designer  │  Meta Ads         Google Ads
     Agent              Agent    │   Agent              Agent
                                 ▼
                          Comercial Agent
                         (WhatsApp + CRM)
```

---

## Status Atual (Julho 2026)

### ✅ Concluído

| Epic | Descrição | Status |
|------|-----------|--------|
| EPIC 01 | Platform Foundation (Auth, Multi-Tenant, Clinic, Brand, Memory, RAG, Prompts, Guardrails, LGPD, Observabilidade) | ✅ 100% |
| EPIC 02 | LangGraph Orchestration Layer (gRPC, State Manager, Workflow Engine, Agent Router, Streaming, Circuit Breaker) | ✅ 100% |
| EPIC 03 | Content Agent MVP (Geração de legendas + hashtags + sugestões visuais com Gemini, Refinamento 5x, Guardrails ANVISA/CFM) | ✅ 100% |
| EPIC 04 | Frontend MVP (Login, Onboarding, Content Generation Page, Refinamento) | ✅ 100% |

### Stack Atual

- **Backend**: NestJS + TypeORM + PostgreSQL (RLS) + Redis + Qdrant
- **AI Orchestration**: Python + LangGraph + gRPC
- **LLM**: Google Gemini 2.5 Flash (primário) via API
- **Frontend**: React + Vite + TypeScript + Tailwind + shadcn/ui + TanStack Query
- **Infra**: Docker Compose (Postgres, Redis, Qdrant, MinIO, LangGraph)

---

## Roadmap de Próximos Épicos

### EPIC 05 — Designer Agent (Geração de Imagens)
**Prioridade: ALTA | Estimativa: 2–3 semanas**

Evolui o Content Agent para gerar imagens reais em vez de apenas sugestões textuais.

#### Escopo
- Integrar modelo `gemini-3.1-flash-image` para geração de imagens
- Novo nó `generate_visual` no workflow LangGraph
- Gerar imagem por rede social (Instagram 4:5, Facebook 1.91:1, TikTok 9:16)
- Prompt automático construído a partir da descrição visual + identidade da marca
- Upload automático ao MinIO (S3) com URL pública
- Exibir preview da imagem no frontend
- Edição iterativa de imagens (multiturno)
- Overlay de logo da clínica na imagem (opcional)

#### Dependências
- API Key do Google com acesso a Imagen/Nano Banana (mesma key atual)
- MinIO bucket para armazenamento de assets

#### Entregáveis
- Imagens prontas para publicação junto com legendas e hashtags
- Cards visuais no frontend com preview das artes geradas

---

### EPIC 06 — Calendário Editorial & Content Planner
**Prioridade: ALTA | Estimativa: 2–3 semanas**

Permite que a proprietária informe apenas o tema/promoção do mês e a IA gere um calendário completo.

#### Escopo
- Interface de "Planejamento Mensal" (procedimento, promoção, vagas, público)
- Agente gera automaticamente: 20 posts, 12 stories, 8 reels, 4 carrosséis
- Distribuição inteligente no calendário (frequência, horários ideais)
- Workflow de aprovação (preview → aprovar → agendar)
- Histórico de calendários anteriores
- Integração com Memória de Negócio (campanhas anteriores como referência)

#### Dependências
- EPIC 05 (Designer Agent) para gerar os assets visuais
- Tabelas de `content_calendar`, `scheduled_posts`

---

### EPIC 07 — Publicação Automatizada (Social Publishing)
**Prioridade: MÉDIA | Estimativa: 2–3 semanas**

Publica automaticamente o conteúdo aprovado nas redes sociais.

#### Escopo
- Integração com Meta Graph API (Instagram + Facebook)
- Integração com Google Business Profile API
- Integração com TikTok API (opcional)
- Agendamento de publicação (datetime scheduling)
- Status tracking (agendado → publicado → métricas)
- Retry automático em caso de falha
- Dashboard de publicações (histórico, status, engajamento)

#### Dependências
- EPIC 06 (Calendário Editorial)
- OAuth tokens da Meta e Google por tenant

---

### EPIC 08 — Meta Ads Agent
**Prioridade: MÉDIA | Estimativa: 3–4 semanas**

Agente que cria, monitora e otimiza campanhas na Meta (Facebook + Instagram Ads).

#### Escopo
- Integração com Meta Marketing API
- Criação automatizada: Campanha → Conjunto de Anúncios → Criativo → Público → Orçamento
- Configuração de Pixel e evento de conversão
- Monitoramento diário de métricas (CTR, CPA, ROAS, Conversões)
- Otimização automática:
  - Pausar anúncios com baixo desempenho
  - Aumentar orçamento de winners
  - Criar variações de criativos
- Workflow de aprovação (a proprietária só aprova)
- Relatório semanal de performance

#### Dependências
- Meta Business Account com acesso à Marketing API
- EPIC 05 (imagens para criativos)
- Tabelas de `campaigns`, `ad_sets`, `ads`, `campaign_metrics`

---

### EPIC 09 — Google Ads Agent
**Prioridade: MÉDIA | Estimativa: 3–4 semanas**

Agente que cria e otimiza campanhas no Google Ads.

#### Escopo
- Integração com Google Ads API
- Criação automatizada: Search, Performance Max, Display, Remarketing, Call Ads
- Pesquisa de palavras-chave automática (keyword planner)
- Geração de copy para anúncios de texto
- Monitoramento e otimização diária
- Configuração de conversões e tracking
- Workflow de aprovação

#### Dependências
- Google Ads Developer Token + OAuth
- EPIC 08 (padrões de campanha compartilhados)

---

### EPIC 10 — Agente Comercial (WhatsApp + CRM)
**Prioridade: MÉDIA-ALTA | Estimativa: 4–5 semanas**

Agente que conversa com leads via WhatsApp, qualifica, agenda avaliações e faz follow-up.

#### Escopo
- Integração com WhatsApp Business API (via Meta Cloud API ou WABA)
- Pipeline CRM: Novo Lead → Contato → Avaliação → Fechamento → Retorno
- Respostas automáticas inteligentes (preços, procedimentos, disponibilidade)
- Transferência para humano quando necessário
- Follow-up automatizado:
  - 3 dias sem resposta → mensagem automática
  - 7 dias → nova mensagem
  - 30 dias → campanha de retorno
- Guardrails de conversa (não diagnosticar, não prescrever)
- Integração com Knowledge Hub para respostas fundamentadas

#### Dependências
- WhatsApp Business API access
- Número de telefone verificado
- Tabelas de `leads`, `conversations`, `pipeline_stages`

---

### EPIC 11 — Campaign Optimizer Agent
**Prioridade: BAIXA | Estimativa: 2–3 semanas**

Agente autônomo que analisa performance diariamente e toma decisões de otimização.

#### Escopo
- Coleta diária de métricas (Meta + Google + CRM)
- Análise automatizada: melhor anúncio, pior CPA, melhor horário
- Decisões autônomas (dentro de limites configurados):
  - "Aumentar orçamento em 20%"
  - "Pausar anúncio com CTR < 0.5%"
  - "Criar novo criativo baseado no winner"
- Resumo diário para a proprietária (push notification ou e-mail)
- Limites de autonomia configuráveis pelo admin

#### Dependências
- EPIC 08 (Meta Ads) e EPIC 09 (Google Ads)
- Histórico de métricas acumulado

---

### EPIC 12 — Dashboard Executivo & Analytics
**Prioridade: BAIXA | Estimativa: 2–3 semanas**

Painel consolidado com indicadores de performance.

#### Escopo
- Dashboard principal: leads, avaliações, vendas, receita, CAC, ROAS
- Gráficos de tendência (7d, 30d, 90d)
- Campanha campeã do período
- Agenda disponível (integração futura com calendário)
- Relatório semanal automático (gerado pelo Agente Executivo)
- Exportação PDF

#### Dependências
- EPIC 08, 09, 10 (fontes de dados)

---

### EPIC 13 — Geração de Vídeos (Video Agent)
**Prioridade: BAIXA | Estimativa: 3–4 semanas**

Geração automática de vídeos curtos para Reels/TikTok.

#### Escopo
- Integração com modelo de vídeo (Google Veo 2 ou Wan Video)
- Gerar vídeo de 15s a partir de imagem + roteiro
- Adicionar legenda, animações e CTA
- Narração com TTS (text-to-speech) via Google TTS ou modelo open source
- Formatos: 9:16 (Reels/Stories/TikTok)

#### Dependências
- EPIC 05 (imagens como input)
- GPU ou API de geração de vídeo

---

## Sequência Recomendada de Implementação

```
Fase 1 — Content Completo (próximas 4-6 semanas)
├── EPIC 05: Designer Agent (imagens reais)
└── EPIC 06: Calendário Editorial

Fase 2 — Publicação & Tráfego (6-10 semanas)
├── EPIC 07: Publicação Automatizada
├── EPIC 08: Meta Ads Agent
└── EPIC 09: Google Ads Agent

Fase 3 — Comercial & Conversão (10-14 semanas)
├── EPIC 10: Agente Comercial (WhatsApp + CRM)
└── EPIC 11: Campaign Optimizer

Fase 4 — Intelligence & Scale (14-18 semanas)
├── EPIC 12: Dashboard Executivo
└── EPIC 13: Video Agent
```

---

## Princípios Arquiteturais

1. **Cada agente = 1 workflow LangGraph** com nós especializados
2. **Memória compartilhada** (Business Memory) + **Memória individual** (Agent Memory) por agente
3. **Knowledge Hub (RAG)** alimenta todos os agentes com conhecimento da clínica
4. **Guardrails** aplicados em toda geração (compliance ANVISA/CFM)
5. **Observabilidade** end-to-end com trace_id, tokens, duração, violações
6. **Multi-tenant** com RLS — cada clínica é um universo isolado
7. **Modelo abstrato** — trocar de Gemini para Claude/GPT/Llama sem alterar código
8. **Fallback** — modelo secundário ativado automaticamente se primário falhar
9. **Aprovação humana** — a IA sugere, a proprietária aprova com um clique

---

## Métricas de Sucesso do Produto

| Métrica | Meta MVP | Meta SaaS |
|---------|----------|-----------|
| Tempo para gerar conteúdo mensal | < 30 min (vs 8h manual) | < 15 min |
| Conteúdos gerados/mês | 40+ peças | 100+ peças |
| Taxa de aprovação 1º draft | > 70% | > 85% |
| Leads capturados/mês | — | Tracking automático |
| ROAS campanhas | — | > 3x |
| Tempo de resposta WhatsApp | — | < 2 min |
| Custo de IA por clínica/mês | < R$50 | < R$100 |

---

## Specs Existentes (Referência)

| Spec | Diretório |
|------|-----------|
| Platform Foundation (EPIC 01) | `.kiro/specs/beautygrowth-ai-mvp/` |
| LangGraph Orchestration (EPIC 02) | `.kiro/specs/langgraph-orchestration/` |
| Content Agent MVP (EPIC 03) | `.kiro/specs/content-agent-mvp/` |
| Frontend MVP (EPIC 04) | `.kiro/specs/frontend-mvp/` |
| Distributed Cache | `.kiro/specs/distributed-cache/` |
| Distributed Event Bus | `.kiro/specs/distributed-event-bus/` |

Novos épicos devem seguir o mesmo padrão: `requirements.md` → `design.md` → `tasks.md`

---

*Última atualização: Julho 2026*
