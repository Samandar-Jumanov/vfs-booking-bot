import { createProfileSchema, updateProfileSchema, paginationSchema } from './profiles.schema';

const validProfile = {
  fullName: 'Oneeb Arif',
  passportNumber: 'AA1234567',
  dob: '1990-01-15',
  passportExpiry: '2030-01-15',
  nationality: 'AO',
  email: 'oneeb@example.com',
  phone: '+244923456789',
};

describe('createProfileSchema', () => {
  it('accepts a minimal valid profile and applies defaults', () => {
    const parsed = createProfileSchema.parse(validProfile);
    expect(parsed.priority).toBe('NORMAL');
    expect(parsed.gender).toBe('MALE');
  });

  it('accepts ISO datetimes with offset for date fields', () => {
    const parsed = createProfileSchema.parse({
      ...validProfile,
      dob: '1990-01-15T00:00:00+00:00',
    });
    expect(parsed.dob).toContain('1990-01-15');
  });

  it('rejects an invalid email', () => {
    expect(() => createProfileSchema.parse({ ...validProfile, email: 'not-an-email' })).toThrow();
  });

  it('rejects a too-short passport number', () => {
    expect(() => createProfileSchema.parse({ ...validProfile, passportNumber: 'AB1' })).toThrow();
  });

  it('rejects a malformed date string', () => {
    expect(() => createProfileSchema.parse({ ...validProfile, dob: '15/01/1990' })).toThrow();
  });

  it('rejects an unknown priority', () => {
    expect(() =>
      createProfileSchema.parse({ ...validProfile, priority: 'URGENT' as never })
    ).toThrow();
  });
});

describe('updateProfileSchema', () => {
  it('allows a partial payload', () => {
    const parsed = updateProfileSchema.parse({ phone: '+244999999999' });
    expect(parsed.phone).toBe('+244999999999');
  });
});

describe('paginationSchema', () => {
  it('coerces a string limit and applies the default', () => {
    const parsed = paginationSchema.parse({ limit: '50' });
    expect(parsed.limit).toBe(50);
  });

  it('uses the default limit when none is provided', () => {
    expect(paginationSchema.parse({}).limit).toBe(20);
  });

  it('rejects a limit above the cap', () => {
    expect(() => paginationSchema.parse({ limit: 500 })).toThrow();
  });
});
