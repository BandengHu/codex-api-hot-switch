import { NextRequest, NextResponse } from 'next/server';
import { getWebAuthConfig, isAuthenticatedCookie } from '@/lib/server/auth';

function redirectTo(request: NextRequest, pathname: string, status = 307, search = '') {
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const location = new URL(`${normalizedPath}${search}`, request.url);
  return NextResponse.redirect(location, status);
}

function isPublicPath(pathname: string) {
  return pathname === '/login'
    || pathname.startsWith('/api/auth/login')
    || pathname.startsWith('/_next')
    || pathname.startsWith('/icons/')
    || pathname.startsWith('/generated/')
    || pathname === '/favicon.ico';
}

function isApiPath(pathname: string) {
  return pathname.startsWith('/api/');
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const config = getWebAuthConfig();
  const sessionCookie = request.cookies.get(config.cookieName)?.value;
  const authenticated = await isAuthenticatedCookie(sessionCookie);

  if (authenticated) {
    return NextResponse.next();
  }

  if (isApiPath(pathname)) {
    return NextResponse.json(
      {
        error: config.enabled ? 'Unauthorized' : 'Web auth is not configured',
      },
      { status: 401 },
    );
  }

  if (!config.enabled) {
    return redirectTo(request, '/login', 307, '?error=config');
  }
  return redirectTo(request, '/login');
}

export const config = {
  matcher: ['/((?!_next/static|_next/image).*)'],
};
