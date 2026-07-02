-- =============================================================================
-- Seed: Content Agent Model Registry Configuration
-- Description: Configures primary (gemini-2.0-flash) and fallback (gemini-1.5-flash)
--              models for the Content Agent (agent_type='content').
-- Idempotent: Uses ON CONFLICT (id) DO UPDATE for safe re-execution.
-- Requirements: 3.5 (Model Registry selection), 3.6 (Fallback model)
-- =============================================================================

-- Fixed UUIDs for deterministic seed (allows referencing in agent_configs)
-- Primary model: Gemini 2.0 Flash for content generation
INSERT INTO ai_models (id, provider, name, version, capabilities, cost_input_token, cost_output_token, context_window, status, max_temperature, max_output_tokens)
VALUES (
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'google',
  'gemini-2.0-flash',
  '2025-01',
  ARRAY['text_generation', 'vision', 'function_calling'],
  0.00000010,
  0.00000040,
  1048576,
  'available',
  2.0,
  8192
)
ON CONFLICT (id) DO UPDATE SET
  provider = EXCLUDED.provider,
  name = EXCLUDED.name,
  version = EXCLUDED.version,
  capabilities = EXCLUDED.capabilities,
  cost_input_token = EXCLUDED.cost_input_token,
  cost_output_token = EXCLUDED.cost_output_token,
  context_window = EXCLUDED.context_window,
  status = EXCLUDED.status,
  max_temperature = EXCLUDED.max_temperature,
  max_output_tokens = EXCLUDED.max_output_tokens;

-- Fallback model: Gemini 1.5 Flash (lower cost, used when primary is unavailable)
INSERT INTO ai_models (id, provider, name, version, capabilities, cost_input_token, cost_output_token, context_window, status, max_temperature, max_output_tokens)
VALUES (
  'b2c3d4e5-f6a7-8901-bcde-f12345678901',
  'google',
  'gemini-1.5-flash',
  '2024-12',
  ARRAY['text_generation', 'vision', 'function_calling'],
  0.00000008,
  0.00000030,
  1048576,
  'available',
  2.0,
  8192
)
ON CONFLICT (id) DO UPDATE SET
  provider = EXCLUDED.provider,
  name = EXCLUDED.name,
  version = EXCLUDED.version,
  capabilities = EXCLUDED.capabilities,
  cost_input_token = EXCLUDED.cost_input_token,
  cost_output_token = EXCLUDED.cost_output_token,
  context_window = EXCLUDED.context_window,
  status = EXCLUDED.status,
  max_temperature = EXCLUDED.max_temperature,
  max_output_tokens = EXCLUDED.max_output_tokens;

-- =============================================================================
-- Note: The association of these models to agent_type='content' is done via the
-- agent_configs table, where:
--   - model_id references the primary model (gemini-2.0-flash)
--   - fallback_model_id references the fallback model (gemini-1.5-flash)
--
-- Example agent_configs usage (tenant-scoped, applied per-tenant):
--
--   INSERT INTO agent_configs (tenant_id, agent_type, model_id, fallback_model_id, ...)
--   VALUES (
--     '<tenant_uuid>',
--     'content',
--     'a1b2c3d4-e5f6-7890-abcd-ef1234567890',  -- gemini-2.0-flash (primary)
--     'b2c3d4e5-f6a7-8901-bcde-f12345678901',  -- gemini-1.5-flash (fallback)
--     ...
--   );
-- =============================================================================
