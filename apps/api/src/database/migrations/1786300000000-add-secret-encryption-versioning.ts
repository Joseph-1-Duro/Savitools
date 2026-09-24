import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSecretEncryptionVersioning1786300000000 implements MigrationInterface {
  name = "AddSecretEncryptionVersioning1786300000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "api_keys"
      ADD COLUMN IF NOT EXISTS "key_version" integer NOT NULL DEFAULT 1
    `);

    await queryRunner.query(`
      ALTER TABLE "monitor_webhooks"
      ADD COLUMN IF NOT EXISTS "iv" text,
      ADD COLUMN IF NOT EXISTS "auth_tag" text,
      ADD COLUMN IF NOT EXISTS "secret_version" integer NOT NULL DEFAULT 1
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "monitor_webhooks"
      DROP COLUMN IF EXISTS "secret_version",
      DROP COLUMN IF EXISTS "auth_tag",
      DROP COLUMN IF EXISTS "iv"
    `);

    await queryRunner.query(`
      ALTER TABLE "api_keys"
      DROP COLUMN IF EXISTS "key_version"
    `);
  }
}
