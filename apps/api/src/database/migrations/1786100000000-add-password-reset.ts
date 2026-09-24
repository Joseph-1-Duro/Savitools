import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPasswordReset1786100000000 implements MigrationInterface {
  name = "AddPasswordReset1786100000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "password_reset_token" varchar
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "password_reset_expires_at" timestamptz
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
        DROP COLUMN IF EXISTS "password_reset_expires_at"
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
        DROP COLUMN IF EXISTS "password_reset_token"
    `);
  }
}
