import nodemailer from 'nodemailer';
import { env } from '@config/env';

function createTransporter() {
  return nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
}

export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  if (!env.SMTP_HOST || !env.SMTP_USER) return;

  const transporter = createTransporter();
  await transporter.sendMail({ from: env.SMTP_FROM, to, subject, html });
}
