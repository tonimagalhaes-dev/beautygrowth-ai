-- =============================================================================
-- Seed: Provisionamento completo do tenant de desenvolvimento
-- Descrição: Cria toda a base necessária para o MVP funcionar end-to-end
-- Tenant: clinica-demo (a1b2c3d4-e5f6-7890-abcd-ef1234567890)
-- User: admin@beautygrowth.dev / Admin@123
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Tenant de desenvolvimento
-- ---------------------------------------------------------------------------
INSERT INTO tenants (id, slug, status, settings)
VALUES (
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'clinica-demo',
  'active',
  '{}'::jsonb
)
ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Usuário admin
-- Senha: Admin@123 (bcrypt hash 12 rounds)
-- ---------------------------------------------------------------------------
INSERT INTO users (id, tenant_id, email, password_hash, role, email_verified)
VALUES (
  'f0e1d2c3-b4a5-6789-0fed-cba987654321',
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'admin@beautygrowth.dev',
  '$2b$12$CNX4n97nXvY0W6achq9Ik.Dl9Qztw6kiyhINCyGZQY68f4kX.4VW2',
  'admin',
  true
)
ON CONFLICT (email) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Clínica
-- ---------------------------------------------------------------------------
INSERT INTO clinics (id, tenant_id, name, phone, email, specialties, target_audience)
VALUES (
  'c1d2e3f4-a5b6-7890-cdef-123456789012',
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'Clínica Estética Demo',
  '(11) 99999-0000',
  'contato@clinicademo.com.br',
  ARRAY['Otomodelação', 'Botox', 'Bioestimuladores', 'Preenchimento labial', 'Harmonização facial'],
  'Mulheres de 25 a 50 anos, classes A e B, que buscam procedimentos estéticos minimamente invasivos para realçar a beleza natural'
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Identidade da Marca
-- ---------------------------------------------------------------------------
INSERT INTO brand_identities (id, tenant_id, voice_tone, color_palette, target_audience, differentials, "values")
VALUES (
  'd2e3f4a5-b6c7-8901-def0-234567890123',
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'Profissional, acolhedor e confiável. Linguagem acessível sem ser informal demais. Transmite segurança e expertise sem intimidar. Usa tom empático que valoriza a autoestima e o bem-estar da paciente.',
  '["#D4A574", "#F5E6D3", "#2C3E50", "#FFFFFF", "#B8860B"]'::jsonb,
  'Mulheres de 25 a 50 anos, classes A e B, que buscam procedimentos estéticos minimamente invasivos',
  ARRAY['Enfermeira especialista com certificação em procedimentos injetáveis', 'Atendimento personalizado e humanizado', 'Ambiente premium e acolhedor', 'Protocolos seguros baseados em evidências'],
  ARRAY['Segurança', 'Naturalidade', 'Autoestima', 'Excelência', 'Ética']
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. Agent Config — Content Agent para o tenant
-- ---------------------------------------------------------------------------
INSERT INTO agent_configs (id, tenant_id, agent_type, status, model_id, temperature, max_tokens, fallback_model_id)
VALUES (
  'e3f4a5b6-c7d8-9012-ef01-345678901234',
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'content',
  'active',
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',  -- gemini-2.0-flash
  0.7,
  4096,
  'b2c3d4e5-f6a7-8901-bcde-f12345678901'   -- gemini-1.5-flash (fallback)
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 6. Business Memory Entries — contexto da clínica para o Content Agent
-- ---------------------------------------------------------------------------

-- Tom de voz (OBRIGATÓRIO para o workflow funcionar)
INSERT INTO business_memory_entries (id, tenant_id, category, key, value, updated_by)
VALUES (
  '11111111-1111-1111-1111-111111111101',
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'brand',
  'tom_de_voz',
  '"Profissional, acolhedor e confiável. Linguagem acessível sem ser informal demais. Transmite segurança e expertise sem intimidar. Usa tom empático que valoriza a autoestima e o bem-estar da paciente."'::jsonb,
  'system'
)
ON CONFLICT (id) DO NOTHING;

-- Valores da marca
INSERT INTO business_memory_entries (id, tenant_id, category, key, value, updated_by)
VALUES (
  '11111111-1111-1111-1111-111111111102',
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'brand',
  'valores',
  '["Segurança", "Naturalidade", "Autoestima", "Excelência", "Ética"]'::jsonb,
  'system'
)
ON CONFLICT (id) DO NOTHING;

-- Paleta de cores
INSERT INTO business_memory_entries (id, tenant_id, category, key, value, updated_by)
VALUES (
  '11111111-1111-1111-1111-111111111103',
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'brand',
  'paleta_cores',
  '["#D4A574", "#F5E6D3", "#2C3E50", "#FFFFFF", "#B8860B"]'::jsonb,
  'system'
)
ON CONFLICT (id) DO NOTHING;

-- Público-alvo
INSERT INTO business_memory_entries (id, tenant_id, category, key, value, updated_by)
VALUES (
  '11111111-1111-1111-1111-111111111104',
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'audience',
  'publico_alvo',
  '"Mulheres de 25 a 50 anos, classes A e B, residentes em São Paulo, que buscam procedimentos estéticos minimamente invasivos para realçar a beleza natural e elevar a autoestima."'::jsonb,
  'system'
)
ON CONFLICT (id) DO NOTHING;

-- Especialidades
INSERT INTO business_memory_entries (id, tenant_id, category, key, value, updated_by)
VALUES (
  '11111111-1111-1111-1111-111111111105',
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'procedures',
  'especialidades',
  '"Otomodelação"'::jsonb,
  'system'
),
(
  '11111111-1111-1111-1111-111111111106',
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'procedures',
  'especialidades',
  '"Botox"'::jsonb,
  'system'
),
(
  '11111111-1111-1111-1111-111111111107',
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'procedures',
  'especialidades',
  '"Bioestimuladores de colágeno"'::jsonb,
  'system'
),
(
  '11111111-1111-1111-1111-111111111108',
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'procedures',
  'especialidades',
  '"Preenchimento labial"'::jsonb,
  'system'
),
(
  '11111111-1111-1111-1111-111111111109',
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'procedures',
  'especialidades',
  '"Harmonização facial"'::jsonb,
  'system'
)
ON CONFLICT (id) DO NOTHING;

-- Diferenciais
INSERT INTO business_memory_entries (id, tenant_id, category, key, value, updated_by)
VALUES (
  '11111111-1111-1111-1111-111111111110',
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'brand',
  'diferenciais',
  '"Enfermeira especialista com certificação em procedimentos injetáveis"'::jsonb,
  'system'
),
(
  '11111111-1111-1111-1111-111111111111',
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'brand',
  'diferenciais',
  '"Atendimento personalizado e humanizado"'::jsonb,
  'system'
),
(
  '11111111-1111-1111-1111-111111111112',
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'brand',
  'diferenciais',
  '"Ambiente premium e acolhedor"'::jsonb,
  'system'
),
(
  '11111111-1111-1111-1111-111111111113',
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'brand',
  'diferenciais',
  '"Protocolos seguros baseados em evidências"'::jsonb,
  'system'
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
