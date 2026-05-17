-- CreateTable
CREATE TABLE "received_emails" (
    "id" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "fromAddress" TEXT,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "rawHeaders" JSONB,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "received_emails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "received_emails_toAddress_idx" ON "received_emails"("toAddress");
