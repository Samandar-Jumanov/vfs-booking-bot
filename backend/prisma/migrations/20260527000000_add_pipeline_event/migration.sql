-- CreateEnum
CREATE TYPE "PipelineSeverity" AS ENUM ('INFO', 'WARN', 'CRITICAL');

-- CreateTable
CREATE TABLE "pipeline_events" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "accountId" TEXT,
    "profileId" TEXT,
    "beforeState" TEXT,
    "afterState" TEXT,
    "error" TEXT,
    "url" TEXT,
    "screenshotPath" TEXT,
    "lastNetwork" TEXT,
    "severity" "PipelineSeverity" NOT NULL DEFAULT 'INFO',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pipeline_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pipeline_events_accountId_idx" ON "pipeline_events"("accountId");

-- CreateIndex
CREATE INDEX "pipeline_events_profileId_idx" ON "pipeline_events"("profileId");

-- CreateIndex
CREATE INDEX "pipeline_events_severity_idx" ON "pipeline_events"("severity");

-- CreateIndex
CREATE INDEX "pipeline_events_createdAt_idx" ON "pipeline_events"("createdAt");
