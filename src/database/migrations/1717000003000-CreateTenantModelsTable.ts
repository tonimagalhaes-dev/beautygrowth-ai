import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateTenantModelsTable1717000003000 implements MigrationInterface {
  name = 'CreateTenantModelsTable1717000003000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create tenant_models junction table
    await queryRunner.query(`
      CREATE TABLE tenant_models (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        model_id UUID NOT NULL REFERENCES ai_models(id) ON DELETE CASCADE,
        is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        enabled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        disabled_at TIMESTAMPTZ,
        UNIQUE(tenant_id, model_id)
      );
    `);

    // Indexes
    await queryRunner.query(`
      CREATE INDEX idx_tenant_models_tenant ON tenant_models(tenant_id);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_tenant_models_model ON tenant_models(model_id);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_tenant_models_tenant_enabled ON tenant_models(tenant_id, is_enabled);
    `);

    // RLS
    await queryRunner.query(`ALTER TABLE tenant_models ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE tenant_models FORCE ROW LEVEL SECURITY;`);

    await queryRunner.query(`
      CREATE POLICY tenant_models_select ON tenant_models
        FOR SELECT
        USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
    `);

    await queryRunner.query(`
      CREATE POLICY tenant_models_insert ON tenant_models
        FOR INSERT
        WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
    `);

    await queryRunner.query(`
      CREATE POLICY tenant_models_update ON tenant_models
        FOR UPDATE
        USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
    `);

    await queryRunner.query(`
      CREATE POLICY tenant_models_delete ON tenant_models
        FOR DELETE
        USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS tenant_models CASCADE;`);
  }
}
