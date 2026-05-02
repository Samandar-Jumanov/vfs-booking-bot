import { prisma } from '@config/database';
import { encrypt, decrypt } from '@utils/crypto';
import { AppError } from '@middleware/errorHandler';
import { ProxyConfig } from '@t/index';
import { ProxyStatus } from '@prisma/client';

let roundRobinIndex = 0;

export async function getProxy(_destination?: string): Promise<ProxyConfig | null> {
  const proxies = await prisma.proxy.findMany({
    where: { status: ProxyStatus.ACTIVE },
    orderBy: { lastUsedAt: 'asc' },
  });

  if (proxies.length === 0) return null;

  // Round-robin selection
  const proxy = proxies[roundRobinIndex % proxies.length];
  roundRobinIndex = (roundRobinIndex + 1) % proxies.length;

  await prisma.proxy.update({
    where: { id: proxy.id },
    data: { lastUsedAt: new Date() },
  });

  return {
    id: proxy.id,
    server: `${proxy.host}:${proxy.port}`,
    username: proxy.username,
    password: decrypt(proxy.passwordEnc),
  };
}

export async function reportBlock(proxyId: string): Promise<void> {
  const proxy = await prisma.proxy.findUnique({ where: { id: proxyId } });
  if (!proxy) return;

  const newBlockCount = proxy.blockCount + 1;
  const newStatus = newBlockCount >= 3 ? ProxyStatus.BLOCKED : proxy.status;

  await prisma.proxy.update({
    where: { id: proxyId },
    data: {
      blockCount: newBlockCount,
      lastBlockedAt: new Date(),
      status: newStatus,
    },
  });
}

export async function addProxy(data: {
  host: string;
  port: number;
  username: string;
  password: string;
  provider: string;
  country?: string;
}) {
  return prisma.proxy.create({
    data: {
      host: data.host,
      port: data.port,
      username: data.username,
      passwordEnc: encrypt(data.password),
      provider: data.provider,
      country: data.country ?? 'AO',
    },
    select: { id: true, host: true, port: true, provider: true, status: true, country: true },
  });
}

export async function listProxies() {
  const proxies = await prisma.proxy.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, host: true, port: true, username: true,
      provider: true, country: true, status: true,
      blockCount: true, lastUsedAt: true, lastBlockedAt: true,
    },
  });
  // Mask host in list view
  return proxies.map((p) => ({
    ...p,
    hostMasked: `${p.host.split('.').slice(0, 2).join('.')}.*.*`,
  }));
}

export async function resetProxy(id: string) {
  const proxy = await prisma.proxy.findUnique({ where: { id } });
  if (!proxy) throw new AppError(404, 'Proxy not found', 'NOT_FOUND');

  return prisma.proxy.update({
    where: { id },
    data: { status: ProxyStatus.ACTIVE, blockCount: 0, lastBlockedAt: null },
  });
}

export async function deleteProxy(id: string) {
  return prisma.proxy.delete({ where: { id } });
}
