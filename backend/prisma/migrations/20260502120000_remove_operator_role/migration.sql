-- Migrate any existing OPERATOR users to ADMIN, then drop OPERATOR from the enum.

UPDATE "users" SET "role" = 'ADMIN' WHERE "role" = 'OPERATOR';

-- Postgres requires recreating the enum to drop a value
ALTER TYPE "Role" RENAME TO "Role_old";
CREATE TYPE "Role" AS ENUM ('ADMIN');
ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "role" TYPE "Role" USING ("role"::text::"Role");
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'ADMIN';
DROP TYPE "Role_old";
