import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAuthTokenTables1717000001000 implements MigrationInterface {
  name = 'CreateAuthTokenTables1717000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- refresh_tokens ---
    await queryRunner.query(`
      CREATE TABLE refresh_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash VARCHAR(255) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        revoked BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // --- email_verification_tokens ---
    await queryRunner.query(`
      CREATE TABLE email_verification_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash VARCHAR(255) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // --- password_reset_tokens ---
    await queryRunner.query(`
      CREATE TABLE password_reset_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash VARCHAR(255) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Indexes for token lookups
    await queryRunner.query(`CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id, revoked);`);
    await queryRunner.query(`CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash);`);
    await queryRunner.query(`CREATE INDEX idx_email_verification_hash ON email_verification_tokens(token_hash);`);
    await queryRunner.query(`CREATE INDEX idx_password_reset_hash ON password_reset_tokens(token_hash);`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS password_reset_tokens CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS email_verification_tokens CASCADE;`);
    await queryRunner.query(`DROP TABLE IF EXISTS refresh_tokens CASCADE;`);
  }
}
