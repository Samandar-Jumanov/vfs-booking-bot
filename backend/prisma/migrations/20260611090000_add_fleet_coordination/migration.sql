CREATE TYPE "WorkerBoxRole" AS ENUM ('CREATOR', 'WATCHER', 'BOOKER', 'COOLDOWN', 'OFFLINE');

CREATE TYPE "WorkerBoxStatus" AS ENUM ('ONLINE', 'WORKING', 'COOLDOWN', 'OFFLINE');

CREATE TABLE "WorkerBox" (
  "boxId" TEXT NOT NULL,
  "role" "WorkerBoxRole" NOT NULL DEFAULT 'OFFLINE',
  "status" "WorkerBoxStatus" NOT NULL DEFAULT 'OFFLINE',
  "heartbeatAt" TIMESTAMP(3),
  "pid" INTEGER,
  "hostname" TEXT,
  "assignedAccountId" TEXT,
  "assignedAccountEmail" TEXT,
  "currentUrl" TEXT,
  "pageState" JSONB,
  "lastSuccessfulCheckAt" TIMESTAMP(3),
  "lastError" TEXT,
  "lastBlockReason" TEXT,
  "cooldownUntil" TIMESTAMP(3),
  "creationSuccessCount" INTEGER NOT NULL DEFAULT 0,
  "creationFailureCount" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkerBox_pkey" PRIMARY KEY ("boxId")
);

CREATE TABLE "AccountLease" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "boxId" TEXT NOT NULL,
  "role" "WorkerBoxRole" NOT NULL,
  "runId" TEXT,
  "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AccountLease_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccountLease_accountId_key" ON "AccountLease"("accountId");
CREATE INDEX "AccountLease_boxId_idx" ON "AccountLease"("boxId");
CREATE INDEX "AccountLease_expiresAt_idx" ON "AccountLease"("expiresAt");

ALTER TABLE "AccountLease"
  ADD CONSTRAINT "AccountLease_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "VfsAccount"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
