import webPush from 'web-push';
import { env } from '@config/env';
import { prisma } from '@config/database';

if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
  webPush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
}

export async function sendPushToAll(payload: object): Promise<void> {
  if (!env.VAPID_PUBLIC_KEY) return;

  const subscriptions = await prisma.pushSubscription.findMany();
  const message = JSON.stringify(payload);

  await Promise.allSettled(
    subscriptions.map((sub) =>
      webPush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        message
      )
    )
  );
}
