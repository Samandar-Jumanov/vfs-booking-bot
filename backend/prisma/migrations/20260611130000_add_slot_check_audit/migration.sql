CREATE TABLE "SlotCheckAudit" (
  "id" TEXT NOT NULL,
  "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "boxId" TEXT,
  "accountId" TEXT,
  "accountEmail" TEXT,
  "role" "WorkerBoxRole",
  "runId" TEXT,
  "source" TEXT NOT NULL DEFAULT 'worker',
  "route" TEXT,
  "countryCode" TEXT,
  "missionCode" TEXT,
  "vacCode" TEXT,
  "visaCategoryCode" TEXT,
  "subcategoryName" TEXT,
  "httpStatus" INTEGER,
  "errorCode" TEXT,
  "result" TEXT NOT NULL,
  "earliestDate" TEXT,
  "slotCount" INTEGER,
  "durationMs" INTEGER,
  "rawSummary" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SlotCheckAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SlotCheckAudit_checkedAt_idx" ON "SlotCheckAudit"("checkedAt");
CREATE INDEX "SlotCheckAudit_boxId_checkedAt_idx" ON "SlotCheckAudit"("boxId", "checkedAt");
CREATE INDEX "SlotCheckAudit_result_checkedAt_idx" ON "SlotCheckAudit"("result", "checkedAt");
CREATE INDEX "SlotCheckAudit_visaCategoryCode_checkedAt_idx" ON "SlotCheckAudit"("visaCategoryCode", "checkedAt");
