/** Verifies fetchEmailVerificationLink returns the FULL activation link (not the
 *  truncated token). Run: TARGET_EMAIL=x@mailsac.com railway run --service backend npx tsx scripts/test-extract-link.ts */
import { fetchEmailVerificationLink } from '../src/modules/accounts/accountAutoRegister.service';

async function main(): Promise<void> {
  const email = process.env.TARGET_EMAIL || 'vfs-51626811fe65@mailsac.com';
  console.log('extracting link for', email, '...');
  const link = await fetchEmailVerificationLink(email);
  if (!link) { console.log('NO LINK FOUND'); return; }
  console.log('length:', link.length);
  console.log('ends with "==":', link.trimEnd().endsWith('=='));
  console.log('has whitespace inside:', /\s/.test(link));
  console.log('FULL LINK:\n' + link);
}
main().then(() => process.exit(0)).catch((e) => { console.error('crashed:', e?.message); process.exit(1); });
