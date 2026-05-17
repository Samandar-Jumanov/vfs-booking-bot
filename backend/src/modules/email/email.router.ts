import { Router, Request, Response } from 'express';
import { prisma } from '@config/database';

export const emailRouter = Router();

// PUBLIC (no auth) - webhook receiver. Forwarding services post here.
// Body shape: Mailgun-style { recipient, sender, subject, 'body-plain', 'body-html', ... }
// Or generic { to, from, subject, body }.
emailRouter.post('/webhook', async (req: Request, res: Response) => {
  const body = req.body || {};
  const to = String(body.to ?? body.recipient ?? '').toLowerCase();
  const from = String(body.from ?? body.sender ?? '');
  const subject = String(body.subject ?? '');
  const text = String(body.body ?? body['body-plain'] ?? body['body-html'] ?? '');

  if (!to) return res.status(400).json({ error: 'missing recipient' });

  const secret = process.env.EMAIL_WEBHOOK_SECRET;
  if (secret && req.headers['x-webhook-secret'] !== secret) {
    return res.status(401).json({ error: 'invalid secret' });
  }

  await prisma.receivedEmail.create({
    data: {
      toAddress: to,
      fromAddress: from,
      subject,
      body: text,
      rawHeaders: req.headers,
    },
  });

  res.json({ ok: true });
});
