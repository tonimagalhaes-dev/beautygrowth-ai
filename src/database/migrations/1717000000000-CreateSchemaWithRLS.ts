import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSchemaWithRLS1717000000000 implements MigrationInterface {
  name = 'CreateSchemaWithRLS1717000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // =======================================================================
    // ENUMS
    // =======================================================================
    await queryRunner.query(`
      CREATE TYPE tenant_status AS ENUM ('active', 'suspended', 'cancelled');
      CREATE TYPE user_role AS ENUM ('admin', 'operator', 'viewer');
      CREATE TYPE agent_type AS ENUM ('content', 'campaigns', 'customer_service');
      CREATE TYPE agent_status AS ENUM ('active', 'inactive', 'configuring');
      CREATE TYPE memory_role AS ENUM ('user', 'assistant', 'system');
      CREATE TYPE long_term_memory_type AS ENUM ('learning', 'pattern', 'preference');
      CREATE TYPE memory_category AS ENUM ('brand', 'audience', 'campaigns', 'procedures', 'preferences');
      CREATE TYPE document_format AS ENUM ('pdf', 'docx', 'txt', 'md');
      CREATE TYPE document_status AS ENUM ('pending', 'processing', 'processed', 'error');
      CREATE TYPE model_provider AS ENUM ('openai', 'anthropic', 'google', 'meta', 'alibaba', 'deepseek');
      CREATE TYPE model_status AS ENUM ('available', 'deprecated', 'testing');
      CREATE TYPE prompt_function AS ENUM ('system', 'task', 'formatting');
      CREATE TYPE guardrail_type AS ENUM ('system', 'tenant');
      CREATE TYPE consent_status AS ENUM ('active', 'revoked', 'expired');
      CREATE TYPE audit_status AS ENUM ('success', 'error');
      CREATE TYPE invitation_status AS ENUM ('pending', 'accepted', 'expired', 'cancelled');
    `);

    // =======================================================================
    // TABLES
    // =======================================================================

    // --- tenants ---
    await queryRunner.query(`
      CREATE TABLE tenants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug VARCHAR(100) NOT NULL UNIQUE,
        status tenant_status NOT NULL DEFAULT 'active',
        settings JSONB NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // --- users ---
    await queryRunner.query(`
      CREATE TABLE users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        email VARCHAR(320) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        role user_role NOT NULL DEFAULT 'admin',
        email_verified BOOLEAN NOT NULL DEFAULT FALSE,
        failed_login_attempts INT NOT NULL DEFAULT 0,
        locked_until TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // --- clinics ---
    await queryRunner.query(`
      CREATE TABLE clinics (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name VARCHAR(120) NOT NULL,
        phone VARCHAR(20) NOT NULL,
        email VARCHAR(320) NOT NULL,
        specialties TEXT[] NOT NULL DEFAULT '{}',
        target_audience TEXT,
        address JSONB,
        website VARCHAR(500),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // --- brand_identities ---
    await queryRunner.query(`
      CREATE TABLE brand_identities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        voice_tone TEXT,
        color_palette JSONB NOT NULL DEFAULT '[]',
        logo_url VARCHAR(500),
        target_audience TEXT,
        differentials TEXT[] NOT NULL DEFAULT '{}',
        "values" TEXT[] NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // --- ai_models (non-tenant-scoped) ---
    await queryRunner.query(`
      CREATE TABLE ai_models (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        provider model_provider NOT NULL,
        name VARCHAR(100) NOT NULL,
        version VARCHAR(50) NOT NULL,
        capabilities TEXT[] NOT NULL DEFAULT '{}',
        cost_input_token DECIMAL(12, 8) NOT NULL DEFAULT 0,
        cost_output_token DECIMAL(12, 8) NOT NULL DEFAULT 0,
        context_window INT NOT NULL DEFAULT 4096,
        status model_status NOT NULL DEFAULT 'available',
        max_temperature FLOAT NOT NULL DEFAULT 2.0,
        max_output_tokens INT NOT NULL DEFAULT 4096
      );
    `);

    // --- prompts (non-tenant-scoped) ---
    await queryRunner.query(`
      CREATE TABLE prompts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_type agent_type NOT NULL,
        "function" prompt_function NOT NULL,
        active_version VARCHAR(50),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // --- prompt_versions ---
    await queryRunner.query(`
      CREATE TABLE prompt_versions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        prompt_id UUID NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
        version VARCHAR(50) NOT NULL,
        content TEXT NOT NULL,
        variables TEXT[] NOT NULL DEFAULT '{}',
        author UUID REFERENCES users(id) ON DELETE SET NULL,
        description TEXT,
        is_active BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // --- agent_configs ---
    await queryRunner.query(`
      CREATE TABLE agent_configs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        agent_type agent_type NOT NULL,
        status agent_status NOT NULL DEFAULT 'configuring',
        model_id UUID REFERENCES ai_models(id) ON DELETE SET NULL,
        temperature FLOAT NOT NULL DEFAULT 0.7,
        max_tokens INT NOT NULL DEFAULT 2048,
        system_prompt_id UUID REFERENCES prompts(id) ON DELETE SET NULL,
        knowledge_categories TEXT[] NOT NULL DEFAULT '{}',
        fallback_model_id UUID REFERENCES ai_models(id) ON DELETE SET NULL,
        last_executed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // --- agent_memory_short ---
    await queryRunner.query(`
      CREATE TABLE agent_memory_short (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id UUID NOT NULL REFERENCES agent_configs(id) ON DELETE CASCADE,
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        role memory_role NOT NULL,
        content TEXT NOT NULL,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // --- agent_memory_long ---
    await queryRunner.query(`
      CREATE TABLE agent_memory_long (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id UUID NOT NULL REFERENCES agent_configs(id) ON DELETE CASCADE,
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        type long_term_memory_type NOT NULL,
        summary TEXT NOT NULL,
        confidence FLOAT NOT NULL DEFAULT 0.5,
        source_interactions UUID[] NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // --- business_memory_entries ---
    await queryRunner.query(`
      CREATE TABLE business_memory_entries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        category memory_category NOT NULL,
        key VARCHAR(255) NOT NULL,
        value JSONB NOT NULL DEFAULT '{}',
        version INT NOT NULL DEFAULT 1,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_by VARCHAR(255) NOT NULL DEFAULT 'system'
      );
    `);

    // --- documents ---
    await queryRunner.query(`
      CREATE TABLE documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        file_name VARCHAR(500) NOT NULL,
        format document_format NOT NULL,
        size_bytes INT NOT NULL,
        category VARCHAR(100) NOT NULL DEFAULT 'general',
        status document_status NOT NULL DEFAULT 'pending',
        chunks_count INT NOT NULL DEFAULT 0,
        storage_key VARCHAR(500) NOT NULL,
        uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,
        uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL
      );
    `);

    // --- guardrails ---
    await queryRunner.query(`
      CREATE TABLE guardrails (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
        type guardrail_type NOT NULL,
        name VARCHAR(200) NOT NULL,
        description TEXT,
        rule JSONB NOT NULL DEFAULT '{}',
        version INT NOT NULL DEFAULT 1,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // --- consents ---
    await queryRunner.query(`
      CREATE TABLE consents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        subject_id VARCHAR(320) NOT NULL,
        purpose VARCHAR(200) NOT NULL,
        collection_method VARCHAR(100) NOT NULL,
        granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        status consent_status NOT NULL DEFAULT 'active'
      );
    `);

    // --- audit_logs ---
    await queryRunner.query(`
      CREATE TABLE audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        trace_id VARCHAR(100),
        tenant_id UUID,
        agent_id UUID,
        user_id UUID,
        action_type VARCHAR(100) NOT NULL,
        input TEXT,
        output TEXT,
        duration_ms INT,
        status audit_status NOT NULL DEFAULT 'success',
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // --- token_usage ---
    await queryRunner.query(`
      CREATE TABLE token_usage (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        agent_id UUID NOT NULL REFERENCES agent_configs(id) ON DELETE CASCADE,
        model_id UUID NOT NULL REFERENCES ai_models(id) ON DELETE CASCADE,
        input_tokens INT NOT NULL DEFAULT 0,
        output_tokens INT NOT NULL DEFAULT 0,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // --- invitations ---
    await queryRunner.query(`
      CREATE TABLE invitations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        email VARCHAR(320) NOT NULL,
        role user_role NOT NULL DEFAULT 'operator',
        token_hash VARCHAR(255) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        status invitation_status NOT NULL DEFAULT 'pending',
        invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // =======================================================================
    // PREVENT MODIFICATION TRIGGER FUNCTION (for audit_logs immutability)
    // =======================================================================
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION prevent_modification()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'Audit logs are immutable. UPDATE and DELETE operations are not allowed.';
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      CREATE TRIGGER audit_log_immutable
        BEFORE UPDATE OR DELETE ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION prevent_modification();
    `);

    // =======================================================================
    // ROW-LEVEL SECURITY POLICIES
    // =======================================================================

    // Helper: Enable RLS + create policies for a tenant-scoped table
    const tenantScopedTables = [
      'users',
      'clinics',
      'brand_identities',
      'agent_configs',
      'agent_memory_short',
      'agent_memory_long',
      'business_memory_entries',
      'documents',
      'consents',
      'token_usage',
      'invitations',
    ];

    for (const table of tenantScopedTables) {
      await queryRunner.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
      await queryRunner.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);

      await queryRunner.query(`
        CREATE POLICY tenant_isolation_select ON ${table}
          FOR SELECT
          USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
      `);

      await queryRunner.query(`
        CREATE POLICY tenant_isolation_insert ON ${table}
          FOR INSERT
          WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
      `);

      await queryRunner.query(`
        CREATE POLICY tenant_isolation_update ON ${table}
          FOR UPDATE
          USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
      `);

      await queryRunner.query(`
        CREATE POLICY tenant_isolation_delete ON ${table}
          FOR DELETE
          USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
      `);
    }

    // Guardrails: special RLS — tenant_id is nullable (system guardrails have NULL tenant_id)
    await queryRunner.query(`ALTER TABLE guardrails ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE guardrails FORCE ROW LEVEL SECURITY;`);

    await queryRunner.query(`
      CREATE POLICY guardrails_select ON guardrails
        FOR SELECT
        USING (
          tenant_id IS NULL
          OR tenant_id = current_setting('app.current_tenant', true)::uuid
        );
    `);

    await queryRunner.query(`
      CREATE POLICY guardrails_insert ON guardrails
        FOR INSERT
        WITH CHECK (
          tenant_id IS NULL
          OR tenant_id = current_setting('app.current_tenant', true)::uuid
        );
    `);

    await queryRunner.query(`
      CREATE POLICY guardrails_update ON guardrails
        FOR UPDATE
        USING (
          tenant_id IS NULL
          OR tenant_id = current_setting('app.current_tenant', true)::uuid
        );
    `);

    await queryRunner.query(`
      CREATE POLICY guardrails_delete ON guardrails
        FOR DELETE
        USING (
          tenant_id IS NULL
          OR tenant_id = current_setting('app.current_tenant', true)::uuid
        );
    `);

    // Audit logs: RLS based on tenant_id (tenant_id can be NULL for system-level events)
    await queryRunner.query(`ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;`);

    await queryRunner.query(`
      CREATE POLICY audit_logs_select ON audit_logs
        FOR SELECT
        USING (
          tenant_id IS NULL
          OR tenant_id = current_setting('app.current_tenant', true)::uuid
        );
    `);

    await queryRunner.query(`
      CREATE POLICY audit_logs_insert ON audit_logs
        FOR INSERT
        WITH CHECK (
          tenant_id IS NULL
          OR tenant_id = current_setting('app.current_tenant', true)::uuid
        );
    `);

    // No UPDATE or DELETE policy for audit_logs — the trigger already prevents it,
    // but we enforce it at RLS level too
    await queryRunner.query(`
      CREATE POLICY audit_logs_no_update ON audit_logs
        FOR UPDATE
        USING (FALSE);
    `);

    await queryRunner.query(`
      CREATE POLICY audit_logs_no_delete ON audit_logs
        FOR DELETE
        USING (FALSE);
    `);

    // =======================================================================
    // INDEXES
    // =======================================================================
    await queryRunner.query(`CREATE INDEX idx_clinic_tenant ON clinics(tenant_id);`);
    await queryRunner.query(`CREATE INDEX idx_agent_config_tenant ON agent_configs(tenant_id);`);
    await queryRunner.query(`CREATE INDEX idx_business_memory_tenant_category ON business_memory_entries(tenant_id, category);`);
    await queryRunner.query(`CREATE INDEX idx_agent_memory_short_agent ON agent_memory_short(agent_id, created_at DESC);`);
    await queryRunner.query(`CREATE INDEX idx_agent_memory_long_agent ON agent_memory_long(agent_id, type);`);
    await queryRunner.query(`CREATE INDEX idx_documents_tenant_status ON documents(tenant_id, status);`);
    await queryRunner.query(`CREATE INDEX idx_audit_log_tenant_time ON audit_logs(tenant_id, created_at DESC);`);
    await queryRunner.query(`CREATE INDEX idx_audit_log_trace ON audit_logs(trace_id);`);
    await queryRunner.query(`CREATE INDEX idx_token_usage_tenant_model ON token_usage(tenant_id, model_id, recorded_at);`);
    await queryRunner.query(`CREATE INDEX idx_consent_subject ON consents(tenant_id, subject_id, status);`);

    // Additional useful indexes
    await queryRunner.query(`CREATE INDEX idx_users_tenant ON users(tenant_id);`);
    await queryRunner.query(`CREATE INDEX idx_users_email ON users(email);`);
    await queryRunner.query(`CREATE INDEX idx_brand_identity_tenant ON brand_identities(tenant_id);`);
    await queryRunner.query(`CREATE INDEX idx_invitations_tenant ON invitations(tenant_id);`);
    await queryRunner.query(`CREATE INDEX idx_invitations_email ON invitations(email, status);`);
    await queryRunner.query(`CREATE INDEX idx_invitations_token ON invitations(token_hash);`);
    await queryRunner.query(`CREATE INDEX idx_prompt_versions_prompt ON prompt_versions(prompt_id, is_active);`);
    await queryRunner.query(`CREATE INDEX idx_guardrails_tenant ON guardrails(tenant_id, is_active);`);
    await queryRunner.query(`CREATE INDEX idx_agent_memory_short_tenant ON agent_memory_short(tenant_id);`);
    await queryRunner.query(`CREATE INDEX idx_agent_memory_long_tenant ON agent_memory_long(tenant_id);`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop tables in reverse dependency order
    await queryRunner.query(`DROP TABLE IF EXISTS invitations CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS token_usage CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS audit_logs CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS consents CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS guardrails CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS documents CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS business_memory_entries CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS agent_memory_long CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS agent_memory_short CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS agent_configs CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS prompt_versions CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS prompts CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS ai_models CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS brand_identities CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS clinics CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS users CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS tenants CASCADE;`);

    // Drop function
    await queryRunner.query(`DROP FUNCTION IF EXISTS prevent_modification() CASCADE;`);

    // Drop enums
    await queryRunner.query(`DROP TYPE IF EXISTS invitation_status;`);
    await queryRunner.query(`DROP TYPE IF EXISTS audit_status;`);
    await queryRunner.query(`DROP TYPE IF EXISTS consent_status;`);
    await queryRunner.query(`DROP TYPE IF EXISTS guardrail_type;`);
    await queryRunner.query(`DROP TYPE IF EXISTS prompt_function;`);
    await queryRunner.query(`DROP TYPE IF EXISTS model_status;`);
    await queryRunner.query(`DROP TYPE IF EXISTS model_provider;`);
    await queryRunner.query(`DROP TYPE IF EXISTS document_status;`);
    await queryRunner.query(`DROP TYPE IF EXISTS document_format;`);
    await queryRunner.query(`DROP TYPE IF EXISTS memory_category;`);
    await queryRunner.query(`DROP TYPE IF EXISTS long_term_memory_type;`);
    await queryRunner.query(`DROP TYPE IF EXISTS memory_role;`);
    await queryRunner.query(`DROP TYPE IF EXISTS agent_status;`);
    await queryRunner.query(`DROP TYPE IF EXISTS agent_type;`);
    await queryRunner.query(`DROP TYPE IF EXISTS user_role;`);
    await queryRunner.query(`DROP TYPE IF EXISTS tenant_status;`);
  }
}
