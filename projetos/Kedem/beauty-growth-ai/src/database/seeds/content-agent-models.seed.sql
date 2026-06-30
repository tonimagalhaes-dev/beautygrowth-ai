-- =============================================================================
-- Seed: Content Agent Model Registry Configuration
-- Description: Configures primary (GPT-4o) and fallback (GPT-4o-mini) models
--              for the Content Agent (agent_type='content').
-- Idempotent: Uses ON CONFLICT (id) DO NOTHING for safe re-execution.
-- Requirements: 3.5 (Model Registry selection), 3.6 (Fallback model)
-- =============================================================================

-- Fixed UUIDs for deterministic seed (allows referencing in agent_configs)
-- Primary model: GPT-4o for content generation
INSERT INTO ai_models (id, provider, name, version, capabilities, cost_input_token, cost_output_token, context_window, status, max_temperature, max_output_tokens)
VALUES (
  'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  'openai',
  'gpt-4o',
  '2024-08-06',
  ARRAY['text_generation', 'vision', 'function_calling'],
  0.00000250,
  0.00001000,
  128000,
  'available',
  2.0,
  16384
)
ON CONFLICT (id) DO NOTHING;

-- Fallback model: GPT-4o-mini (lower cost, used when primary is unavailable)
INSERT INTO ai_models (id, provider, name, version, capabilities, cost_input_token, cost_output_token, context_window, status, max_temperature, max_output_tokens)
VALUES (
  'b2c3d4e5-f6a7-8901-bcde-f12345678901',
  'openai',
  'gpt-4o-mini',
  '2024-07-18',
  ARRAY['text_generation', 'vision', 'function_calling'],
  0.00000015,
  0.00000060,
  128000,
  'available',
  2.0,
  16384
)
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- Note: The association of these models to agent_type='content' is done via the
-- agent_configs table, where:
--   - model_id references the primary model (gpt-4o)
--   - fallback_model_id references the fallback model (gpt-4o-mini)
--
-- Example agent_configs usage (tenant-scoped, applied per-tenant):
--
--   INSERT INTO agent_configs (tenant_id, agent_type, model_id, fallback_model_id, ...)
--   VALUES (
--     '<tenant_uuid>',
--     'content',
--     'a1b2c3d4-e5f6-7890-abcd-ef1234567890',  -- gpt-4o (primary)
--     'b2c3d4e5-f6a7-8901-bcde-f12345678901',  -- gpt-4o-mini (fallback)
--     ...
--   );
-- =============================================================================
