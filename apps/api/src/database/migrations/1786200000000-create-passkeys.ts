import { MigrationInterface, QueryRunner } from "typeorm";

export class CreatePasskeys1786200000000 implements MigrationInterface {
  name = "CreatePasskeys1786200000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "passkeys" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "name" varchar NOT NULL,
        "credential_id" varchar NOT NULL UNIQUE,
        "algorithm" integer NOT NULL,
        "public_key" text NOT NULL,
        "counter" bigint NOT NULL DEFAULT 0,
        "transports" json,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "last_used_at" timestamptz,
        "revoked_at" timestamptz
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_passkeys_user_id" ON "passkeys" ("user_id")
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'FK_passkeys_user_id'
        ) THEN
          ALTER TABLE "passkeys"
            ADD CONSTRAINT "FK_passkeys_user_id"
            FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
        END IF;
      END $$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "passkeys"`);
  }
}
