import axios from 'axios';
import type { SmsProvider } from './vaksms.service';

const ONLINESIM_BASE_URL = 'https://onlinesim.io/api';
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 3 * 60 * 1_000;

type GetNumResponse = {
  response: string | number;
  tzid?: number;
  number?: string;
};

type GetStateNumber = {
  response: string | number;
  tzid: number;
  service: string;
  number: string;
  msg?: string;
};

type SetOperationOkResponse = {
  response: string | number;
};

class OnlineSimService implements SmsProvider {
  private get apiKey(): string {
    const key = process.env.ONLINESIM_API_KEY;
    if (!key) {
      throw new Error('ONLINESIM_API_KEY is not configured in environment variables');
    }
    return key;
  }

  async buyNumber(service: string, countryCode: string): Promise<{ id: string; number: string }> {
    const country = this.mapCountry(countryCode);
    const response = await axios.get<GetNumResponse>(`${ONLINESIM_BASE_URL}/getNum.php`, {
      params: {
        apikey: this.apiKey,
        service,
        country,
      },
    });

    this.assertOk('OnlineSIM getNum', response.data?.response);
    const tzid = response.data?.tzid;
    if (!tzid) {
      throw new Error(`OnlineSIM getNum missing tzid: ${JSON.stringify(response.data)}`);
    }

    const number = await this.resolveNumber(tzid);
    return { id: String(tzid), number };
  }

  async getOtp(id: string, timeoutMs = POLL_TIMEOUT_MS): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const response = await axios.get<GetStateNumber[] | { response: string | number }>(
        `${ONLINESIM_BASE_URL}/getState.php`,
        {
          params: {
            apikey: this.apiKey,
            tzid: id,
            message_to_code: 1,
          },
        },
      );

      const data = response.data;
      if (Array.isArray(data) && data.length > 0) {
        const entry = data[0];
        if (entry.msg && entry.msg.trim().length > 0) {
          return String(entry.msg);
        }
      } else if (!Array.isArray(data) && data?.response) {
        this.assertOk('OnlineSIM getState', data.response);
      }

      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    return null;
  }

  async releaseNumber(id: string): Promise<void> {
    await axios.get<SetOperationOkResponse>(`${ONLINESIM_BASE_URL}/setOperationOk.php`, {
      params: {
        apikey: this.apiKey,
        tzid: id,
      },
    });
  }

  private async resolveNumber(tzid: number): Promise<string> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const response = await axios.get<GetStateNumber[]>(`${ONLINESIM_BASE_URL}/getState.php`, {
        params: { apikey: this.apiKey, tzid },
      });
      const data = response.data;
      if (Array.isArray(data) && data.length > 0 && data[0].number) {
        return String(data[0].number);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(`OnlineSIM failed to resolve number for tzid ${tzid}`);
  }

  private mapCountry(countryCode: string): string {
    const normalized = (countryCode || '').toLowerCase();
    if (normalized === 'uz' || normalized === 'uzb' || normalized === 'uzbekistan') {
      return '998';
    }
    return normalized;
  }

  private assertOk(prefix: string, response: string | number | undefined): void {
    if (response === undefined) return;
    const value = String(response);
    if (value === '1' || value.toUpperCase() === 'TZ_NUM_PREPARE' || value.toUpperCase() === 'TZ_NUM_WAIT') {
      return;
    }
    if (/^\d+$/.test(value)) return;
    throw new Error(`${prefix} failed: ${value}`);
  }
}

export const onlinesimService: SmsProvider = new OnlineSimService();
