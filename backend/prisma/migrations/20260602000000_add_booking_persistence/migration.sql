-- Add BOOKED lifecycle state + persist booking confirmation on the account.
ALTER TYPE "LifecycleStateEnum" ADD VALUE IF NOT EXISTS 'BOOKED';

ALTER TABLE "VfsAccount" ADD COLUMN IF NOT EXISTS "bookingConfirmation" TEXT;
ALTER TABLE "VfsAccount" ADD COLUMN IF NOT EXISTS "bookedAt" TIMESTAMP(3);
