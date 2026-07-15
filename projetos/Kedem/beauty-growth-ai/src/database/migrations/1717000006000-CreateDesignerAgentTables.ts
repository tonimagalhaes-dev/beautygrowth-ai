import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateDesignerAgentTables1717000006000 implements MigrationInterface {
  name = 'CreateDesignerAgentTables1717000006000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // =======================================================================
    // TABLE: designer_executions
    // =======================================================================
    await queryRunner.query(`
      CREATE TABLE designer_executions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        execution_id UUID NOT NULL UNIQUE,
        tenant_id UUID NOT NULL,
        user_id UUID NOT NULL,
        content_execution_id UUID,
        status VARCHAR(50) NOT NULL DEFAULT 'processing',
        descricao_visual TEXT NOT NULL,
        redes_sociais TEXT[] NOT NULL,
        estilo_visual_adicional TEXT,
        aplicar_logo_overlay BOOLEAN DEFAULT false,
        logo_overlay_aplicado BOOLEAN DEFAULT false,
        version INTEGER NOT NULL DEFAULT 1,
        modelo_utilizado VARCHAR(255),
        usou_fallback BOOLEAN DEFAULT false,
        tokens_consumidos INTEGER DEFAULT 0,
        duracao_ms INTEGER,
        guardrail_violations JSONB DEFAULT '[]',
        warnings TEXT[] DEFAULT '{}',
        brand_identity_defaults_used BOOLEAN DEFAULT false,
        trace_id UUID,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        completed_at TIMESTAMP WITH TIME ZONE,
        CONSTRAINT chk_designer_exec_status CHECK (
          status IN ('processing', 'generated', 'guardrail_blocked', 'error')
        ),
        CONSTRAINT chk_designer_exec_tokens CHECK (tokens_consumidos >= 0),
        CONSTRAINT chk_designer_exec_duration CHECK (duracao_ms IS NULL OR duracao_ms >= 0),
        CONSTRAINT chk_designer_exec_version CHECK (version >= 1)
      );
    `);

    // =======================================================================
    // ROW-LEVEL SECURITY: designer_executions
    // =======================================================================
    await queryRunner.query(`ALTER TABLE designer_executions ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE designer_executions FORCE ROW LEVEL SECURITY;`);

    await queryRunner.query(`
      CREATE POLICY tenant_isolation_select ON designer_executions
        FOR SELECT
        USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
    `);

    await queryRunner.query(`
      CREATE POLICY tenant_isolation_insert ON designer_executions
        FOR INSERT
        WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
    `);

    await queryRunner.query(`
      CREATE POLICY tenant_isolation_update ON designer_executions
        FOR UPDATE
        USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
    `);

    await queryRunner.query(`
      CREATE POLICY tenant_isolation_delete ON designer_executions
        FOR DELETE
        USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
    `);

    // =======================================================================
    // INDEXES: designer_executions
    // =======================================================================
    await queryRunner.query(`
      CREATE INDEX idx_designer_exec_tenant ON designer_executions(tenant_id);
    `);

    await queryRunner.query(`
      CREATE INDEX idx_designer_exec_status ON designer_executions(tenant_id, status);
    `);

    await queryRunner.query(`
      CREATE INDEX idx_designer_exec_content ON designer_executions(content_execution_id);
    `);

    await queryRunner.query(`
      CREATE INDEX idx_designer_exec_created ON designer_executions(tenant_id, created_at DESC);
    `);

    // =======================================================================
    // TABLE: designer_images
    // =======================================================================
    await queryRunner.query(`
      CREATE TABLE designer_images (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        execution_id UUID NOT NULL REFERENCES designer_executions(execution_id),
        tenant_id UUID NOT NULL,
        rede_social VARCHAR(20) NOT NULL,
        aspecto_ratio VARCHAR(10) NOT NULL,
        largura_px INTEGER NOT NULL,
        altura_px INTEGER NOT NULL,
        tamanho_bytes INTEGER NOT NULL,
        formato VARCHAR(10) NOT NULL DEFAULT 'PNG',
        minio_path TEXT NOT NULL,
        minio_path_thumbnail TEXT NOT NULL,
        minio_path_sem_overlay TEXT,
        url_presigned TEXT,
        url_presigned_thumbnail TEXT,
        url_presigned_sem_overlay TEXT,
        url_presigned_expires_at TIMESTAMP WITH TIME ZONE,
        modelo_utilizado VARCHAR(255) NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        is_latest BOOLEAN DEFAULT true,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        CONSTRAINT chk_designer_img_rede CHECK (
          rede_social IN ('instagram', 'facebook', 'tiktok')
        ),
        CONSTRAINT chk_designer_img_dimensions CHECK (largura_px > 0 AND altura_px > 0),
        CONSTRAINT chk_designer_img_size CHECK (tamanho_bytes > 0),
        CONSTRAINT chk_designer_img_version CHECK (version >= 1)
      );
    `);

    // =======================================================================
    // ROW-LEVEL SECURITY: designer_images
    // =======================================================================
    await queryRunner.query(`ALTER TABLE designer_images ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE designer_images FORCE ROW LEVEL SECURITY;`);

    await queryRunner.query(`
      CREATE POLICY tenant_isolation_select ON designer_images
        FOR SELECT
        USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
    `);

    await queryRunner.query(`
      CREATE POLICY tenant_isolation_insert ON designer_images
        FOR INSERT
        WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
    `);

    await queryRunner.query(`
      CREATE POLICY tenant_isolation_update ON designer_images
        FOR UPDATE
        USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
    `);

    await queryRunner.query(`
      CREATE POLICY tenant_isolation_delete ON designer_images
        FOR DELETE
        USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
    `);

    // =======================================================================
    // INDEXES: designer_images
    // =======================================================================
    await queryRunner.query(`
      CREATE INDEX idx_designer_img_execution ON designer_images(execution_id);
    `);

    await queryRunner.query(`
      CREATE INDEX idx_designer_img_tenant ON designer_images(tenant_id);
    `);

    await queryRunner.query(`
      CREATE INDEX idx_designer_img_latest ON designer_images(execution_id, rede_social, is_latest)
        WHERE is_latest = true;
    `);

    await queryRunner.query(`
      CREATE INDEX idx_designer_img_expired ON designer_images(url_presigned_expires_at)
        WHERE url_presigned_expires_at IS NOT NULL;
    `);

    // =======================================================================
    // TABLE: designer_edit_history
    // =======================================================================
    await queryRunner.query(`
      CREATE TABLE designer_edit_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        execution_id UUID NOT NULL REFERENCES designer_executions(execution_id),
        tenant_id UUID NOT NULL,
        rede_social VARCHAR(20) NOT NULL,
        version INTEGER NOT NULL,
        instrucao_edicao TEXT NOT NULL,
        prompt_visual_utilizado TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(execution_id, rede_social, version),
        CONSTRAINT chk_designer_edit_rede CHECK (
          rede_social IN ('instagram', 'facebook', 'tiktok')
        ),
        CONSTRAINT chk_designer_edit_version CHECK (version >= 1)
      );
    `);

    // =======================================================================
    // ROW-LEVEL SECURITY: designer_edit_history
    // =======================================================================
    await queryRunner.query(`ALTER TABLE designer_edit_history ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE designer_edit_history FORCE ROW LEVEL SECURITY;`);

    await queryRunner.query(`
      CREATE POLICY tenant_isolation_select ON designer_edit_history
        FOR SELECT
        USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
    `);

    await queryRunner.query(`
      CREATE POLICY tenant_isolation_insert ON designer_edit_history
        FOR INSERT
        WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
    `);

    await queryRunner.query(`
      CREATE POLICY tenant_isolation_update ON designer_edit_history
        FOR UPDATE
        USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
    `);

    await queryRunner.query(`
      CREATE POLICY tenant_isolation_delete ON designer_edit_history
        FOR DELETE
        USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
    `);

    // =======================================================================
    // INDEXES: designer_edit_history
    // =======================================================================
    await queryRunner.query(`
      CREATE INDEX idx_designer_edit_exec ON designer_edit_history(execution_id, rede_social);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS designer_edit_history CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS designer_images CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS designer_executions CASCADE;`);
  }
}
