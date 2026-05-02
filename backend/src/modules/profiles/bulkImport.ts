import * as XLSX from 'xlsx';
import { createProfile } from './profiles.service';
import { createProfileSchema } from './profiles.schema';

interface ImportResult {
  row: number;
  success: boolean;
  profileId?: string;
  error?: string;
}

const EXPECTED_COLUMNS: Record<string, string> = {
  'Full Name': 'fullName',
  'Passport Number': 'passportNumber',
  'Date of Birth': 'dob',
  'Passport Expiry': 'passportExpiry',
  'Nationality': 'nationality',
  'Email': 'email',
  'Phone': 'phone',
  'VFS Password': 'vfsPassword',
  'Priority': 'priority',
};

function normalizeDate(value: unknown): string {
  if (!value) return '';
  // Excel serial number
  if (typeof value === 'number') {
    const date = XLSX.SSF.parse_date_code(value);
    return `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
  }
  return String(value);
}

export async function bulkImportProfiles(fileBuffer: Buffer): Promise<ImportResult[]> {
  const workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: false });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { raw: true });

  const results: ImportResult[] = [];

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2; // 1-indexed, skip header
    const raw = rows[i];

    // Map columns
    const mapped: Record<string, unknown> = {};
    for (const [col, field] of Object.entries(EXPECTED_COLUMNS)) {
      const val = raw[col];
      if (field === 'dob' || field === 'passportExpiry') {
        mapped[field] = normalizeDate(val);
      } else if (field === 'priority') {
        const p = val ? String(val).trim().toUpperCase() : '';
        mapped[field] = p === 'HIGH' ? 'HIGH' : 'NORMAL';
      } else {
        mapped[field] = val ? String(val).trim() : '';
      }
    }

    // Validate
    const parsed = createProfileSchema.safeParse(mapped);
    if (!parsed.success) {
      results.push({
        row: rowNum,
        success: false,
        error: parsed.error.issues.map((i) => `${i.path}: ${i.message}`).join('; '),
      });
      continue;
    }

    try {
      const profile = await createProfile(parsed.data);
      results.push({ row: rowNum, success: true, profileId: profile.id });
    } catch (err) {
      results.push({
        row: rowNum,
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  return results;
}
