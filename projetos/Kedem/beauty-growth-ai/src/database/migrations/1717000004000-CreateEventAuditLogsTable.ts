import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateEventAuditLogsTable1717000004000
  implements MigrationInterface
{
  name = 'CreateEventAuditLogsTable1717000004000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Create event_audit_logs table
    await queryRunner.query(`
      CREATE TABLE event_audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_name VARCHAR NOT NULL,
        payload JSONB NOT NULL,
        tenant_id UUID NOT NULL,
        correlation_id UUID NOT NULL,
        published_at TIMESTAMPTZ NOT NULL,
        processed_at TIMESTAMPTZ,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        status VARCHAR(20) NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1,
        errors JSONB,
        is_replay BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Index on tenant_id for tenant-filtered queries
    await queryRunner.query(`
      CREATE INDEX idx_event_audit_logs_tenant_id ON event_audit_logs(tenant_id);
    `);

    // Index on event_name for event-type queries
    await queryRunner.query(`
      CREATE INDEX idx_event_audit_logs_event_name ON event_audit_logs(event_name);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TABLE IF EXISTS event_audit_logs CASCADE;`,
    );
  }
}
