const SESSION_COOKIE_NAME = 'codexbridge_web_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export type WebAuthConfig = {
  enabled: boolean;
  username: string | null;
  password: string | null;
  cookieName: string;
  maxAgeSeconds: number;
  secureCookie: boolean;
};

function normalizeEnv(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function getSessionSecret(username: string, password: string) {
  return normalizeEnv(process.env.CODEXBRIDGE_WEB_SESSION_SECRET)
    ?? `${username}:${password}:codexbridge-web`;
}

async function sha256Hex(value: string) {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function getWebAuthConfig(): WebAuthConfig {
  const username = normalizeEnv(process.env.CODEXBRIDGE_WEB_USERNAME);
  const password = normalizeEnv(process.env.CODEXBRIDGE_WEB_PASSWORD);
  return {
    enabled: Boolean(username && password),
    username,
    password,
    cookieName: SESSION_COOKIE_NAME,
    maxAgeSeconds: SESSION_MAX_AGE_SECONDS,
    secureCookie: process.env.CODEXBRIDGE_WEB_COOKIE_SECURE === '1',
  };
}

export async function createAuthSessionToken(username: string, password: string) {
  const secret = getSessionSecret(username, password);
  return sha256Hex(`${username}:${password}:${secret}`);
}

export async function verifyWebCredentials(username: string, password: string) {
  const config = getWebAuthConfig();
  if (!config.enabled || !config.username || !config.password) {
    return false;
  }
  return username === config.username && password === config.password;
}

export async function isAuthenticatedCookie(cookieValue: string | null | undefined) {
  const config = getWebAuthConfig();
  if (!config.enabled || !config.username || !config.password) {
    return false;
  }
  if (!cookieValue) {
    return false;
  }
  const expected = await createAuthSessionToken(config.username, config.password);
  return cookieValue === expected;
}
