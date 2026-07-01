import { NextResponse } from 'next/server';
import { getWebAuthConfig } from '@/lib/server/auth';

function redirectTo(request: Request, location: string, status = 303) {
  const normalizedLocation = location.startsWith('/') ? location : `/${location}`;
  return new NextResponse(null, {
    status,
    headers: {
      Location: normalizedLocation,
    },
  });
}

export async function POST(request: Request) {
  const config = getWebAuthConfig();
  const response = redirectTo(request, '/login');
  response.cookies.set(config.cookieName, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookie,
    maxAge: 0,
    path: '/',
  });
  return response;
}
