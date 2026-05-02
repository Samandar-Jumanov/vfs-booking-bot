import fs from 'fs/promises';
import path from 'path';
import { BrowserContext } from 'playwright';
import { env } from '@config/env';

function getSessionPath(profileId: string): string {
  return path.join(env.SESSION_DIR, `${profileId}.json`);
}

export async function loadSession(profileId: string): Promise<string | null> {
  try {
    const data = await fs.readFile(getSessionPath(profileId), 'utf-8');
    return data;
  } catch {
    return null;
  }
}

export async function saveSession(profileId: string, context: BrowserContext): Promise<void> {
  try {
    await fs.mkdir(env.SESSION_DIR, { recursive: true });
    const cookies = await context.cookies();
    await fs.writeFile(getSessionPath(profileId), JSON.stringify(cookies), 'utf-8');
  } catch {
    // Non-fatal — just log
    console.warn(`Failed to save session for profile ${profileId}`);
  }
}

export async function clearSession(profileId: string): Promise<void> {
  try {
    await fs.unlink(getSessionPath(profileId));
  } catch {
    // File may not exist
  }
}

/** Returns true if the current page URL indicates the session has expired */
export function isSessionExpired(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.includes('/login') || lower.includes('/signin') || lower.includes('session-expired');
}
