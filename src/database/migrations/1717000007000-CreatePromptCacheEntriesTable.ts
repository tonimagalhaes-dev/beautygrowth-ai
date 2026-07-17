import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePromptCacheEntriesTable1717000007000 implements MigrationInterface {
  name = 'CreatePromptCacheEntriesTable1717000007000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // =======================================================================
    // EXTENSION: pg_trgm (for similar match trigram searches)
    // =======================================================================
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);

    // =======================================================================
    // TABLE: prompt_cache_entries
    // =======================================================================
    await queryRunner.query(`
      CREATE TABLE prompt_cache_entries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        user_id UUID NOT NULL,
        execution_id UUID NOT NULL,
        tema TEXT NOT NULL,
        procedimento UUID,
        publico_alvo_override VARCHAR(300),
        redes_sociais TEXT[] NOT NULL,
        idioma VARCHAR(10) NOT NULL DEFAULT 'pt-BR',
        fingerprint VARCHAR(64) NOT NULL,
        normalized_tema TEXT NOT NULL,
        response_payload JSONB NOT NULL,
        image_references JSONB NOT NULL DEFAULT '[]',
        tokens_consumed_input INT NOT NULL DEFAULT 0,
        tokens_consumed_output INT NOT NULL DEFAULT 0,
        modelo_utilizado VARCHAR(255) NOT NULL,
        hit_count INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // =======================================================================
    // INDEXES
    // =======================================================================

    // Unique composite index for exact match lookups (tenant-scoped)
    await queryRunner.query(`
      CREATE UNIQUE INDEX idx_prompt_cache_tenant_fingerprint
        ON prompt_cache_entries (tenant_id, fingerprint);
    `);

    // Index for chronological listing per tenant
    await queryRunner.query(`
      CREATE INDEX idx_prompt_cache_tenant_created
        ON prompt_cache_entries (tenant_id, created_at DESC);
    `);

    // GIN trigram index on normalized_tema for similar match searches
    await queryRunner.query(`
      CREATE INDEX idx_prompt_cache_tema_trgm
        ON prompt_cache_entries USING gin (normalized_tema gin_trgm_ops);
    `);

    // =======================================================================
    // ROW-LEVEL SECURITY: prompt_cache_entries
    // =======================================================================
    await queryRunner.query(`ALTER TABLE prompt_cache_entries ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE prompt_cache_entries FORCE ROW LEVEL SECURITY;`);

    await queryRunner.query(`
      CREATE POLICY prompt_cache_tenant_isolation_select ON prompt_cache_entries
        FOR SELECT
        USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
    `);

    await queryRunner.query(`
      CREATE POLICY prompt_cache_tenant_isolation_insert ON prompt_cache_entries
        FOR INSERT
        WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
    `);

    await queryRunner.query(`
      CREATE POLICY prompt_cache_tenant_isolation_update ON prompt_cache_entries
        FOR UPDATE
        USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
    `);

    await queryRunner.query(`
      CREATE POLICY prompt_cache_tenant_isolation_delete ON prompt_cache_entries
        FOR DELETE
        USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS prompt_cache_entries CASCADE;`);
  }
}
