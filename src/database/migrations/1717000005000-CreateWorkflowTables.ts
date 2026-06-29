import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateWorkflowTables1717000005000 implements MigrationInterface {
  name = 'CreateWorkflowTables1717000005000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // =======================================================================
    // TABLE: workflow_executions
    // =======================================================================
    await queryRunner.query(`
      CREATE TABLE workflow_executions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL,
        workflow_id VARCHAR(255) NOT NULL,
        agent_id UUID NOT NULL,
        conversation_id UUID,
        user_id UUID,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        input TEXT NOT NULL,
        output TEXT,
        state_data JSONB DEFAULT '{}',
        steps JSONB DEFAULT '[]',
        tokens_input INTEGER DEFAULT 0,
        tokens_output INTEGER DEFAULT 0,
        duration_ms INTEGER,
        model_id VARCHAR(255),
        used_fallback BOOLEAN DEFAULT false,
        error_message TEXT,
        blocked_reason TEXT,
        guardrail_violations TEXT[],
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        completed_at TIMESTAMP WITH TIME ZONE,
        CONSTRAINT chk_workflow_exec_status CHECK (
          status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'timeout')
        ),
        CONSTRAINT chk_workflow_exec_tokens_input CHECK (tokens_input >= 0),
        CONSTRAINT chk_workflow_exec_tokens_output CHECK (tokens_output >= 0),
        CONSTRAINT chk_workflow_exec_duration_ms CHECK (duration_ms IS NULL OR duration_ms >= 0)
      );
    `);

    // =======================================================================
    // TABLE: workflow_definitions
    // =======================================================================
    await queryRunner.query(`
      CREATE TABLE workflow_definitions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID,
        workflow_id VARCHAR(255) NOT NULL,
        agent_type VARCHAR(100) NOT NULL,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        graph_definition JSONB NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(workflow_id, version)
      );
    `);

    // =======================================================================
    // ROW-LEVEL SECURITY: workflow_executions (tenant-scoped)
    // =======================================================================
    await queryRunner.query(`ALTER TABLE workflow_executions ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE workflow_executions FORCE ROW LEVEL SECURITY;`);

    await queryRunner.query(`
      CREATE POLICY tenant_isolation_select ON workflow_executions
        FOR SELECT
        USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
    `);

    await queryRunner.query(`
      CREATE POLICY tenant_isolation_insert ON workflow_executions
        FOR INSERT
        WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
    `);

    await queryRunner.query(`
      CREATE POLICY tenant_isolation_update ON workflow_executions
        FOR UPDATE
        USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
    `);

    await queryRunner.query(`
      CREATE POLICY tenant_isolation_delete ON workflow_executions
        FOR DELETE
        USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
    `);

    // =======================================================================
    // ROW-LEVEL SECURITY: workflow_definitions (tenant_id nullable = global)
    // =======================================================================
    await queryRunner.query(`ALTER TABLE workflow_definitions ENABLE ROW LEVEL SECURITY;`);
    await queryRunner.query(`ALTER TABLE workflow_definitions FORCE ROW LEVEL SECURITY;`);

    await queryRunner.query(`
      CREATE POLICY tenant_or_global_select ON workflow_definitions
        FOR SELECT
        USING (
          tenant_id IS NULL
          OR tenant_id = current_setting('app.current_tenant', true)::uuid
        );
    `);

    await queryRunner.query(`
      CREATE POLICY tenant_or_global_insert ON workflow_definitions
        FOR INSERT
        WITH CHECK (
          tenant_id IS NULL
          OR tenant_id = current_setting('app.current_tenant', true)::uuid
        );
    `);

    await queryRunner.query(`
      CREATE POLICY tenant_or_global_update ON workflow_definitions
        FOR UPDATE
        USING (
          tenant_id IS NULL
          OR tenant_id = current_setting('app.current_tenant', true)::uuid
        );
    `);

    await queryRunner.query(`
      CREATE POLICY tenant_or_global_delete ON workflow_definitions
        FOR DELETE
        USING (
          tenant_id IS NULL
          OR tenant_id = current_setting('app.current_tenant', true)::uuid
        );
    `);

    // =======================================================================
    // INDEXES: workflow_executions
    // =======================================================================
    await queryRunner.query(`
      CREATE INDEX idx_workflow_exec_tenant ON workflow_executions(tenant_id);
    `);

    await queryRunner.query(`
      CREATE INDEX idx_workflow_exec_tenant_status ON workflow_executions(tenant_id, status);
    `);

    await queryRunner.query(`
      CREATE INDEX idx_workflow_exec_conversation ON workflow_executions(conversation_id);
    `);

    await queryRunner.query(`
      CREATE INDEX idx_workflow_exec_tenant_created ON workflow_executions(tenant_id, created_at DESC);
    `);

    // =======================================================================
    // INDEXES: workflow_definitions
    // =======================================================================
    await queryRunner.query(`
      CREATE INDEX idx_workflow_def_agent_tenant_active ON workflow_definitions(agent_type, tenant_id, is_active);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS workflow_definitions CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS workflow_executions CASCADE;`);
  }
}
