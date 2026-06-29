import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateConfigChangesTable1717000002000 implements MigrationInterface {
  name = 'CreateConfigChangesTable1717000002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE config_changes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id UUID NOT NULL REFERENCES agent_configs(id) ON DELETE CASCADE,
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id UUID NOT NULL,
        field VARCHAR(100) NOT NULL,
        previous_value JSONB,
        new_value JSONB,
        changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Indexes for efficient querying
    await queryRunner.query(`
      CREATE INDEX idx_config_changes_agent ON config_changes(agent_id, changed_at DESC);
    `);
    await queryRunner.query(`
      CREATE INDEX idx_config_changes_tenant ON config_changes(tenant_id);
    `);

    // RLS policies for tenant isolation
    await queryRunner.query(`ALTER TABLE config_changes ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE config_changes FORCE ROW LEVEL SECURITY;`);

    await queryRunner.query(`
      CREATE POLICY tenant_isolation_select ON config_changes
        FOR SELECT
        USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
    `);

    await queryRunner.query(`
      CREATE POLICY tenant_isolation_insert ON config_changes
        FOR INSERT
        WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
    `);

    await queryRunner.query(`
      CREATE POLICY tenant_isolation_update ON config_changes
        FOR UPDATE
        USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
    `);

    await queryRunner.query(`
      CREATE POLICY tenant_isolation_delete ON config_changes
        FOR DELETE
        USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS config_changes CASCADE;`);
  }
}
