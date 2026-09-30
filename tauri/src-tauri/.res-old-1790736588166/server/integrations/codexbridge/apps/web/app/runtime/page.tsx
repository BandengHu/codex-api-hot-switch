import { getWebRuntimeStatus } from '@/lib/server/queries';

export const dynamic = 'force-dynamic';

export default async function RuntimePage() {
  const status = await getWebRuntimeStatus();

  return (
    <section className="grid">
      <article className="panel">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">Runtime status</h2>
            <p className="panel-subtitle">当前 Web console 复用的是同一套 file-json runtime，不单独重写 provider / session 内核。</p>
          </div>
        </div>
        <div className="panel-body">
          <div className="status-grid">
            <div className="status-card">
              <h3>State directory</h3>
              <p>{status.stateDir}</p>
            </div>
            <div className="status-card">
              <h3>Runtime directory</h3>
              <p>{status.runtimeDir}</p>
            </div>
            <div className="status-card">
              <h3>Repo root</h3>
              <p>{status.repoRoot}</p>
            </div>
            <div className="status-card">
              <h3>Default provider</h3>
              <p>{status.defaultProviderProfileId ?? '未配置'}</p>
            </div>
            <div className="status-card">
              <h3>Session count</h3>
              <p>{status.sessionCount}</p>
            </div>
            <div className="status-card">
              <h3>Active automations</h3>
              <p>{status.activeAutomationCount}</p>
            </div>
            <div className="status-card">
              <h3>Active assistant records</h3>
              <p>{status.activeRecordCount}</p>
            </div>
            <div className="status-card">
              <h3>Platform bindings</h3>
              <p>{status.bindingCount}</p>
            </div>
          </div>
        </div>
      </article>

      <article className="panel">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">Provider profiles</h2>
            <p className="panel-subtitle">当前已加载的 provider profile 与其绑定的会话数量。</p>
          </div>
        </div>
        <div className="panel-body">
          <div className="stack">
            {status.providers.map((provider: {
              id: string;
              displayName: string;
              providerKind: string;
              defaultModel: string | null;
              baseUrl: string | null;
              sessionCount: number;
            }) => (
              <div className="session-card" key={provider.id}>
                <div className="pill-row">
                  <span className="pill"><strong>ID</strong>{provider.id}</span>
                  <span className="pill"><strong>Kind</strong>{provider.providerKind}</span>
                  <span className="pill"><strong>Sessions</strong>{String(provider.sessionCount)}</span>
                </div>
                <h3>{provider.displayName}</h3>
                <p>默认模型：{provider.defaultModel ?? '沿用 provider 自身默认值'}</p>
                <p>Base URL：{provider.baseUrl ?? 'native / not configured'}</p>
              </div>
            ))}
          </div>
        </div>
      </article>
    </section>
  );
}
