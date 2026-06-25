# Implementation Plan: BeautyGrowth AI — EPIC 01: Platform Foundation

## Overview

Implementação da fundação da plataforma multi-agente BeautyGrowth AI usando NestJS (TypeScript), PostgreSQL 16+ com RLS, Qdrant, Redis e S3/MinIO. As tarefas estão organizadas por dependência: infraestrutura de banco e projeto primeiro, depois módulos core (Auth, Tenant, Clinic), seguidos por módulos de IA (Agent Config, Memories, Knowledge Hub, Registries) e finalmente módulos transversais (Guardrails, Privacy, Observability).

## Tasks

- [ ] 1. Set up project structure, database schema and core infrastructure
  - [x] 1.1 Initialize NestJS monorepo with core modules and shared libraries
    - Create NestJS project with modular architecture
    - Configure TypeScript strict mode, ESLint, Prettier
    - Set up Docker Compose for PostgreSQL 16+, Redis, Qdrant, MinIO
    - Configure Jest + fast-check for testing
    - Create shared DTOs, interfaces, and error response format (`ErrorResponse`, `FieldError`)
    - _Requirements: All (infrastructure foundation)_

  - [x] 1.2 Create PostgreSQL schema with RLS policies and multi-tenant infrastructure
    - Create migration for all tables: tenants, users, clinics, brand_identities, agent_configs, agent_memory_short, agent_memory_long, business_memory_entries, documents, ai_models, prompts, prompt_versions, guardrails, consents, audit_logs, token_usage, invitations
    - Implement RLS policies on all tenant-scoped tables (SELECT, INSERT, UPDATE, DELETE)
    - Create `app.current_tenant` session variable mechanism
    - Create `prevent_modification()` trigger function for audit_logs immutability
    - Create all critical indexes (tenant, composite, time-based)
    - _Requirements: 4.1, 4.3, 13.7_

  - [-] 1.3 Implement TenantContext guard and interceptor for NestJS
    - Create `TenantGuard` that extracts tenant_id from JWT and sets PostgreSQL session variable
    - Create `TenantInterceptor` that injects tenant_id into request context
    - Create `@CurrentTenant()` decorator for controller parameter injection
    - Implement rejection logic for missing/mismatched tenant_id (403 + audit log)
    - _Requirements: 4.3, 4.5_

  - [~] 1.4 Write property test for multi-tenant isolation (Property 1)
    - **Property 1: Isolamento Multi-Tenant Completo**
    - Generate operations across distinct tenants, verify data never leaks between them via RLS
    - **Validates: Requirements 4.1, 4.3, 4.4, 4.5, 4.6, 4.7, 6.6, 7.10, 12.10**

- [ ] 2. Implement Auth Module with RBAC
  - [~] 2.1 Implement authentication service (register, login, verify email, refresh token)
    - Create `AuthModule` with `AuthService`, `AuthController`
    - Implement registration flow: validate email/password → create tenant + user → send verification email
    - Implement login with JWT (access 15min, refresh 7d)
    - Implement email verification with 24h token
    - Implement password reset with 1h token
    - Implement account lockout after 5 failed attempts (15min cooldown)
    - _Requirements: 3.1, 3.2, 3.6, 3.7, 3.9_

  - [~] 2.2 Write property test for password validation (Property 4)
    - **Property 4: Validação de Senha**
    - Generate random strings, verify acceptance IFF min 8 chars + 1 upper + 1 lower + 1 number + 1 special
    - **Validates: Requirements 3.1**

  - [~] 2.3 Implement RBAC guard and permission system
    - Create `RolesGuard` with `@Roles()` decorator
    - Define permission matrix: Admin (full), Operator (content, campaigns, calendar), Viewer (read-only)
    - Implement `PermissionsService` to check (role, resource, action) tuples
    - _Requirements: 3.3, 3.8_

  - [~] 2.4 Write property test for RBAC (Property 5)
    - **Property 5: Controle de Acesso por Perfil (RBAC)**
    - Generate (role, resource, action) tuples, verify access matches permission matrix
    - **Validates: Requirements 3.3, 3.9**

  - [~] 2.5 Implement invitation system for team members
    - Create invite flow: Admin sends invite → email with 72h link → accept and join tenant
    - Implement resend invitation for expired links
    - _Requirements: 3.4, 3.5_

- [~] 3. Checkpoint — Ensure auth and multi-tenant tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Implement Clinic Module
  - [~] 4.1 Implement clinic registration and update service
    - Create `ClinicModule` with `ClinicService`, `ClinicController`
    - Implement guided registration flow with validation (name ≤120 chars, phone 10-11 digits, email RFC 5322, specialties 1-20)
    - Implement specialty list from predefined catalog
    - Implement update with optimistic locking
    - Ensure clinic data available to agents within 30s via event emission
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [~] 4.2 Write property test for clinic data validation (Property 2)
    - **Property 2: Validação de Dados de Clínica**
    - Generate valid/invalid clinic inputs, verify correct acceptance/rejection
    - **Validates: Requirements 1.1, 1.3, 1.5**

- [ ] 5. Implement Brand Identity Module
  - [~] 5.1 Implement brand identity service with logo upload
    - Create `BrandModule` with `BrandService`, `BrandController`
    - Implement brand creation/update with validation (voice ≤500, colors 1-6 with ≥1 primary, audience ≤300, differentials 1-5 ≤200 each, values 1-5 ≤200 each)
    - Implement logo upload to S3/MinIO with format (PNG/JPG/SVG), size (≤5MB) and dimension (≥200x200) validation
    - Implement AI-powered field suggestions endpoint
    - Emit event on brand update for Business Memory sync
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

  - [~] 5.2 Write property test for brand validation (Property 3)
    - **Property 3: Validação de Identidade da Marca**
    - Generate brand inputs at limits, verify constraints enforced correctly
    - **Validates: Requirements 2.4, 2.6, 2.7**

- [ ] 6. Implement Agent Configuration Module
  - [~] 6.1 Implement agent config service with provisioning and lifecycle management
    - Create `AgentConfigModule` with `AgentConfigService`, `AgentConfigController`
    - Implement default agent provisioning on tenant creation (Content, Campaigns, Customer Service)
    - Implement activate/deactivate with 30s SLA
    - Implement parameter validation (temperature 0.0-2.0, tokens within model limits)
    - Implement configuration history tracking (field, old value, new value, user, timestamp)
    - Implement reset to defaults (preserve memory and Knowledge Hub)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

  - [~] 6.2 Write property test for agent parameter validation (Property 6)
    - **Property 6: Validação de Parâmetros de Agente**
    - Generate temperature/token configurations, verify acceptance within bounds, rejection outside
    - **Validates: Requirements 5.4, 5.5**

  - [~] 6.3 Write property test for agent reset (Property 7)
    - **Property 7: Reset de Agente Restaura Padrão**
    - Modify agent configs then reset, verify all params return to defaults, memory untouched
    - **Validates: Requirements 5.7**

  - [~] 6.4 Write property test for config history completeness (Property 8)
    - **Property 8: Histórico de Configuração Completo**
    - Generate N configuration changes, verify exactly N history records with correct fields
    - **Validates: Requirements 5.6**

- [ ] 7. Implement Business Memory Module
  - [~] 7.1 Implement business memory service with sync and category management
    - Create `BusinessMemoryModule` with `BusinessMemoryService`, `BusinessMemoryController`
    - Implement memory entries by category (brand, audience, campaigns, procedures, preferences)
    - Implement auto-sync from brand/clinic updates via event listener (60s SLA)
    - Implement campaign recording on campaign completion
    - Implement read-only access for agents (reject agent writes)
    - Implement snapshot endpoint for admin view
    - Implement resilience: on sync failure, keep previous version accessible
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8_

  - [~] 7.2 Write property test for business memory read-only (Property 9)
    - **Property 9: Memória de Negócio Somente-Leitura para Agentes**
    - Simulate agent write attempts to Business Memory, verify all are rejected
    - **Validates: Requirements 6.4**

  - [~] 7.3 Write property test for business memory resilience (Property 28)
    - **Property 28: Resiliência da Memória de Negócio**
    - Simulate sync failures, verify previous version remains accessible
    - **Validates: Requirements 6.8**

- [ ] 8. Implement Agent Memory Module
  - [~] 8.1 Implement agent memory service with short-term and long-term persistence
    - Create `AgentMemoryModule` with `AgentMemoryService`, `AgentMemoryController`
    - Implement short-term memory (last 50 interactions per agent)
    - Implement long-term memory (learnings, patterns, preferences with confidence scores)
    - Implement `loadContext()` with 5s SLA
    - Implement `persistInteraction()` with 10s SLA
    - Implement auto-promotion: when short-term hits 50, summarize oldest and promote to long-term
    - Implement selective/total memory clearing with confirmation requirement
    - Implement agent-to-agent memory isolation within same tenant
    - Handle persistence failures gracefully (log error, notify admin, keep session active)
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10_

  - [~] 8.2 Write property test for memory round-trip (Property 10)
    - **Property 10: Memória do Agente — Persistência Round-Trip**
    - Persist interactions and recover, verify content identical; verify short-term never exceeds 50
    - **Validates: Requirements 7.3, 7.4, 7.7**

  - [~] 8.3 Write property test for memory promotion (Property 11)
    - **Property 11: Promoção de Memória Curto → Longo Prazo**
    - Add 51st interaction, verify oldest summarized and promoted, short-term ≤ 50
    - **Validates: Requirements 7.4, 7.5**

  - [~] 8.4 Write property test for agent memory isolation (Property 12)
    - **Property 12: Isolamento de Memória Entre Agentes**
    - Two agents in same tenant, verify reads/writes never cross boundaries
    - **Validates: Requirements 7.6**

- [~] 9. Checkpoint — Ensure core modules and memory tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 10. Implement Knowledge Hub Module (RAG)
  - [~] 10.1 Implement document upload, processing pipeline, and search
    - Create `KnowledgeHubModule` with `KnowledgeHubService`, `KnowledgeHubController`
    - Implement file upload with validation (PDF/DOCX/TXT/MD, ≤20MB, ≤500 docs per tenant)
    - Implement document processing pipeline: text extraction → chunking → embedding generation → Qdrant upsert
    - Implement semantic search with Qdrant (top-k configurable 3-10, category filtering, tenant isolation via payload filter)
    - Implement category management (predefined + custom categories)
    - Implement category-based access control per agent
    - Implement document deletion (remove from S3, PostgreSQL, and Qdrant)
    - Implement document reprocessing
    - Track processing status (pending → processing → processed | error)
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9, 8.10_

  - [~] 10.2 Write property test for Knowledge Hub category access (Property 13)
    - **Property 13: Knowledge Hub — Acesso por Categoria**
    - Agent with subset of categories, search returns only authorized category chunks
    - **Validates: Requirements 8.6**

  - [~] 10.3 Write property test for document deletion (Property 14)
    - **Property 14: Knowledge Hub — Exclusão Remove Chunks**
    - Delete document, verify subsequent searches return zero chunks from that document
    - **Validates: Requirements 8.7**

  - [~] 10.4 Write property test for upload validation (Property 15)
    - **Property 15: Upload de Documentos — Validação**
    - Generate files with valid/invalid formats and sizes, verify acceptance criteria
    - **Validates: Requirements 8.1, 8.8**

- [ ] 11. Implement Model Registry Module
  - [~] 11.1 Implement model registry service with fallback and token tracking
    - Create `ModelRegistryModule` with `ModelRegistryService`, `ModelRegistryController`
    - Implement model catalog (OpenAI, Anthropic, Google, Meta, Alibaba, DeepSeek)
    - Implement model listing with filters (provider, status, capability)
    - Implement enable/disable model per tenant
    - Implement fallback routing when primary model unavailable
    - Implement health check for model availability
    - Implement token usage tracking per model per tenant
    - Implement deprecation notification to affected tenant admins
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 9.10_

  - [~] 11.2 Write property test for model fallback (Property 16)
    - **Property 16: Model Registry — Fallback Automático**
    - Simulate primary model unavailability, verify automatic routing to fallback + log entry
    - **Validates: Requirements 9.7**

  - [~] 11.3 Write property test for token tracking (Property 17)
    - **Property 17: Rastreamento de Tokens**
    - Execute agent actions, verify input/output tokens recorded correctly per tenant+model
    - **Validates: Requirements 9.9**

- [ ] 12. Implement Prompt Registry Module
  - [~] 12.1 Implement prompt registry service with versioning and template resolution
    - Create `PromptRegistryModule` with `PromptRegistryService`, `PromptRegistryController`
    - Implement prompt CRUD organized by agent type and function (system, task, formatting)
    - Implement semantic versioning (major.minor.patch) with full version history
    - Implement rollback to any previous version (30s SLA)
    - Implement template variable resolution: detect `{{variables}}`, substitute from tenant context
    - Implement unresolved variable reporting
    - Implement sandbox testing mode for prompt candidates
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8_

  - [~] 12.2 Write property test for template variable resolution (Property 18)
    - **Property 18: Resolução de Variáveis de Template em Prompts**
    - Generate prompts with variables + tenant contexts, verify correct substitution; unmatched variables reported
    - **Validates: Requirements 10.5, 10.7**

  - [~] 12.3 Write property test for prompt versioning round-trip (Property 19)
    - **Property 19: Prompt Versioning Round-Trip**
    - Create multiple versions, rollback to version X, verify active content equals version X content
    - **Validates: Requirements 10.2, 10.4**

- [ ] 13. Implement Guardrails Module
  - [~] 13.1 Implement guardrails service with system rules, tenant rules, and content validation
    - Create `GuardrailsModule` with `GuardrailsService`, `GuardrailsController`
    - Implement immutable system guardrails (no health promises, no diagnoses, no prescriptions, no ANVISA/CFM violations, no cross-tenant data sharing)
    - Implement tenant-specific custom guardrails (CRUD with versioning and rollback)
    - Implement content validation pipeline: check all applicable guardrails (system + tenant)
    - Implement regeneration logic: on violation, signal agent to regenerate (max 3 retries then block)
    - Implement violation logging with full context (agent, content, guardrail, action taken)
    - Implement violation report for admin (frequency, top agents, trends)
    - Apply new guardrails within 60s of creation/edit
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9_

  - [~] 13.2 Write property test for guardrail content validation (Property 20)
    - **Property 20: Guardrails — Validação de Conteúdo**
    - Generate content that violates/doesn't violate guardrails, verify isValid and violations list
    - **Validates: Requirements 11.3, 11.4**

  - [~] 13.3 Write property test for system guardrails immutability (Property 21)
    - **Property 21: Guardrails de Sistema São Imutáveis**
    - Attempt to disable/edit/remove system guardrails from any role, verify all rejected
    - **Validates: Requirements 11.1**

- [~] 14. Checkpoint — Ensure AI infrastructure modules pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 15. Implement Privacy Module (LGPD)
  - [~] 15.1 Implement privacy service with consent management, data deletion, and portability
    - Create `PrivacyModule` with `PrivacyService`, `PrivacyController`
    - Implement consent CRUD (record, revoke, check status per subject+purpose)
    - Implement consent-gated processing: block processing when consent revoked/expired
    - Implement data deletion (right to erasure) across all stores within 15 days deadline
    - Implement data export (portability) in JSON/CSV within 15 days
    - Implement anonymization service (one-way, irreversible)
    - Implement retention policies per tenant (configurable: leads 12mo default, financial 5yr)
    - Implement ROPA (Record of Processing Activities)
    - Implement DPO contact configuration
    - Ensure cross-tenant isolation of personal data
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10_

  - [~] 15.2 Write property test for consent controls processing (Property 22)
    - **Property 22: Consentimento Controla Processamento**
    - Process data with active/revoked/expired consent, verify allowed/blocked correctly
    - **Validates: Requirements 12.1, 12.8, 12.9**

  - [~] 15.3 Write property test for anonymization irreversibility (Property 23)
    - **Property 23: Anonimização Irreversível**
    - Anonymize personal data, verify output contains no identifying information, operation is one-way
    - **Validates: Requirements 12.3**

  - [~] 15.4 Write property test for data portability (Property 24)
    - **Property 24: Portabilidade de Dados Round-Trip**
    - Export subject's data, verify all personal data included, no other subject's data present
    - **Validates: Requirements 12.6**

- [ ] 16. Implement Observability Module (Audit & Monitoring)
  - [~] 16.1 Implement observability service with structured logging, metrics, and alerting
    - Create `ObservabilityModule` with `ObservabilityService`, `ObservabilityController`
    - Implement structured logging for agent actions (timestamp, tenant, agent, action, I/O, duration, status, tokens, guardrail violations)
    - Implement structured logging for user actions (timestamp, tenant, user, action, resource, result)
    - Implement RAG query logging (query, chunks returned, scores, final prompt, response)
    - Implement trace_id propagation across all inter-component calls
    - Implement immutable audit logs (append-only via DB trigger, no UPDATE/DELETE)
    - Implement log retention (minimum 12 months) with export capability (JSON/CSV)
    - Implement dashboard metrics endpoint (executions, avg response time, error rate, tokens by model/agent, guardrail violations)
    - Implement alert system: auto-alert when agent error rate > 10% in 1-hour window
    - Implement log query API with filters (period, agent, action, status) and 10s SLA for 30-day queries
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8, 13.9_

  - [~] 16.2 Write property test for audit log completeness and immutability (Property 25)
    - **Property 25: Audit Log — Completude e Imutabilidade**
    - Execute actions, verify log records contain all required fields; attempt update/delete, verify rejected
    - **Validates: Requirements 13.1, 13.2, 13.3, 13.7**

  - [~] 16.3 Write property test for trace correlation (Property 26)
    - **Property 26: Correlação de Trace End-to-End**
    - Execute multi-component operations, verify all log entries share the same trace_id
    - **Validates: Requirements 13.9**

  - [~] 16.4 Write property test for error rate alerting (Property 27)
    - **Property 27: Alerta de Taxa de Erro**
    - Generate agent executions with varying error rates, verify alert triggered at >10% threshold
    - **Validates: Requirements 13.6**

- [ ] 17. Integration wiring and end-to-end flows
  - [~] 17.1 Wire tenant provisioning flow (registration → tenant → default agents → empty knowledge hub → memory)
    - Connect Auth registration to automatic tenant creation
    - Trigger default agent provisioning on new tenant
    - Initialize empty Knowledge Hub and Business Memory for new tenant
    - Verify full provisioning completes within expected timeframes
    - _Requirements: 4.2, 5.1_

  - [~] 17.2 Wire brand update → business memory sync flow
    - Connect Brand update events to Business Memory sync handler
    - Verify sync completes within 60s SLA
    - Verify agents read updated business memory after sync
    - _Requirements: 6.2, 6.3_

  - [~] 17.3 Wire agent execution flow (config → prompt resolution → guardrails → memory → observability)
    - Connect AgentConfig to PromptRegistry for prompt resolution
    - Connect execution pipeline to Guardrails validation (pre and post generation)
    - Connect execution to Memory persistence (short-term + long-term)
    - Connect execution to Observability logging with trace_id
    - Connect execution to Model Registry (primary + fallback routing)
    - Connect execution to token tracking
    - _Requirements: 5.4, 9.7, 10.6, 11.3, 13.1, 13.9_

  - [~] 17.4 Write integration tests for full agent execution pipeline
    - Test end-to-end: request → auth → tenant resolution → agent config → prompt resolution → guardrails → response → memory persist → audit log
    - Test fallback routing when primary model unavailable
    - Test guardrail violation → regeneration → success/block flow
    - _Requirements: 5.4, 9.7, 10.6, 11.3, 11.4, 11.8, 13.1_

- [~] 18. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation at logical boundaries
- Property tests validate universal correctness properties defined in the design document (28 total)
- Unit tests validate specific examples and edge cases
- The tech stack is NestJS (TypeScript) for API/services, PostgreSQL 16+ with RLS for data isolation, Qdrant for vector search, Redis for cache/queues, S3/MinIO for object storage
- fast-check is the PBT library for TypeScript; minimum 100 iterations per property
- Integration tests use Jest + Supertest for API endpoints and testcontainers for database/Qdrant

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3"] },
    { "id": 3, "tasks": ["1.4", "2.1"] },
    { "id": 4, "tasks": ["2.2", "2.3", "2.5"] },
    { "id": 5, "tasks": ["2.4"] },
    { "id": 6, "tasks": ["4.1", "5.1", "6.1"] },
    { "id": 7, "tasks": ["4.2", "5.2", "6.2", "6.3", "6.4"] },
    { "id": 8, "tasks": ["7.1", "8.1"] },
    { "id": 9, "tasks": ["7.2", "7.3", "8.2", "8.3", "8.4"] },
    { "id": 10, "tasks": ["10.1", "11.1", "12.1"] },
    { "id": 11, "tasks": ["10.2", "10.3", "10.4", "11.2", "11.3", "12.2", "12.3"] },
    { "id": 12, "tasks": ["13.1"] },
    { "id": 13, "tasks": ["13.2", "13.3"] },
    { "id": 14, "tasks": ["15.1", "16.1"] },
    { "id": 15, "tasks": ["15.2", "15.3", "15.4", "16.2", "16.3", "16.4"] },
    { "id": 16, "tasks": ["17.1", "17.2", "17.3"] },
    { "id": 17, "tasks": ["17.4"] }
  ]
}
```
