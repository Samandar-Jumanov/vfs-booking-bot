-- CreateEnum
CREATE TYPE "VendorKind" AS ENUM ('SMS', 'EMAIL', 'CAPTCHA', 'PROXY', 'OTHER');

-- CreateTable
CREATE TABLE "vendor_spend" (
    "id" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "kind" "VendorKind" NOT NULL,
    "action" TEXT NOT NULL,
    "costMicroUsd" INTEGER NOT NULL,
    "externalRef" TEXT,
    "profileId" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_spend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vendor_spend_vendor_idx" ON "vendor_spend"("vendor");

-- CreateIndex
CREATE INDEX "vendor_spend_profileId_idx" ON "vendor_spend"("profileId");

-- CreateIndex
CREATE INDEX "vendor_spend_createdAt_idx" ON "vendor_spend"("createdAt");
