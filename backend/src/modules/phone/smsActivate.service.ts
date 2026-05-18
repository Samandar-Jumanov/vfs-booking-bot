import axios from 'axios';
import { env } from '@config/env';

const SMS_ACTIVATE_BASE_URL = 'https://api.sms-activate.org/stubs/handler_api.php';

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 3 * 60 * 1_000; // 3 minutes

export class SmsActivateService {
  private get apiKey(): string {
    if (!env.SMS_ACTIVATE_API_KEY) {
      throw new Error('SMS_ACTIVATE_API_KEY is not configured in environment variables');
    }
    return env.SMS_ACTIVATE_API_KEY;
  }

  async buyNumber(service: string, country: string): Promise<{ id: string; number: string }> {
    const response = await axios.get<string>(SMS_ACTIVATE_BASE_URL, {
      params: {
        api_key: this.apiKey,
        action: 'getNumber',
        service,
        country,
      },
      responseType: 'text',
    });

    const body = String(response.data).trim();

    if (body.startsWith('NO_') || !body.startsWith('ACCESS_NUMBER')) {
      throw new Error(`SMS-Activate getNumber failed: ${body}`);
    }

    // Expected format: "ACCESS_NUMBER:<id>:<phone_number>"
    const parts = body.split(':');
    if (parts.length !== 3) {
      throw new Error(`SMS-Activate getNumber returned unexpected format: ${body}`);
    }

    const [, id, number] = parts;
    return { id, number };
  }

  async getOtp(activationId: string): Promise<string> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const response = await axios.get<string>(SMS_ACTIVATE_BASE_URL, {
        params: {
          api_key: this.apiKey,
          action: 'getStatus',
          id: activationId,
        },
        responseType: 'text',
      });

      const body = String(response.data).trim();

      if (body.startsWith('STATUS_OK:')) {
        const code = body.slice('STATUS_OK:'.length);
        if (!code) {
          throw new Error('SMS-Activate returned STATUS_OK but OTP code is empty');
        }
        return code;
      }

      if (body === 'STATUS_WAIT_CODE') {
        await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        continue;
      }

      // STATUS_CANCEL or any unrecognised response
      throw new Error(`SMS-Activate getStatus failed: ${body}`);
    }

    throw new Error(
      `SMS-Activate getOtp timed out after ${POLL_TIMEOUT_MS / 1_000}s for activation ID ${activationId}`,
    );
  }

  async releaseNumber(activationId: string): Promise<void> {
    const response = await axios.get<string>(SMS_ACTIVATE_BASE_URL, {
      params: {
        api_key: this.apiKey,
        action: 'setStatus',
        id: activationId,
        status: 8, // 8 = cancel activation
      },
      responseType: 'text',
    });

    const body = String(response.data).trim();

    // Treat any response starting with "ACCESS_" or "SUCCESS" as success.
    // The API typically returns "ACCESS_CANCEL" on a successful cancel.
    if (body.startsWith('NO_') || body.startsWith('ERROR')) {
      throw new Error(`SMS-Activate releaseNumber failed: ${body}`);
    }
  }
}

export const smsActivateService = new SmsActivateService();
