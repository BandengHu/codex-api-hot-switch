'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

type LoginFormProps = {
  disabled: boolean;
};

function resolveClientError(error: string | null) {
  if (error === 'invalid') {
    return '账号或密码错误。';
  }
  if (error === 'config') {
    return '服务端还没有配置 Web 登录账号密码。';
  }
  return '登录失败，请稍后再试。';
}

export function LoginForm({ disabled }: LoginFormProps) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const formData = new FormData(event.currentTarget);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        body: formData,
        headers: {
          Accept: 'application/json',
        },
      });

      const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !payload?.ok) {
        setError(resolveClientError(payload?.error ?? null));
        setSubmitting(false);
        return;
      }

      router.replace('/sessions');
      router.refresh();
    } catch {
      setError('登录失败，请稍后再试。');
      setSubmitting(false);
    }
  }

  return (
    <>
      {error ? (
        <div className="auth-alert auth-alert-danger">
          <strong>登录失败</strong>
          <p>{error}</p>
        </div>
      ) : null}

      <form className="auth-form" method="post" onSubmit={handleSubmit}>
        <label className="auth-field">
          <span>账号</span>
          <input autoComplete="username" name="username" placeholder="输入登录账号" type="text" />
        </label>
        <label className="auth-field">
          <span>密码</span>
          <input autoComplete="current-password" name="password" placeholder="输入登录密码" type="password" />
        </label>
        <button className="auth-button" disabled={disabled || submitting} type="submit">
          {submitting ? '登录中…' : '登录'}
        </button>
      </form>
    </>
  );
}
