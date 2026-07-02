-- =============================================================================
-- Seed: Usuário de desenvolvimento para teste local
-- Email: admin@beautygrowth.dev
-- Senha: Admin@123
-- =============================================================================

-- Criar tenant de desenvolvimento
INSERT INTO tenants (id, slug, status, settings)
VALUES (
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'clinica-demo',
  'active',
  '{}'::jsonb
)
ON CONFLICT (slug) DO NOTHING;

-- Criar usuário admin
-- Senha: Admin@123 (bcrypt hash com 12 salt rounds)
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
