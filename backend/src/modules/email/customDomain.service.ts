import { randomBytes } from 'crypto';
import { prisma } from '@config/database';

export const customDomainService = {
  createInbox: async (prefix?: string): Promise<string> => {
    const base = process.env.CUSTOM_EMAIL_DOMAIN;
    if (!base) throw new Error('CUSTOM_EMAIL_DOMAIN not set');
    const local = prefix ?? `vfs-${randomBytes(4).toString('hex')}`;
    return `${local}@${base}`;
  },

  listInbox: async (email: string) => {
    return prisma.receivedEmail.findMany({
      where: { toAddress: email.toLowerCase() },
      orderBy: { receivedAt: 'desc' },
    });
  },
};
