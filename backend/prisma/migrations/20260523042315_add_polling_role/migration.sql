-- CreateEnum
CREATE TYPE "PollingRole" AS ENUM ('WATCHER', 'BOOKER', 'BOTH');

-- AlterTable
ALTER TABLE "VfsAccount" ADD COLUMN     "pollingRole" "PollingRole" NOT NULL DEFAULT 'BOTH';
