import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/login-form';
import { getWebAuthConfig, isAuthenticatedCookie } from '@/lib/server/auth';

export const dynamic = 'force-dynamic';

function resolveErrorMessage(error: string | undefined) {
  if (error === 'invalid') {
    return '账号或密码错误。';
  }
  if (error === 'config') {
    return '服务端还没有配置 Web 登录账号密码。';
  }
  return null;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const config = getWebAuthConfig();
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(config.cookieName)?.value;
  const authenticated = await isAuthenticatedCookie(sessionCookie);

  if (authenticated) {
    redirect('/sessions');
  }

  const errorValue = params.error;
  const error = Array.isArray(errorValue) ? errorValue[0] : errorValue;
  const errorMessage = resolveErrorMessage(error);

  return (
    <section className="auth-shell">
      <article className="auth-card">
        <div className="auth-copy">
          <h1>登录 CodexBridge Web Console</h1>
          <p>当前 Web 控制台已开启账号密码保护，外网访问必须先登录。</p>
        </div>

        {!config.enabled ? (
          <div className="auth-alert auth-alert-danger">
            <strong>未完成配置</strong>
            <p>请先在服务端设置 `CODEXBRIDGE_WEB_USERNAME` 和 `CODEXBRIDGE_WEB_PASSWORD`。</p>
          </div>
        ) : null}

        {errorMessage ? (
          <div className="auth-alert auth-alert-danger">
            <strong>登录失败</strong>
            <p>{errorMessage}</p>
          </div>
        ) : null}

        <LoginForm disabled={!config.enabled} />

        <div className="auth-hint">
          <p>服务监听：`0.0.0.0:58888`</p>
          <p>浏览器访问时不要使用 `0.0.0.0`，请改用服务器公网 IP 或域名。</p>
          <p>如果你要直接暴露到公网，建议再配反向代理和 HTTPS。</p>
        </div>
      </article>
    </section>
  );
}
