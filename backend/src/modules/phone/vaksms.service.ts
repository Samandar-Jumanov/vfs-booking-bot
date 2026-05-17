import axios from 'axios';

const VAKSMS_BASE_URL = 'https://vak-sms.com/api/';
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 3 * 60 * 1_000;

export interface SmsProvider {
  buyNumber(service: string, countryCode: string): Promise<{ id: string; number: string }>;
  getOtp(id: string, timeoutMs?: number): Promise<string | null>;
  releaseNumber(id: string): Promise<void>;
}

type VakSmsNumberResponse = {
  tel?: string;
  idNum?: string;
  error?: string;
};

type VakSmsCodeResponse = {
  smsCode?: string;
  error?: string;
};

type VakSmsStatusResponse = {
  error?: string;
};

const NAMED_ERRORS = new Set(['no_balance', 'no_numbers', 'wait_sms', 'bad_key']);

class VakSmsService implements SmsProvider {
  private get apiKey(): string {
    const key = process.env.VAKSMS_API_KEY;
    if (!key) {
      throw new Error('VAKSMS_API_KEY is not configured in environment variables');
    }
    return key;
  }

  async buyNumber(service: string, countryCode: string): Promise<{ id: string; number: string }> {
    const country = process.env.VAKSMS_COUNTRY || this.mapCountry(countryCode);
    const response = await axios.get<VakSmsNumberResponse>(`${VAKSMS_BASE_URL}getNumber`, {
      params: {
        apiKey: this.apiKey,
        service,
        country,
        rent: 0,
      },
    });

    const data = response.data;
    if (data.error) {
      throw this.toError('Vak-SMS getNumber', data.error);
    }
    if (!data.idNum || !data.tel) {
      throw new Error(`Vak-SMS getNumber returned unexpected response: ${JSON.stringify(data)}`);
    }

    return { id: String(data.idNum), number: String(data.tel) };
  }

  async getOtp(id: string, timeoutMs = POLL_TIMEOUT_MS): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const response = await axios.get<VakSmsCodeResponse>(`${VAKSMS_BASE_URL}getSmsCode`, {
        params: {
          apiKey: this.apiKey,
          idNum: id,
        },
      });

      const data = response.data;
      if (data.smsCode) {
        return String(data.smsCode);
      }
      if (data.error === 'wait_sms') {
        await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        continue;
      }
      if (data.error) {
        throw this.toError('Vak-SMS getSmsCode', data.error);
      }
      throw new Error(`Vak-SMS getSmsCode returned unexpected response: ${JSON.stringify(data)}`);
    }

    return null;
  }

  async releaseNumber(id: string): Promise<void> {
    const response = await axios.get<VakSmsStatusResponse>(`${VAKSMS_BASE_URL}setStatus`, {
      params: {
        apiKey: this.apiKey,
        status: 'end',
        idNum: id,
      },
    });

    const error = response.data?.error;
    if (error) {
      throw this.toError('Vak-SMS setStatus', error);
    }
  }

  private mapCountry(countryCode: string): string {
    const normalized = countryCode.toLowerCase();
    if (normalized === 'uz' || normalized === 'uzb' || normalized === 'uzbekistan') {
      return 'uz';
    }
    return normalized;
  }

  private toError(prefix: string, error: string): Error {
    if (NAMED_ERRORS.has(error)) {
      return new Error(`${prefix} failed: ${error}`);
    }
    return new Error(`${prefix} failed: ${error}`);
  }
}

export const vaksmsService: SmsProvider = new VakSmsService();
