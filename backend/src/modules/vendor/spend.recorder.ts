import { PrismaClient, VendorKind } from '@prisma/client';
import { logger } from '@modules/logs/logger';

const prisma = new PrismaClient();

export interface RecordSpendInput {
  vendor: string;
  kind: VendorKind;
  action: string;
  costUsd: number; // dollars; we convert to micro-USD internally
  externalRef?: string;
  profileId?: string;
  meta?: Record<string, unknown>;
}

export async function recordSpend(input: RecordSpendInput): Promise<void> {
  const costMicroUsd = Math.round(input.costUsd * 1_000_000);
  try {
    await prisma.vendorSpend.create({
      data: {
        vendor: input.vendor,
        kind: input.kind,
        action: input.action,
        costMicroUsd,
        externalRef: input.externalRef,
        profileId: input.profileId,
        meta: input.meta as never,
      },
    });
  } catch (err) {
    // Never let analytics failure break booking. Just log it.
    logger.warn(`vendor spend recorder failed: ${(err as Error).message} ${JSON.stringify(input)}`);
  }
}
