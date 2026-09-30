'use client';

import { usePathname } from 'next/navigation';

function isActive(pathname: string, href: string): boolean {
  if (href === '/sessions') {
    return pathname === '/' || pathname.startsWith('/sessions');
  }
  return pathname.startsWith(href);
}

export function PrimaryNav() {
  const pathname = usePathname();
  return (
    <nav className="nav" aria-label="Primary">
      <a className={isActive(pathname, '/sessions') ? 'active' : ''} href="/sessions">聊天</a>
      <a className={isActive(pathname, '/automations') ? 'active' : ''} href="/automations">自动化</a>
      <a className={isActive(pathname, '/runtime') ? 'active' : ''} href="/runtime">设置</a>
    </nav>
  );
}
