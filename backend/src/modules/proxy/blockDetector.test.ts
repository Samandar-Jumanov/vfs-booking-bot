import { detectBlockFromPage, detectBlockFromResponse } from './blockDetector';

describe('blockDetector', () => {
  it('classifies 429001 response URLs as account_flag', () => {
    const response = {
      status: () => 429,
      url: () => 'https://visa.vfsglobal.com/error?code=429001',
    };

    expect(detectBlockFromResponse(response as never)).toEqual({ type: 'account_flag' });
  });

  it('keeps generic 429 responses as rate_limit', () => {
    const response = {
      status: () => 429,
      url: () => 'https://visa.vfsglobal.com/rate-limit',
    };

    expect(detectBlockFromResponse(response as never)).toEqual({ type: 'rate_limit' });
  });

  it('classifies 429001 page text as account_flag', async () => {
    const page = {
      url: () => 'https://visa.vfsglobal.com/dashboard',
      evaluate: jest.fn().mockResolvedValue('Request failed with 429001'),
    };

    await expect(detectBlockFromPage(page as never)).resolves.toEqual({ type: 'account_flag' });
  });

  it('classifies account locked page text as account_flag', async () => {
    const page = {
      url: () => 'https://visa.vfsglobal.com/dashboard',
      evaluate: jest.fn().mockResolvedValue('Your account locked temporarily.'),
    };

    await expect(detectBlockFromPage(page as never)).resolves.toEqual({ type: 'account_flag' });
  });

  it('keeps plain too many requests page text as rate_limit', async () => {
    const page = {
      url: () => 'https://visa.vfsglobal.com/dashboard',
      evaluate: jest.fn().mockResolvedValue('Too many requests'),
    };

    await expect(detectBlockFromPage(page as never)).resolves.toEqual({ type: 'rate_limit' });
  });
});

