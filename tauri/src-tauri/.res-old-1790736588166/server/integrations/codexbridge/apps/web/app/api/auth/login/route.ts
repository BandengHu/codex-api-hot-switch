import { NextResponse } from 'next/server';
import {
  createAuthSessionToken,
  getWebAuthConfig,
  verifyWebCredentials,
} from '@/lib/server/auth';

function wantsJson(request: Request) {
  const accept = request.headers.get('accept') ?? '';
  return accept.includes('application/json');
}

function redirectTo(location: string, status = 303) {
  const normalizedLocation = location.startsWith('/') ? location : `/${location}`;
  return new NextResponse(null, {
    status,
    headers: {
      Location: normalizedLocation,
    },
  });
}

export async function POST(request: Request) {
  const contentType = request.headers.get('content-type') ?? '';
  let username = '';
  let password = '';

  if (contentType.includes('application/json')) {
    const body = await request.json().catch(() => null) as
      | { username?: unknown; password?: unknown }
      | null;
    username = String(body?.username ?? '').trim();
    password = String(body?.password ?? '');
  } else {
    const formData = await request.formData();
    username = String(formData.get('username') ?? '').trim();
    password = String(formData.get('password') ?? '');
  }

  const config = getWebAuthConfig();

  if (!config.enabled || !config.username || !config.password) {
    if (wantsJson(request)) {
      return NextResponse.json({ ok: false, error: 'config' }, { status: 503 });
    }
    return redirectTo('/login?error=config');
  }

  const isValid = await verifyWebCredentials(username, password);
  if (!isValid) {
    if (wantsJson(request)) {
      return NextResponse.json({ ok: false, error: 'invalid' }, { status: 401 });
    }
    return redirectTo('/login?error=invalid');
  }

  const token = await createAuthSessionToken(config.username, config.password);
  const response = wantsJson(request)
    ? NextResponse.json({ ok: true })
    : redirectTo('/sessions');
  response.cookies.set(config.cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookie,
    maxAge: config.maxAgeSeconds,
    path: '/',
  });
  return response;
}
