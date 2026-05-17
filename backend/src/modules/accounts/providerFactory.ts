import { customDomainService } from '@modules/email/customDomain.service';
import { mailsacService } from '@modules/email/mailsac.service';
import { smsActivateService } from '@modules/phone/smsActivate.service';
import { vaksmsService } from '@modules/phone/vaksms.service';

export function getSmsProvider() {
  const provider = (process.env.SMS_PROVIDER || 'smsactivate').toLowerCase();
  if (provider === 'vaksms') return vaksmsService;
  return smsActivateService;
}

export function getEmailProvider() {
  const provider = (process.env.EMAIL_PROVIDER || 'mailsac').toLowerCase();
  if (provider === 'custom') return customDomainService;
  return mailsacService;
}
