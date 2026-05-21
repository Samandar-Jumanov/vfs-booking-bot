import * as XLSX from 'xlsx';
import { runE2e, assert, cleanupByEmailPrefix } from './common';

runE2e('10. Profile CRUD and bulk upload', async () => {
  const prefix = 'e2e-profile-crud';
  await cleanupByEmailPrefix(prefix);
  const { prisma } = await import('../../src/config/database');
  const service = await import('../../src/modules/profiles/profiles.service');
  const { bulkImportProfiles } = await import('../../src/modules/profiles/bulkImport');

  const created = await service.createProfile({
    fullName: 'E2E Profile Crud',
    passportNumber: 'CRUD12345',
    dob: '1991-02-03',
    passportExpiry: '2031-02-03',
    nationality: 'uzbekistan',
    email: `${prefix}-${Date.now()}@e2e.local`,
    phone: '+998901111111',
    gender: 'MALE',
    priority: 'NORMAL',
  });
  const raw = await prisma.profile.findUniqueOrThrow({ where: { id: created.id } });
  assert(raw.passportNumberEnc !== 'CRUD12345', 'passport number was stored as plaintext');
  assert(raw.dobEnc !== '1991-02-03', 'DOB was stored as plaintext');

  await service.updateProfile(created.id, { fullName: 'E2E Profile Updated', passportNumber: 'CRUD67890' });
  const updated = await service.getProfileById(created.id);
  assert(updated.fullName === 'E2E Profile Updated', 'profile update did not persist');
  assert(updated.passportNumber === 'CRUD67890', 'encrypted passport update did not decrypt correctly');

  await service.deleteProfile(created.id);
  const deleted = await prisma.profile.findUniqueOrThrow({ where: { id: created.id } });
  assert(deleted.isActive === false, 'profile delete did not soft-delete');

  const workbook = XLSX.utils.book_new();
  const rows = [{
    'Full Name': 'E2E Bulk User',
    'Passport Number': 'BULK12345',
    'Date of Birth': '1992-03-04',
    'Passport Expiry': '2032-03-04',
    'Nationality': 'uzbekistan',
    'Email': `${prefix}-bulk-${Date.now()}@e2e.local`,
    'Phone': '+998902222222',
    'VFS Password': 'E2ePassw0rd!',
    'Priority': 'NORMAL',
  }];
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Profiles');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const importResult = await bulkImportProfiles(buffer);
  assert(importResult.length === 1 && importResult[0].success, `bulk import failed: ${JSON.stringify(importResult)}`);
  await cleanupByEmailPrefix(prefix);
});
