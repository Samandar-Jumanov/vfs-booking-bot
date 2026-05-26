-- CreateEnum
CREATE TYPE "LifecycleStateEnum" AS ENUM ('NEW', 'REGISTERING', 'REGISTER_FAILED', 'PENDING_ACTIVATION', 'ACTIVATING', 'ACTIVE', 'LOGGING_IN', 'WARM', 'RESTRICTED', 'BLOCKED');

-- AlterTable
ALTER TABLE "VfsAccount"
ADD COLUMN "lifecycleState"   "LifecycleStateEnum" NOT NULL DEFAULT 'NEW',
ADD COLUMN "attemptCount"     INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastAttemptAt"    TIMESTAMP(3),
ADD COLUMN "restrictedReason" TEXT,
ADD COLUMN "lastError"        TEXT;
