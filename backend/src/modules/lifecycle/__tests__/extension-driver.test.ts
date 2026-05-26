import { ExtensionDriver, mapReasonToCode } from '../extension-driver';

describe('mapReasonToCode', () => {
  it('maps empty string → UNKNOWN', () => expect(mapReasonToCode('')).toBe('UNKNOWN'));
  it('maps reason with 429001 → 429001', () => expect(mapReasonToCode('429001')).toBe('429001'));
  it('maps reason with 429202 → 429202', () => expect(mapReasonToCode('429202')).toBe('429202'));
  it('maps TURNSTILE → TURNSTILE_FAILED', () => expect(mapReasonToCode('TURNSTILE_FAILED')).toBe('TURNSTILE_FAILED'));
  it('maps OPERATOR_EXTENSION_OFFLINE → OPERATOR_OFFLINE', () => expect(mapReasonToCode('OPERATOR_EXTENSION_OFFLINE')).toBe('OPERATOR_OFFLINE'));
  it('maps LOGIN_TIMEOUT → TIMEOUT', () => expect(mapReasonToCode('LOGIN_TIMEOUT')).toBe('TIMEOUT'));
  it('maps NO_WARM_TAB → NO_WARM_TAB', () => expect(mapReasonToCode('NO_WARM_TAB')).toBe('NO_WARM_TAB'));
  it('maps INVALID_CREDS → INVALID_CREDS', () => expect(mapReasonToCode('INVALID_CREDS')).toBe('INVALID_CREDS'));
});

describe('ExtensionDriver', () => {
  function makeDriver(overrides: Partial<ConstructorParameters<typeof ExtensionDriver>[0]> = {}) {
    return new ExtensionDriver({
      loginAccount: jest.fn().mockResolvedValue({ success: true, accountId: 'id', email: 'e@e.com' }),
      logoutAccount: jest.fn().mockResolvedValue({ success: true }),
      bookAccount: jest.fn().mockResolvedValue({ success: true, confirmationNumber: 'CNF123' }),
      isOperatorLive: jest.fn().mockReturnValue(true),
      ...overrides,
    });
  }

  it('login OK → DriverResult ok=true code=OK', async () => {
    const driver = makeDriver();
    const r = await driver.login({ email: 'acc-id', password: '' });
    expect(r.ok).toBe(true);
    expect(r.code).toBe('OK');
  });

  it('login when operator offline → OPERATOR_OFFLINE without calling loginAccount', async () => {
    const loginAccount = jest.fn();
    const driver = makeDriver({ isOperatorLive: jest.fn().mockReturnValue(false), loginAccount });
    const r = await driver.login({ email: 'acc-id', password: '' });
    expect(r.code).toBe('OPERATOR_OFFLINE');
    expect(loginAccount).not.toHaveBeenCalled();
  });

  it('login 429001 → code 429001', async () => {
    const driver = makeDriver({
      loginAccount: jest.fn().mockResolvedValue({ success: false, reason: '429001', accountId: 'id', email: 'e' }),
    });
    const r = await driver.login({ email: 'acc-id', password: '' });
    expect(r.code).toBe('429001');
  });

  it('login 429202 → code 429202', async () => {
    const driver = makeDriver({
      loginAccount: jest.fn().mockResolvedValue({ success: false, reason: '429202', accountId: 'id', email: 'e' }),
    });
    const r = await driver.login({ email: 'acc-id', password: '' });
    expect(r.code).toBe('429202');
  });

  it('login TURNSTILE_FAILED → code TURNSTILE_FAILED', async () => {
    const driver = makeDriver({
      loginAccount: jest.fn().mockResolvedValue({ success: false, reason: 'TURNSTILE_FAILED', accountId: 'id', email: 'e' }),
    });
    const r = await driver.login({ email: 'acc-id', password: '' });
    expect(r.code).toBe('TURNSTILE_FAILED');
  });

  it('login LOGIN_TIMEOUT → code TIMEOUT', async () => {
    const driver = makeDriver({
      loginAccount: jest.fn().mockResolvedValue({ success: false, reason: 'LOGIN_TIMEOUT', accountId: 'id', email: 'e' }),
    });
    const r = await driver.login({ email: 'acc-id', password: '' });
    expect(r.code).toBe('TIMEOUT');
  });

  it('logout OK → code OK', async () => {
    const driver = makeDriver();
    const r = await driver.logout({ email: '' });
    expect(r.ok).toBe(true);
    expect(r.code).toBe('OK');
  });

  it('book OK → code OK + confirmationNumber in data', async () => {
    const driver = makeDriver();
    const r = await driver.book({
      accountEmail: 'e@e.com', firstName: 'A', lastName: 'B',
      passportNumber: 'P1', dob: '1990-01-01', nationality: 'UZ',
      email: 'cust@e.com', phone: '+1', subCategory: 'D-visa',
    });
    expect(r.ok).toBe(true);
    expect(r.data?.confirmationNumber).toBe('CNF123');
  });

  it('isReady returns true when operator live', async () => {
    expect(await makeDriver().isReady()).toBe(true);
  });

  it('isReady returns false when operator offline', async () => {
    expect(await makeDriver({ isOperatorLive: jest.fn().mockReturnValue(false) }).isReady()).toBe(false);
  });
});
