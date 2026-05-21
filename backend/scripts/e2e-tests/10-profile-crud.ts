import * as XLSX from 'xlsx';
import { runE2e, assert, cleanupByEmailPrefix, withTestServer } from './common';

runE2e('10. Profile CRUD and bulk upload', async () => {
  const prefix = 'e2e-profile-crud';
  await cleanupByEmailPrefix(prefix);
  try {
    const { prisma } = await import('../../src/config/database');
    let createdId = '';

    await withTestServer(async ({ baseUrl, authHeader }) => {
      const create = await fetch(`${baseUrl}/api/profiles`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader },
        body: JSON.stringify({
          fullName: 'E2E Profile Crud',
          passportNumber: 'CRUD12345',
          dob: '1991-02-03',
          passportExpiry: '2031-02-03',
          nationality: 'uzbekistan',
          email: `${prefix}-${Date.now()}@e2e.local`,
          phone: '+998901111111',
          gender: 'MALE',
          priority: 'NORMAL',
        }),
      });
      assert(create.status === 201, `profile create returned HTTP ${create.status}`);
      const created = await create.json() as { id?: string; fullName?: string; passportNumber?: string; passportNumberEnc?: string };
      assert(Boolean(created.id), 'profile create did not return id');
      assert(created.fullName === 'E2E Profile Crud', 'profile create returned wrong fullName');
      assert(!('passportNumber' in created), 'profile create unexpectedly returned plaintext passportNumber');
      assert(created.passportNumberEnc !== 'CRUD12345', 'profile create returned plaintext passportNumberEnc');
      createdId = created.id!;

      const raw = await prisma.profile.findUniqueOrThrow({ where: { id: createdId } });
      assert(raw.passportNumberEnc !== 'CRUD12345', 'passport number was stored as plaintext');
      assert(raw.dobEnc !== '1991-02-03', 'DOB was stored as plaintext');

      const update = await fetch(`${baseUrl}/api/profiles/${createdId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...authHeader },
        body: JSON.stringify({ fullName: 'E2E Profile Updated', passportNumber: 'CRUD67890' }),
      });
      assert(update.ok, `profile update returned HTTP ${update.status}`);
      const updated = await update.json() as { fullName?: string };
      assert(updated.fullName === 'E2E Profile Updated', 'profile update did not persist');
      const get = await fetch(`${baseUrl}/api/profiles/${createdId}`, { headers: authHeader });
      assert(get.ok, `profile get returned HTTP ${get.status}`);
      const fetched = await get.json() as { fullName?: string; passportNumber?: string };
      assert(fetched.fullName === 'E2E Profile Updated', 'profile get did not return updated name');
      assert(fetched.passportNumber === 'CRUD67890', 'encrypted passport update did not decrypt correctly');

      const remove = await fetch(`${baseUrl}/api/profiles/${createdId}`, {
        method: 'DELETE',
        headers: authHeader,
      });
      assert(remove.status === 204, `profile delete returned HTTP ${remove.status}`);
      const deleted = await prisma.profile.findUniqueOrThrow({ where: { id: createdId } });
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
      const form = new FormData();
      form.append('file', new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'profiles.xlsx');
      const upload = await fetch(`${baseUrl}/api/profiles/bulk-upload`, {
        method: 'POST',
        headers: authHeader,
        body: form,
      });
      assert(upload.ok, `profile bulk-upload returned HTTP ${upload.status}`);
      const importResult = await upload.json() as { succeeded?: number; failed?: number; results?: Array<{ success?: boolean }> };
      assert(importResult.succeeded === 1 && importResult.failed === 0, `bulk import failed: ${JSON.stringify(importResult)}`);
      assert(importResult.results?.[0]?.success === true, `bulk import result was not successful: ${JSON.stringify(importResult)}`);
    });
  } finally {
    await cleanupByEmailPrefix(prefix);
  }
});
