import { listWebAutomations } from '@/lib/server/queries';

export const dynamic = 'force-dynamic';

export default async function AutomationsPage() {
  const automations = await listWebAutomations();

  return (
    <section className="grid">
      <article className="panel">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">Automation jobs</h2>
            <p className="panel-subtitle">第一版先做只读调度面，后面再加运行、暂停、恢复这些写操作。</p>
          </div>
        </div>
        <div className="panel-body">
          {automations.length === 0 ? (
            <div className="empty">当前没有 automation job。</div>
          ) : (
            <div className="stack">
              {automations.map((automation) => (
                <article className="session-card" key={automation.id}>
                  <div className="pill-row">
                    <span className="pill"><strong>Status</strong>{automation.status}</span>
                    <span className="pill"><strong>Schedule</strong>{automation.scheduleLabel}</span>
                    <span className="pill"><strong>Provider</strong>{automation.providerProfileId}</span>
                    {automation.running ? <span className="pill"><strong>运行中</strong>是</span> : null}
                  </div>
                  <h3>{automation.title}</h3>
                  <p>Bridge Session：{automation.bridgeSessionId}</p>
                  <p>下次运行：{automation.nextRunAtLabel}</p>
                  <p>上次运行：{automation.lastRunAtLabel} · 上次送达：{automation.lastDeliveredAtLabel}</p>
                  {automation.lastError ? (
                    <p>最近错误：{automation.lastError}</p>
                  ) : (
                    <p>{automation.lastResultPreview ?? '暂无运行结果预览。'}</p>
                  )}
                  <p>
                    <a className="link-muted" href={`/sessions/${automation.bridgeSessionId}`}>
                      查看关联会话
                    </a>
                  </p>
                </article>
              ))}
            </div>
          )}
        </div>
      </article>
    </section>
  );
}
