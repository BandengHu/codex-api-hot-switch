import { notFound, redirect } from 'next/navigation';
import { getWebSessionDetail } from '@/lib/server/queries';

export const dynamic = 'force-dynamic';

export default async function SessionDetailPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const detail = await getWebSessionDetail(sessionId);

  if (!detail) {
    notFound();
  }

  if (detail.session.isCodexBacked && detail.session.codexThreadId) {
    redirect(`/sessions/codex/${detail.session.codexThreadId}`);
  }

  return (
    <section className="grid">
      <article className="panel">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">{detail.session.title}</h2>
            <p className="panel-subtitle">当前会话不是 Codex-backed，会话树暂不直接展开这类 provider。</p>
          </div>
        </div>
        <div className="panel-body">
          <div className="stack">
            <p><strong>Bridge Session：</strong>{detail.session.id}</p>
            <p><strong>Provider：</strong>{detail.session.providerDisplayName} · {detail.session.providerKind}</p>
            <p><strong>CWD：</strong>{detail.session.cwd ?? '未绑定 cwd'}</p>
            <p><strong>更新时间：</strong>{detail.session.updatedAtLabel}</p>
          </div>
        </div>
      </article>
    </section>
  );
}
