import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexProviderPlugin } from '../../../src/providers/codex/plugin.js';

function makeProfile(overrides = {}) {
  return {
    id: 'openai-default',
    providerKind: 'codex',
    displayName: 'Codex OpenAI',
    config: {
      cliBin: 'codex',
      defaultModel: null,
      modelCatalog: [],
      modelCatalogMode: 'merge',
      ...overrides,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeBridgeSession(overrides = {}) {
  return {
    id: 'session-1',
    providerProfileId: 'openai-default',
    codexThreadId: 'thread-1',
    cwd: '/tmp/work',
    title: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeSessionSettings(overrides = {}) {
  return {
    bridgeSessionId: 'session-1',
    model: null,
    reasoningEffort: null,
    serviceTier: null,
    collaborationMode: null,
    personality: null,
    permissionsMode: null,
    approvalsReviewer: null,
    approvalPolicy: null,
    sandboxMode: null,
    locale: null,
    metadata: {},
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makePlugin(clientFactory: any, overrides: Record<string, unknown> = {}) {
  return new CodexProviderPlugin({ clientFactory: clientFactory as any, ...overrides });
}

function makePluginWithReviewRunner(clientFactory: any, reviewRunner: any) {
  return new CodexProviderPlugin({
    clientFactory: clientFactory as any,
    reviewRunner: reviewRunner as any,
  });
}

test('CodexProviderPlugin stop shuts down started app clients', async () => {
  const stopped: string[] = [];
  const plugin = makePlugin((profile: any) => ({
      async start() {},
      async listThreads() {
        return { items: [], nextCursor: null };
      },
      async stop() {
        stopped.push(profile.id);
      },
    }));
  const firstProfile = makeProfile({ defaultModel: 'gpt-5.4' });
  const secondProfile = {
    ...makeProfile({ defaultModel: 'gpt-5.4' }),
    id: 'openai-alt',
  };

  await plugin.listThreads({ providerProfile: firstProfile });
  await plugin.listThreads({ providerProfile: secondProfile });
  await plugin.stop();

  assert.deepEqual(stopped.sort(), ['openai-alt', 'openai-default']);
  assert.equal(plugin.getClient('openai-default'), null);
});

test('CodexProviderPlugin uses per-profile clients and forwards default model into startThread/startTurn', async () => {
  const calls = [];
  let seenDeveloperInstructions = null;
  const plugin = makePlugin((profile: any) => ({
      async start() {
        calls.push(['start', profile.id]);
      },
      async startThread(params: any) {
        calls.push(['startThread', profile.id, params.model]);
        return {
          threadId: `${profile.id}-thread-1`,
          cwd: params.cwd ?? null,
          title: params.title ?? null,
        };
      },
      async readThread(threadId: string) {
        calls.push(['readThread', profile.id, threadId]);
        return {
          threadId,
          title: 'Existing thread',
          cwd: '/tmp/work',
        };
      },
      async listThreads() {
        calls.push(['listThreads', profile.id]);
        return { items: [{ threadId: `${profile.id}-thread-1`, cwd: '/tmp/work' }], nextCursor: null };
      },
      async startTurn(params: any) {
        seenDeveloperInstructions = params.developerInstructions;
        calls.push(['startTurn', profile.id, params.model]);
        return {
          outputText: 'done',
          threadId: params.threadId,
          title: 'Existing thread',
        };
      },
      async interruptTurn(params: any) {
        calls.push(['interruptTurn', profile.id, params.turnId]);
      },
      async listModels() {
        calls.push(['listModels', profile.id]);
        return [{
          id: 'gpt-5.4',
          model: 'gpt-5.4',
          displayName: 'GPT-5.4',
          description: '',
          isDefault: true,
          supportedReasoningEfforts: ['medium'],
          defaultReasoningEffort: 'medium',
        }];
      },
    }));
  const profile = makeProfile({ defaultModel: 'gpt-5.4' });

  const started = await plugin.startThread({
    providerProfile: profile,
    cwd: '/tmp/work',
  });
  const turn = await plugin.startTurn({
    providerProfile: profile,
    bridgeSession: makeBridgeSession({
      codexThreadId: started.threadId,
      title: 'Existing thread',
    }),
    sessionSettings: makeSessionSettings(),
    event: {
      platform: 'weixin',
      externalScopeId: 'wxid_1',
      text: 'hello',
    },
    inputText: 'hello',
  });

  assert.equal(started.threadId, 'openai-default-thread-1');
  assert.equal(turn.outputText, 'done');
  assert.ok(calls.some((entry) => entry[0] === 'startThread' && entry[2] === 'gpt-5.4'));
  assert.ok(calls.some((entry) => entry[0] === 'startTurn' && entry[2] === 'gpt-5.4'));
  assert.match(String(seenDeveloperInstructions ?? ''), /CodexBridge runtime constraints/);
  assert.match(String(seenDeveloperInstructions ?? ''), /CodexBridge turn mode:/);
  assert.match(String(seenDeveloperInstructions ?? ''), /Standard bridge turn\./);
  assert.match(String(seenDeveloperInstructions ?? ''), /Do not call tool_suggest/);
  assert.match(String(seenDeveloperInstructions ?? ''), /thread\/session lifecycle, slash-command state transitions, and final platform delivery/i);
});

test('CodexProviderPlugin forwards native thread goal operations to the app client', async () => {
  const calls: any[] = [];
  const plugin = makePlugin(() => ({
    async start() {},
    async getThreadGoal(threadId: string) {
      calls.push(['getThreadGoal', threadId]);
      return {
        threadId,
        objective: 'Keep replies concise.',
        status: 'active',
      };
    },
    async setThreadGoal(params: any) {
      calls.push(['setThreadGoal', params]);
      return {
        threadId: params.threadId,
        objective: params.objective ?? 'Keep replies concise.',
        status: params.status ?? 'active',
      };
    },
    async clearThreadGoal(threadId: string) {
      calls.push(['clearThreadGoal', threadId]);
      return true;
    },
  }));

  const profile = makeProfile({ defaultModel: 'gpt-5.4' });
  const current = await plugin.getThreadGoal({
    providerProfile: profile,
    threadId: 'thread-1',
  });
  const updated = await plugin.setThreadGoal({
    providerProfile: profile,
    threadId: 'thread-1',
    objective: 'Keep CodexBridge focused on reliable WeChat delivery.',
    suppressAutoTurn: true,
  });
  const cleared = await plugin.clearThreadGoal({
    providerProfile: profile,
    threadId: 'thread-1',
  });

  assert.equal(current?.objective, 'Keep replies concise.');
  assert.equal(updated?.objective, 'Keep CodexBridge focused on reliable WeChat delivery.');
  assert.equal(cleared, true);
  assert.deepEqual(calls, [
    ['getThreadGoal', 'thread-1'],
    ['setThreadGoal', {
      threadId: 'thread-1',
      objective: 'Keep CodexBridge focused on reliable WeChat delivery.',
      status: null,
      suppressAutoTurn: true,
    }],
    ['clearThreadGoal', 'thread-1'],
  ]);
});

test('CodexProviderPlugin clamps unsupported reasoning efforts to the model fallback', async () => {
  const seenEfforts: any[] = [];
  const plugin = makePlugin(() => ({
    async start() {},
    async startTurn(params: any) {
      seenEfforts.push(params.effort ?? null);
      return {
        outputText: 'done',
        threadId: params.threadId,
        title: null,
      };
    },
    async listModels() {
      return [{
        id: 'gpt-test',
        model: 'gpt-test',
        displayName: 'GPT Test',
        description: '',
        isDefault: true,
        supportedReasoningEfforts: ['medium', 'high'],
        defaultReasoningEffort: 'medium',
      }];
    },
  }));

  await plugin.startTurn({
    providerProfile: makeProfile({ defaultModel: null }),
    bridgeSession: makeBridgeSession({ codexThreadId: 'thread-1' }),
    sessionSettings: makeSessionSettings({ reasoningEffort: 'xhigh' }),
    event: {
      platform: 'weixin',
      externalScopeId: 'wxid_1',
      text: 'hello',
    },
    inputText: 'hello',
  });

  assert.deepEqual(seenEfforts, ['medium']);
});

test('CodexProviderPlugin leaves reasoning effort unset when neither user nor model specifies one', async () => {
  const seenEfforts: any[] = [];
  const plugin = makePlugin(() => ({
    async start() {},
    async startTurn(params: any) {
      seenEfforts.push(params.effort ?? null);
      return {
        outputText: 'done',
        threadId: params.threadId,
        title: null,
      };
    },
    async listModels() {
      return [{
        id: 'gpt-5.4',
        model: 'gpt-5.4',
        displayName: 'GPT-5.4',
        description: '',
        isDefault: true,
        supportedReasoningEfforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: null,
      }];
    },
  }));

  await plugin.startTurn({
    providerProfile: makeProfile({ defaultModel: 'gpt-5.4' }),
    bridgeSession: makeBridgeSession({ codexThreadId: 'thread-1' }),
    sessionSettings: makeSessionSettings({ reasoningEffort: null }),
    event: {
      platform: 'weixin',
      externalScopeId: 'wxid_1',
      text: 'hello',
    },
    inputText: 'hello',
  });

  assert.deepEqual(seenEfforts, [null]);
});

test('CodexProviderPlugin forwards ephemeral start and thread archive RPCs', async () => {
  const calls: any[] = [];
  const plugin = makePlugin((profile: any) => ({
    async start() {},
    async startThread(params: any) {
      calls.push(['startThread', profile.id, params.ephemeral]);
      return {
        threadId: 'thread-1',
        cwd: params.cwd ?? null,
        title: params.title ?? null,
      };
    },
    async archiveThread(threadId: string) {
      calls.push(['archiveThread', profile.id, threadId]);
    },
    async unarchiveThread(threadId: string) {
      calls.push(['unarchiveThread', profile.id, threadId]);
    },
    async listModels() {
      return [];
    },
  }));
  const profile = makeProfile();

  await plugin.startThread({
    providerProfile: profile,
    cwd: '/tmp/work',
    ephemeral: true,
  });
  await plugin.archiveThread({ providerProfile: profile, threadId: 'thread-1' });
  await plugin.unarchiveThread({ providerProfile: profile, threadId: 'thread-1' });

  assert.deepEqual(calls, [
    ['startThread', 'openai-default', true],
    ['archiveThread', 'openai-default', 'thread-1'],
    ['unarchiveThread', 'openai-default', 'thread-1'],
  ]);
});

test('CodexProviderPlugin normalizes legacy service tier values before calling the app client', async () => {
  const seenServiceTiers: string[] = [];
  const plugin = makePlugin(() => ({
    async start() {},
    async startThread() {
      return { threadId: 'thread-1', cwd: '/tmp/work', title: null };
    },
    async startTurn(params: any) {
      seenServiceTiers.push(params.serviceTier);
      return {
        outputText: 'done',
        threadId: params.threadId,
        title: null,
      };
    },
    async listModels() {
      return [{
        id: 'gpt-5.4',
        model: 'gpt-5.4',
        displayName: 'GPT-5.4',
        description: '',
        isDefault: true,
        supportedReasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
      }];
    },
  }));

  const profile = makeProfile({ defaultModel: 'gpt-5.4' });
  const bridgeSession = makeBridgeSession({ codexThreadId: 'thread-1' });

  await plugin.startTurn({
    providerProfile: profile,
    bridgeSession,
    sessionSettings: makeSessionSettings({ serviceTier: 'priority' }),
    event: { platform: 'weixin', externalScopeId: 'wxid_1', text: 'hello' },
    inputText: 'hello',
  });
  await plugin.startTurn({
    providerProfile: profile,
    bridgeSession,
    sessionSettings: makeSessionSettings({ serviceTier: 'default' }),
    event: { platform: 'weixin', externalScopeId: 'wxid_1', text: 'hello again' },
    inputText: 'hello again',
  });

  assert.deepEqual(seenServiceTiers, ['fast', 'flex']);
});

test('CodexProviderPlugin forwards plan collaboration mode into startTurn', async () => {
  let seenCollaborationMode: string | null = null;
  const plugin = makePlugin(() => ({
    async start() {},
    async startThread() {
      return { threadId: 'thread-1', cwd: '/tmp/work', title: null };
    },
    async startTurn(params: any) {
      seenCollaborationMode = params.collaborationMode;
      return {
        outputText: 'done',
        threadId: params.threadId,
        title: null,
      };
    },
    async listModels() {
      return [{
        id: 'gpt-5.4',
        model: 'gpt-5.4',
        displayName: 'GPT-5.4',
        description: '',
        isDefault: true,
        supportedReasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
      }];
    },
  }));

  await plugin.startTurn({
    providerProfile: makeProfile({ defaultModel: 'gpt-5.4' }),
    bridgeSession: makeBridgeSession({ codexThreadId: 'thread-1' }),
    sessionSettings: makeSessionSettings({ collaborationMode: 'plan' }),
    event: { platform: 'weixin', externalScopeId: 'wxid_1', text: 'plan this change' },
    inputText: 'plan this change',
  });

  assert.equal(seenCollaborationMode, 'plan');
});

test('CodexProviderPlugin startReview runs native review through the injected review runner without rebinding a chat thread', async () => {
  const reviewCalls: any[] = [];
  const plugin = new CodexProviderPlugin({
    clientFactory: (() => ({
      async start() {},
    })) as any,
    readAuthState: () => ({
      authPath: '/tmp/auth.json',
      identity: {
        authMode: 'api',
        accountId: 'acc_api',
        email: 'api@example.com',
      },
      tokens: {
        accountId: 'acc_api',
      },
    }) as any,
    reviewRunner: {
      async start(params: any) {
        reviewCalls.push(params);
        await params.onTurnStarted?.({
          threadId: 'codex-review-cli-1',
          turnId: 'codex-review-cli-1-turn-1',
        });
        return {
          outputText: 'review findings',
          outputState: 'complete',
          threadId: 'codex-review-cli-1',
          turnId: 'codex-review-cli-1-turn-1',
          finalSource: 'codex_review_cli',
        };
      },
      readThread() {
        return null;
      },
      async interrupt() {
        return false;
      },
    } as any,
  });

  const result = await plugin.startReview({
    providerProfile: makeProfile({ defaultModel: 'gpt-5.4' }),
    bridgeSession: makeBridgeSession({ codexThreadId: 'thread-1' }),
    sessionSettings: makeSessionSettings({
      model: 'gpt-5.4',
      reasoningEffort: 'xhigh',
      serviceTier: 'priority',
    }),
    cwd: '/tmp/work',
    target: {
      type: 'baseBranch',
      branch: 'main',
    },
    locale: 'zh-CN',
  });

  assert.equal(reviewCalls.length, 1);
  assert.equal(reviewCalls[0]?.cwd, '/tmp/work');
  assert.equal(reviewCalls[0]?.model, 'gpt-5.4');
  assert.equal(reviewCalls[0]?.effort, 'xhigh');
  assert.equal(reviewCalls[0]?.serviceTier, 'fast');
  assert.equal(reviewCalls[0]?.locale, 'zh-CN');
  assert.deepEqual(reviewCalls[0]?.target, {
    type: 'baseBranch',
    branch: 'main',
  });
  assert.equal(result.outputText, 'review findings');
  assert.equal(result.threadId, 'codex-review-cli-1');
});

test('CodexProviderPlugin lists visible skills and forwards enable-disable writes to the app client', async () => {
  const listCalls: any[] = [];
  const writeCalls: any[] = [];
  const plugin = makePlugin(() => ({
    async start() {},
    async listSkills(params: any) {
      listCalls.push(params);
      return {
        cwd: '/tmp/work',
        skills: [{
          name: 'news-digest',
          description: 'Summarize the news.',
          enabled: true,
          path: '/tmp/skills/news-digest/SKILL.md',
          scope: 'user',
          shortDescription: 'Daily news summary',
          displayName: 'News Digest',
          defaultPrompt: 'Summarize today’s key news',
          brandColor: '#00AAFF',
          dependencies: [{ type: 'tool', value: 'news' }],
        }],
        errors: [],
      };
    },
    async setSkillEnabled(params: any) {
      writeCalls.push(params);
    },
  }));

  const listed = await plugin.listSkills({
    providerProfile: makeProfile(),
    cwd: '/tmp/work',
    forceReload: true,
  });
  await plugin.setSkillEnabled({
    providerProfile: makeProfile(),
    enabled: false,
    path: '/tmp/skills/news-digest/SKILL.md',
    name: 'news-digest',
  });

  assert.equal(listCalls.length, 1);
  assert.equal(listCalls[0]?.cwd, '/tmp/work');
  assert.equal(listCalls[0]?.forceReload, true);
  assert.equal(listed.skills[0]?.displayName, 'News Digest');
  assert.deepEqual(listed.skills[0]?.dependencies, [{ type: 'tool', value: 'news' }]);
  assert.equal(writeCalls.length, 1);
  assert.equal(writeCalls[0]?.enabled, false);
  assert.equal(writeCalls[0]?.path, '/tmp/skills/news-digest/SKILL.md');
});

test('CodexProviderPlugin delegates plugin catalog reads to the app client', async () => {
  const listCalls: any[] = [];
  const readCalls: any[] = [];
  const installCalls: any[] = [];
  const uninstallCalls: any[] = [];
  const appToggleCalls: any[] = [];
  const mcpToggleCalls: any[] = [];
  const mcpOauthCalls: any[] = [];
  const mcpReloadCalls: any[] = [];
  const plugin = makePlugin(() => ({
    async start() {},
    async listPlugins(params: any) {
      listCalls.push(params);
      return {
        featuredPluginIds: ['google-drive@openai-curated'],
        marketplaceLoadErrors: [],
        marketplaces: [],
      };
    },
    async readPlugin(params: any) {
      readCalls.push(params);
      return {
        summary: {
          id: 'google-drive@openai-curated',
          name: 'google-drive',
          installed: true,
          enabled: true,
          installPolicy: 'AVAILABLE',
          authPolicy: 'ON_USE',
          marketplaceName: 'openai-curated',
          marketplacePath: null,
        },
        marketplaceName: 'openai-curated',
        marketplacePath: null,
        description: 'Drive plugin',
        apps: [],
        mcpServers: [],
        skills: [],
      };
    },
    async installPlugin(params: any) {
      installCalls.push(params);
      return {
        authPolicy: 'ON_USE',
        appsNeedingAuth: [],
      };
    },
    async uninstallPlugin(params: any) {
      uninstallCalls.push(params);
    },
    async setAppEnabled(params: any) {
      appToggleCalls.push(params);
    },
    async setMcpServerEnabled(params: any) {
      mcpToggleCalls.push(params);
    },
    async startMcpServerOauthLogin(params: any) {
      mcpOauthCalls.push(params);
      return {
        authorizationUrl: `https://example.com/oauth/${params.name}`,
      };
    },
    async reloadMcpServers() {
      mcpReloadCalls.push(true);
    },
  }));

  const listed = await plugin.listPlugins({
    providerProfile: makeProfile(),
    cwd: '/tmp/work',
  });
  const detail = await plugin.readPlugin({
    providerProfile: makeProfile(),
    pluginName: 'google-drive',
    marketplaceName: 'openai-curated',
  });
  const installResult = await plugin.installPlugin({
    providerProfile: makeProfile(),
    pluginName: 'google-drive',
    marketplaceName: 'openai-curated',
  });
  await plugin.uninstallPlugin({
    providerProfile: makeProfile(),
    pluginId: 'google-drive@openai-curated',
  });
  await plugin.setAppEnabled({
    providerProfile: makeProfile(),
    appId: 'google-drive',
    enabled: false,
  });
  await plugin.setMcpServerEnabled({
    providerProfile: makeProfile(),
    name: 'openai-docs',
    enabled: false,
  });
  const oauth = await plugin.startMcpServerOauthLogin({
    providerProfile: makeProfile(),
    name: 'openai-docs',
  });
  await plugin.reloadMcpServers({
    providerProfile: makeProfile(),
  });

  assert.equal(listCalls[0]?.cwd, '/tmp/work');
  assert.equal(listed.featuredPluginIds[0], 'google-drive@openai-curated');
  assert.equal(readCalls[0]?.pluginName, 'google-drive');
  assert.equal(detail?.summary.id, 'google-drive@openai-curated');
  assert.equal(installResult.authPolicy, 'ON_USE');
  assert.equal(installCalls[0]?.pluginName, 'google-drive');
  assert.equal(uninstallCalls[0]?.pluginId, 'google-drive@openai-curated');
  assert.equal(appToggleCalls[0]?.appId, 'google-drive');
  assert.equal(mcpToggleCalls[0]?.name, 'openai-docs');
  assert.equal(oauth.authorizationUrl, 'https://example.com/oauth/openai-docs');
  assert.equal(mcpOauthCalls[0]?.name, 'openai-docs');
  assert.equal(mcpReloadCalls.length, 1);
});

test('CodexProviderPlugin turns inbound attachments into text prompt plus localImage inputs', async () => {
  let seenInput = null;
  let seenInputText = null;
  const plugin = makePlugin(() => ({
    async start() {},
    async startThread() {
      return { threadId: 'thread-1', cwd: null, title: null };
    },
    async readThread(threadId: string) {
      return { threadId, title: null, cwd: null };
    },
    async listThreads() {
      return { items: [], nextCursor: null };
    },
    async startTurn(params: any) {
      seenInput = params.input;
      seenInputText = params.inputText;
      return {
        outputText: 'done',
        threadId: params.threadId,
        title: null,
      };
    },
    async interruptTurn() {},
    async listModels() {
      return [{
        id: 'gpt-5.4',
        model: 'gpt-5.4',
        displayName: 'GPT-5.4',
        description: '',
        isDefault: true,
        supportedReasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
      }];
    },
  }));

  await plugin.startTurn({
    providerProfile: makeProfile(),
    bridgeSession: makeBridgeSession(),
    sessionSettings: makeSessionSettings(),
    event: {
      platform: 'weixin',
      externalScopeId: 'wxid_1',
      text: '',
      attachments: [
        {
          kind: 'image',
          localPath: '/tmp/example.png',
          fileName: 'example.png',
          mimeType: 'image/png',
        },
        {
          kind: 'file',
          localPath: '/tmp/report.pdf',
          fileName: 'report.pdf',
          mimeType: 'application/pdf',
        },
      ],
    },
    inputText: '',
  });

  assert.equal(Array.isArray(seenInput), true);
  assert.equal(seenInput?.[0]?.type, 'text');
  assert.match(seenInput?.[0]?.text ?? '', /Weixin attachments:/);
  assert.match(seenInput?.[0]?.text ?? '', /report\.pdf/);
  assert.deepEqual(seenInput?.[1], {
    type: 'localImage',
    path: '/tmp/example.png',
  });
  assert.match(String(seenInputText ?? ''), /Weixin attachments:/);
});

test('CodexProviderPlugin forwards media outputs from the app client', async () => {
  const plugin = makePlugin(() => ({
    async start() {},
    async startThread() {
      return { threadId: 'thread-1', cwd: null, title: null };
    },
    async readThread(threadId: string) {
      return { threadId, title: null, cwd: null };
    },
    async listThreads() {
      return { items: [], nextCursor: null };
    },
    async startTurn(params: any) {
      return {
        outputText: '',
        outputMedia: [{
          kind: 'image',
          path: '/tmp/generated-dog.png',
          caption: null,
        }],
        threadId: params.threadId,
        title: null,
      };
    },
    async interruptTurn() {},
    async listModels() {
      return [{
        id: 'gpt-5.4',
        model: 'gpt-5.4',
        displayName: 'GPT-5.4',
        description: '',
        isDefault: true,
        supportedReasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
      }];
    },
  }));

  const result = await plugin.startTurn({
    providerProfile: makeProfile(),
    bridgeSession: makeBridgeSession(),
    sessionSettings: makeSessionSettings(),
    event: {
      platform: 'weixin',
      externalScopeId: 'wxid_1',
      text: '画一只小狗',
    },
    inputText: '画一只小狗',
  });

  assert.deepEqual(result.outputMedia, [{
    kind: 'image',
    path: '/tmp/generated-dog.png',
    caption: null,
  }]);
  assert.deepEqual(result.outputArtifacts, [{
    kind: 'image',
    path: '/tmp/generated-dog.png',
    caption: null,
  }]);
});

test('CodexProviderPlugin auto-injects artifact send-back instructions for file delivery turns', async () => {
  let seenDeveloperInstructions = null;
  const plugin = makePlugin(() => ({
    async start() {},
    async startThread() {
      return { threadId: 'thread-1', cwd: null, title: null };
    },
    async readThread(threadId: string) {
      return { threadId, title: null, cwd: null };
    },
    async listThreads() {
      return { items: [], nextCursor: null };
    },
    async startTurn(params: any) {
      seenDeveloperInstructions = params.developerInstructions;
      return {
        outputText: 'done',
        threadId: params.threadId,
        title: null,
      };
    },
    async interruptTurn() {},
    async listModels() {
      return [{
        id: 'gpt-5.4',
        model: 'gpt-5.4',
        displayName: 'GPT-5.4',
        description: '',
        isDefault: true,
        supportedReasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
      }];
    },
  }));

  await plugin.startTurn({
    providerProfile: makeProfile(),
    bridgeSession: makeBridgeSession(),
    sessionSettings: makeSessionSettings(),
    event: {
      platform: 'weixin',
      externalScopeId: 'wxid_1',
      text: '把这次未提交修改整理成 Word 文档发我',
      metadata: {
        codexbridge: {
          turnArtifactContext: {
            requestId: 'req-1',
            bridgeSessionId: 'session-1',
            artifactDir: '/tmp/project/.codexbridge/turn-artifacts/req-1',
            spoolDir: '/tmp/project/.codexbridge/artifact-spool/req-1',
            turnId: null,
            intent: {
              requested: true,
              preferredKind: 'file',
              requestedFormat: 'docx',
              requestedExtension: '.docx',
              requestedFileName: null,
              userDescription: '把这次未提交修改整理成 Word 文档发我',
              requiresClarification: false,
            },
          },
        },
      },
    },
    inputText: '把这次未提交修改整理成 Word 文档发我',
  });

  assert.match(String(seenDeveloperInstructions ?? ''), /CodexBridge attachment delivery protocol/);
  assert.match(String(seenDeveloperInstructions ?? ''), /\/tmp\/project\/\.codexbridge\/turn-artifacts\/req-1/);
  assert.match(String(seenDeveloperInstructions ?? ''), /codexbridge-artifacts/);
  assert.match(String(seenDeveloperInstructions ?? ''), /Choose a clear, semantic final filename yourself/i);
  assert.match(String(seenDeveloperInstructions ?? ''), /your-chosen-file\.docx/);
});

test('CodexProviderPlugin injects explicit plugin targeting instructions when the bridge marks a preferred plugin', async () => {
  let seenDeveloperInstructions = null;
  const plugin = makePlugin(() => ({
    async start() {},
    async startThread() {
      return { threadId: 'thread-1', cwd: null, title: null };
    },
    async readThread(threadId: string) {
      return { threadId, title: null, cwd: null };
    },
    async listThreads() {
      return { items: [], nextCursor: null };
    },
    async startTurn(params: any) {
      seenDeveloperInstructions = params.developerInstructions;
      return {
        outputText: 'done',
        threadId: params.threadId,
        title: null,
      };
    },
    async interruptTurn() {},
    async listModels() {
      return [{
        id: 'gpt-5.4',
        model: 'gpt-5.4',
        displayName: 'GPT-5.4',
        description: '',
        isDefault: true,
        supportedReasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
      }];
    },
  }));

  await plugin.startTurn({
    providerProfile: makeProfile(),
    bridgeSession: makeBridgeSession(),
    sessionSettings: makeSessionSettings(),
    event: {
      platform: 'weixin',
      externalScopeId: 'wxid_1',
      text: '查今天未读邮件',
      metadata: {
        codexbridge: {
          explicitPluginTarget: {
            pluginId: 'gmail@openai-curated',
            pluginName: 'gmail',
            pluginDisplayName: 'Gmail',
            alias: 'gm',
            source: 'auto',
            syntax: 'slash_use',
          },
        },
      },
    },
    inputText: '查今天未读邮件',
  });

  assert.match(String(seenDeveloperInstructions ?? ''), /CodexBridge plugin targeting hints/);
  assert.match(String(seenDeveloperInstructions ?? ''), /prefer the following plugins/i);
  assert.match(String(seenDeveloperInstructions ?? ''), /1\. Gmail/);
  assert.match(String(seenDeveloperInstructions ?? ''), /gmail@openai-curated/);
  assert.match(String(seenDeveloperInstructions ?? ''), /gm/);
  assert.match(String(seenDeveloperInstructions ?? ''), /slash_use/);
});

test('CodexProviderPlugin injects parser-turn framing when the bridge marks an internal command-skill parse', async () => {
  let seenDeveloperInstructions = null;
  const plugin = makePlugin(() => ({
    async start() {},
    async startThread() {
      return { threadId: 'thread-1', cwd: '/tmp/work', title: null };
    },
    async readThread(threadId: string) {
      return { threadId, title: null, cwd: '/tmp/work' };
    },
    async listThreads() {
      return { items: [], nextCursor: null };
    },
    async startTurn(params: any) {
      seenDeveloperInstructions = params.developerInstructions;
      return {
        outputText: 'done',
        threadId: params.threadId,
        title: null,
      };
    },
    async interruptTurn() {},
    async listModels() {
      return [{
        id: 'gpt-5.4',
        model: 'gpt-5.4',
        displayName: 'GPT-5.4',
        description: '',
        isDefault: true,
        supportedReasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
      }];
    },
  }));

  await plugin.startTurn({
    providerProfile: makeProfile(),
    bridgeSession: makeBridgeSession(),
    sessionSettings: makeSessionSettings({
      accessPreset: 'read-only',
      approvalPolicy: 'never',
      sandboxMode: 'read-only',
    }),
    event: {
      platform: 'weixin',
      externalScopeId: 'wxid_1',
      text: 'Return JSON only',
      metadata: {
        codexbridge: {
          developerPromptContext: {
            mode: 'command-skill-parser',
            title: 'Agent Command Skill',
            source: 'agent-command-skill',
            command: 'agent',
            subcommand: 'edit',
            operation: 'rewrite_pending_draft',
          },
        },
      },
    },
    inputText: 'Return JSON only',
  });

  assert.match(String(seenDeveloperInstructions ?? ''), /CodexBridge turn mode:/);
  assert.match(String(seenDeveloperInstructions ?? ''), /Command-skill parser\./);
  assert.match(String(seenDeveloperInstructions ?? ''), /Return only the structured result requested by the prompt or skill contract/i);
  assert.match(String(seenDeveloperInstructions ?? ''), /Command context: \/agent edit/);
  assert.match(String(seenDeveloperInstructions ?? ''), /Bridge operation: rewrite_pending_draft/);
});

test('CodexProviderPlugin preserves provider_error details from the app client', async () => {
  const plugin = makePlugin(() => ({
    async start() {},
    async startThread() {
      return { threadId: 'thread-1', cwd: '/tmp/work', title: null };
    },
    async startTurn(params: any) {
      return {
        outputText: '',
        outputState: 'provider_error',
        errorMessage: 'Codex subscription credits are exhausted',
        status: 'failed',
        threadId: params.threadId,
        turnId: 'turn-1',
        title: null,
      };
    },
    async listModels() {
      return [{
        id: 'gpt-5.4',
        model: 'gpt-5.4',
        displayName: 'GPT-5.4',
        description: '',
        isDefault: true,
        supportedReasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
      }];
    },
  }));

  const result = await plugin.startTurn({
    providerProfile: makeProfile({ defaultModel: 'gpt-5.4' }),
    bridgeSession: makeBridgeSession({ codexThreadId: 'thread-1' }),
    sessionSettings: makeSessionSettings(),
    event: {
      platform: 'weixin',
      externalScopeId: 'wxid_1',
      text: 'hello',
    },
    inputText: 'hello',
  });

  assert.equal(result.outputState, 'provider_error');
  assert.equal(result.errorMessage, 'Codex subscription credits are exhausted');
  assert.equal(result.status, 'failed');
  assert.equal(result.turnId, 'turn-1');
});

test('CodexProviderPlugin resolves default model metadata from listModels when profile defaults are empty', async () => {
  const calls = [];
  const plugin = makePlugin(() => ({
      async start() {},
      async startThread(params: any) {
        calls.push(['startThread', params.model]);
        return {
          threadId: 'thread-1',
          cwd: params.cwd ?? null,
          title: params.title ?? null,
        };
      },
      async readThread(threadId: string) {
        return { threadId, title: null, cwd: null };
      },
      async listThreads() {
        return { items: [], nextCursor: null };
      },
      async startTurn(params: any) {
        calls.push(['startTurn', params.model, params.effort]);
        return {
          outputText: 'done',
          threadId: params.threadId,
          title: null,
        };
      },
      async interruptTurn() {},
      async listModels() {
        return [{
          id: 'gpt-5.4',
          model: 'gpt-5.4',
          displayName: 'GPT-5.4',
          description: '',
          isDefault: true,
          supportedReasoningEfforts: ['medium'],
          defaultReasoningEffort: 'medium',
        }];
      },
    }));
  const profile = makeProfile({ defaultModel: null });

  const started = await plugin.startThread({
    providerProfile: profile,
    cwd: '/tmp/work',
  });
  await plugin.startTurn({
    providerProfile: profile,
    bridgeSession: makeBridgeSession({
      codexThreadId: started.threadId,
    }),
    sessionSettings: makeSessionSettings(),
    event: {
      platform: 'weixin',
      externalScopeId: 'wxid_1',
      text: 'hello',
    },
    inputText: 'hello',
  });

  assert.deepEqual(calls, [
    ['startThread', 'gpt-5.4'],
    ['startTurn', 'gpt-5.4', 'medium'],
  ]);
});

test('CodexProviderPlugin ignores unsupported ChatGPT-only model overrides and falls back to gpt-5.5', async () => {
  const calls = [];
  const plugin = makePlugin(() => ({
    async start() {},
    async startThread(params: any) {
      calls.push(['startThread', params.model]);
      return {
        threadId: 'thread-chatgpt-default-1',
        cwd: params.cwd ?? null,
        title: params.title ?? null,
      };
    },
    async readThread(threadId: string) {
      return { threadId, title: null, cwd: null };
    },
    async listThreads() {
      return { items: [], nextCursor: null };
    },
    async startTurn(params: any) {
      calls.push(['startTurn', params.model]);
      return {
        outputText: 'done',
        threadId: params.threadId,
        title: null,
      };
    },
    async interruptTurn() {},
    async listModels() {
      return [
        {
          id: 'gpt-5.5',
          model: 'gpt-5.5',
          displayName: 'GPT-5.5',
          description: '',
          isDefault: true,
          supportedReasoningEfforts: ['medium'],
          defaultReasoningEffort: 'medium',
        },
        {
          id: 'gpt-5.4',
          model: 'gpt-5.4',
          displayName: 'GPT-5.4',
          description: '',
          isDefault: false,
          supportedReasoningEfforts: ['medium'],
          defaultReasoningEffort: 'medium',
        },
      ];
    },
  }), {
    readAuthState: () => ({
      authPath: '/tmp/auth.json',
      identity: {
        authMode: 'chatgpt',
        accountId: 'acc_chatgpt',
        email: 'chatgpt@example.com',
      },
      tokens: {
        refreshToken: 'refresh-token',
        accountId: 'acc_chatgpt',
      },
    }),
  });
  const profile = makeProfile({ defaultModel: 'gpt-5.3-codex' });

  const started = await plugin.startThread({
    providerProfile: profile,
    cwd: '/tmp/work',
  });
  await plugin.startTurn({
    providerProfile: profile,
    bridgeSession: makeBridgeSession({
      codexThreadId: started.threadId,
    }),
    sessionSettings: makeSessionSettings({
      model: 'gpt-5.3-codex',
    }),
    event: {
      platform: 'weixin',
      externalScopeId: 'wxid_1',
      text: 'hello',
    },
    inputText: 'hello',
  });

  assert.deepEqual(calls, [
    ['startThread', 'gpt-5.5'],
    ['startTurn', 'gpt-5.5'],
  ]);
});

test('CodexProviderPlugin ignores unsupported gpt-5.4 entries from model/list for ChatGPT auth and falls back to the first supported model', async () => {
  const calls = [];
  const plugin = makePlugin(() => ({
    async start() {},
    async startThread(params: any) {
      calls.push(['startThread', params.model]);
      return {
        threadId: 'thread-chatgpt-list-fallback-1',
        cwd: params.cwd ?? null,
        title: params.title ?? null,
      };
    },
    async readThread(threadId: string) {
      return { threadId, title: null, cwd: null };
    },
    async listThreads() {
      return { items: [], nextCursor: null };
    },
    async startTurn(params: any) {
      calls.push(['startTurn', params.model]);
      return {
        outputText: 'done',
        threadId: params.threadId,
        title: null,
      };
    },
    async interruptTurn() {},
    async listModels() {
      return [
        {
          id: 'gpt-5.4',
          model: 'gpt-5.4',
          displayName: 'GPT-5.4',
          description: '',
          isDefault: true,
          supportedReasoningEfforts: ['medium'],
          defaultReasoningEffort: 'medium',
        },
        {
          id: 'gpt-5.5',
          model: 'gpt-5.5',
          displayName: 'GPT-5.5',
          description: '',
          isDefault: false,
          supportedReasoningEfforts: ['medium'],
          defaultReasoningEffort: 'medium',
        },
      ];
    },
  }), {
    readAuthState: () => ({
      authPath: '/tmp/auth.json',
      identity: {
        authMode: 'chatgpt',
        accountId: 'acc_chatgpt',
        email: 'chatgpt@example.com',
      },
      tokens: {
        refreshToken: 'refresh-token',
        accountId: 'acc_chatgpt',
      },
    }),
  });

  const started = await plugin.startThread({
    providerProfile: makeProfile(),
    cwd: '/tmp/work',
  });
  await plugin.startTurn({
    providerProfile: makeProfile(),
    bridgeSession: makeBridgeSession({
      codexThreadId: started.threadId,
    }),
    sessionSettings: makeSessionSettings(),
    event: {
      platform: 'weixin',
      externalScopeId: 'wxid_1',
      text: 'hello',
    },
    inputText: 'hello',
  });

  assert.deepEqual(calls, [
    ['startThread', 'gpt-5.5'],
    ['startTurn', 'gpt-5.5'],
  ]);
});

test('CodexProviderPlugin prefers gpt-5.5 over other supported ChatGPT models when no explicit model is selected', async () => {
  const calls = [];
  const plugin = makePlugin(() => ({
    async start() {},
    async startThread(params: any) {
      calls.push(['startThread', params.model]);
      return {
        threadId: 'thread-chatgpt-preferred-1',
        cwd: params.cwd ?? null,
        title: params.title ?? null,
      };
    },
    async readThread(threadId: string) {
      return { threadId, title: null, cwd: null };
    },
    async listThreads() {
      return { items: [], nextCursor: null };
    },
    async startTurn(params: any) {
      calls.push(['startTurn', params.model]);
      return {
        outputText: 'done',
        threadId: params.threadId,
        title: null,
      };
    },
    async interruptTurn() {},
    async listModels() {
      return [
        {
          id: 'gpt-5.4-mini',
          model: 'gpt-5.4-mini',
          displayName: 'GPT-5.4-Mini',
          description: '',
          isDefault: true,
          supportedReasoningEfforts: ['medium'],
          defaultReasoningEffort: 'medium',
        },
        {
          id: 'gpt-5.5',
          model: 'gpt-5.5',
          displayName: 'GPT-5.5',
          description: '',
          isDefault: false,
          supportedReasoningEfforts: ['medium'],
          defaultReasoningEffort: 'medium',
        },
      ];
    },
  }), {
    readAuthState: () => ({
      authPath: '/tmp/auth.json',
      identity: {
        authMode: 'chatgpt',
        accountId: 'acc_chatgpt',
        email: 'chatgpt@example.com',
      },
      tokens: {
        refreshToken: 'refresh-token',
        accountId: 'acc_chatgpt',
      },
    }),
  });

  const started = await plugin.startThread({
    providerProfile: makeProfile(),
    cwd: '/tmp/work',
  });
  await plugin.startTurn({
    providerProfile: makeProfile(),
    bridgeSession: makeBridgeSession({
      codexThreadId: started.threadId,
    }),
    sessionSettings: makeSessionSettings(),
    event: {
      platform: 'weixin',
      externalScopeId: 'wxid_1',
      text: 'hello',
    },
    inputText: 'hello',
  });

  assert.deepEqual(calls, [
    ['startThread', 'gpt-5.5'],
    ['startTurn', 'gpt-5.5'],
  ]);
});

test('CodexProviderPlugin prefers gpt-5.4-mini for automation jobs under ChatGPT auth when no explicit model is selected', async () => {
  const calls = [];
  const plugin = makePlugin(() => ({
    async start() {},
    async startTurn(params: any) {
      calls.push(['startTurn', params.model]);
      return {
        outputText: 'done',
        threadId: params.threadId,
        title: null,
      };
    },
    async listModels() {
      return [
        {
          id: 'gpt-5.5',
          model: 'gpt-5.5',
          displayName: 'GPT-5.5',
          description: '',
          isDefault: true,
          supportedReasoningEfforts: ['medium'],
          defaultReasoningEffort: 'medium',
        },
        {
          id: 'gpt-5.4-mini',
          model: 'gpt-5.4-mini',
          displayName: 'GPT-5.4-Mini',
          description: '',
          isDefault: false,
          supportedReasoningEfforts: ['medium'],
          defaultReasoningEffort: 'medium',
        },
      ];
    },
  }), {
    readAuthState: () => ({
      authPath: '/tmp/auth.json',
      identity: {
        authMode: 'chatgpt',
        accountId: 'acc_chatgpt',
        email: 'chatgpt@example.com',
      },
      tokens: {
        refreshToken: 'refresh-token',
        accountId: 'acc_chatgpt',
      },
    }),
  });

  await plugin.startTurn({
    providerProfile: makeProfile(),
    bridgeSession: makeBridgeSession({
      codexThreadId: 'thread-automation-1',
    }),
    sessionSettings: makeSessionSettings(),
    event: {
      platform: 'weixin',
      externalScopeId: 'wxid_1',
      text: 'hello',
      metadata: {
        codexbridge: {
          automationJobId: 'job-1',
        },
      },
    },
    inputText: 'hello',
  });

  assert.deepEqual(calls, [
    ['startTurn', 'gpt-5.4-mini'],
  ]);
});

test('CodexProviderPlugin forwards onTurnStarted to the app client and returns the turn id', async () => {
  const plugin = makePlugin(() => ({
      async start() {},
      async startThread() {
        return { threadId: 'thread-1', cwd: null, title: null };
      },
      async readThread(threadId: string) {
        return { threadId, title: null, cwd: null };
      },
      async listThreads() {
        return { items: [], nextCursor: null };
      },
      async startTurn(params: any) {
        await params.onTurnStarted?.({
          turnId: 'turn-1',
          threadId: params.threadId,
        });
        return {
          outputText: 'done',
          turnId: 'turn-1',
          threadId: params.threadId,
          title: null,
        };
      },
      async interruptTurn() {},
      async listModels() {
        return [{
          id: 'gpt-5.4',
          model: 'gpt-5.4',
          displayName: 'GPT-5.4',
          description: '',
          isDefault: true,
          supportedReasoningEfforts: ['medium'],
          defaultReasoningEffort: 'medium',
        }];
      },
    }));
  const seen = [];

  const result = await plugin.startTurn({
    providerProfile: makeProfile(),
    bridgeSession: makeBridgeSession(),
    sessionSettings: makeSessionSettings(),
    event: {
      platform: 'weixin',
      externalScopeId: 'wxid_1',
      text: 'hello',
    },
    inputText: 'hello',
    onTurnStarted: async (meta) => {
      seen.push(meta);
    },
  });

  assert.equal(result.turnId, 'turn-1');
  assert.deepEqual(seen, [{
    turnId: 'turn-1',
    threadId: 'thread-1',
  }]);
});

test('CodexProviderPlugin forwards thread list paging and includeTurns reads to the app client', async () => {
  const calls = [];
  const plugin = makePlugin(() => ({
      async start() {},
      async startThread() {
        return { threadId: 'thread-1', cwd: null, title: null };
      },
      async readThread(threadId: string, includeTurns: boolean) {
        calls.push(['readThread', threadId, includeTurns]);
        return { threadId, title: 'Thread 1', cwd: '/tmp/work', turns: includeTurns ? [] : undefined };
      },
      async listThreads(params: any) {
        calls.push(['listThreads', params]);
        return { items: [{ threadId: 'thread-1', title: 'Thread 1', cwd: '/tmp/work' }], nextCursor: 'cursor-2' };
      },
      async startTurn() {
        return { outputText: 'done', threadId: 'thread-1', title: null };
      },
      async interruptTurn() {},
      async listModels() {
        return [{
          id: 'gpt-5.4',
          model: 'gpt-5.4',
          displayName: 'GPT-5.4',
          description: '',
          isDefault: true,
          supportedReasoningEfforts: ['medium'],
          defaultReasoningEffort: 'medium',
        }];
      },
    }));
  const profile = makeProfile();

  const listed = await plugin.listThreads({
    providerProfile: profile,
    limit: 5,
    cursor: 'cursor-1',
    searchTerm: 'bridge',
  });
  const thread = await plugin.readThread({
    providerProfile: profile,
    threadId: 'thread-1',
    includeTurns: true,
  });

  assert.deepEqual(listed, {
    items: [{ threadId: 'thread-1', title: 'Thread 1', cwd: '/tmp/work' }],
    nextCursor: 'cursor-2',
  });
  assert.equal(thread.threadId, 'thread-1');
  assert.deepEqual(calls, [
    ['listThreads', { limit: 5, cursor: 'cursor-1', searchTerm: 'bridge', archived: false }],
    ['readThread', 'thread-1', true],
  ]);
});

test('CodexProviderPlugin reconnectProfile replaces the existing client instance', async () => {
  const lifecycle = [];
  let clientIndex = 0;
  const plugin = makePlugin(() => {
    clientIndex += 1;
    const name = `client-${clientIndex}`;
    let connected = false;
    return {
      async start() {
        if (connected) {
          return;
        }
        connected = true;
        lifecycle.push([name, 'start']);
      },
      async stop() {
        connected = false;
        lifecycle.push([name, 'stop']);
      },
      isConnected() {
        return connected;
      },
      async startThread() {
        return {
          threadId: `${name}-thread`,
          cwd: '/tmp/work',
          title: null,
        };
      },
      async readThread(threadId: string) {
        return { threadId, cwd: '/tmp/work', title: null };
      },
      async listThreads() {
        return { items: [], nextCursor: null };
      },
      async startTurn(params: any) {
        return {
          outputText: `${name}-done`,
          outputState: 'complete',
          threadId: params.threadId,
          title: null,
        };
      },
      async interruptTurn() {},
      async listModels() {
        return [{
          id: 'gpt-5.4',
          model: 'gpt-5.4',
          displayName: 'GPT-5.4',
          description: '',
          isDefault: true,
          supportedReasoningEfforts: ['medium'],
          defaultReasoningEffort: 'medium',
        }];
      },
      async resumeThread() {
        return {};
      },
    };
  });
  const profile = makeProfile();

  await plugin.startThread({
    providerProfile: profile,
    cwd: '/tmp/work',
  });
  const reconnect = await plugin.reconnectProfile({
    providerProfile: profile,
  });
  const turn = await plugin.startTurn({
    providerProfile: profile,
    bridgeSession: makeBridgeSession(),
    sessionSettings: makeSessionSettings(),
    event: {
      platform: 'weixin',
      externalScopeId: 'wxid_1',
      text: 'hello',
    },
    inputText: 'hello',
  });

  assert.equal(reconnect.connected, true);
  assert.deepEqual(lifecycle, [
    ['client-1', 'start'],
    ['client-1', 'stop'],
    ['client-2', 'start'],
  ]);
  assert.equal(turn.outputText, 'client-2-done');
});

test('CodexProviderPlugin reconnectProfile refreshes ChatGPT auth before replacing the client', async () => {
  const lifecycle = [];
  const calls: any[] = [];
  let clientIndex = 0;
  const plugin = makePlugin(() => {
    clientIndex += 1;
    const name = `client-${clientIndex}`;
    let connected = false;
    return {
      async start() {
        connected = true;
        lifecycle.push([name, 'start']);
      },
      async stop() {
        connected = false;
        lifecycle.push([name, 'stop']);
      },
      isConnected() {
        return connected;
      },
      async startThread() {
        return {
          threadId: `${name}-thread`,
          cwd: '/tmp/work',
          title: null,
        };
      },
      async readThread(threadId: string) {
        return { threadId, cwd: '/tmp/work', title: null };
      },
      async listThreads() {
        return { items: [], nextCursor: null };
      },
      async startTurn(params: any) {
        return {
          outputText: `${name}-done`,
          outputState: 'complete',
          threadId: params.threadId,
          title: null,
        };
      },
      async interruptTurn() {},
      async listModels() {
        return [{
          id: 'gpt-5.5',
          model: 'gpt-5.5',
          displayName: 'GPT-5.5',
          description: '',
          isDefault: true,
          supportedReasoningEfforts: ['medium'],
          defaultReasoningEffort: 'medium',
        }];
      },
      async resumeThread() {
        return {};
      },
    };
  }, {
    now: () => 123456,
    readAuthState: () => ({
      authPath: '/tmp/auth.json',
      raw: { auth_mode: 'chatgpt' },
      tokens: {
        accessToken: 'old-access',
        idToken: 'old-id',
        refreshToken: 'refresh-token',
        accountId: 'old-account',
        lastRefresh: null,
      },
      identity: {
        email: 'before@example.com',
        name: null,
        authMode: 'chatgpt',
        accountId: 'old-account',
        plan: 'plus',
        authPath: '/tmp/auth.json',
      },
    }),
    refreshTokens: async ({ refreshToken }: any) => {
      calls.push(['refreshTokens', refreshToken]);
      return {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        idToken: 'new-id',
        expiresAt: null,
        tokenType: null,
        scope: null,
      };
    },
    writeAuthFile: async (payload: any) => {
      calls.push(['writeAuthFile', payload]);
      return payload.authPath;
    },
  });
  const profile = makeProfile();

  await plugin.startThread({
    providerProfile: profile,
    cwd: '/tmp/work',
  });
  const reconnect = await plugin.reconnectProfile({
    providerProfile: profile,
  });

  assert.equal(reconnect.connected, true);
  assert.deepEqual(lifecycle, [
    ['client-1', 'start'],
    ['client-1', 'stop'],
    ['client-2', 'start'],
  ]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['refreshTokens', 'refresh-token']);
  assert.equal(calls[1]?.[0], 'writeAuthFile');
  assert.equal(calls[1]?.[1]?.authPath, '/tmp/auth.json');
  assert.equal(calls[1]?.[1]?.accessToken, 'new-access');
  assert.equal(calls[1]?.[1]?.refreshToken, 'new-refresh');
  assert.equal(calls[1]?.[1]?.authMode, 'chatgpt');
  assert.equal(calls[1]?.[1]?.now, 123456);
});

test('CodexProviderPlugin forwards session personality to the app client', async () => {
  let seenPersonality = null;
  const plugin = makePlugin(() => ({
      async start() {},
      async startThread() {
        return { threadId: 'thread-1', cwd: null, title: null };
      },
      async readThread(threadId: string) {
        return { threadId, title: null, cwd: null };
      },
      async listThreads() {
        return { items: [], nextCursor: null };
      },
      async startTurn(params: any) {
        seenPersonality = params.personality;
        return {
          outputText: 'done',
          outputState: 'complete',
          threadId: params.threadId,
          title: null,
        };
      },
      async interruptTurn() {},
      async listModels() {
        return [{
          id: 'gpt-5.4',
          model: 'gpt-5.4',
          displayName: 'GPT-5.4',
          description: '',
          isDefault: true,
          supportedReasoningEfforts: ['medium'],
          defaultReasoningEffort: 'medium',
        }];
      },
      async resumeThread() {
        return {};
      },
    }));

  await plugin.startTurn({
    providerProfile: makeProfile(),
    bridgeSession: makeBridgeSession(),
    sessionSettings: makeSessionSettings({
      personality: 'friendly',
    }),
    event: {
      platform: 'weixin',
      externalScopeId: 'wxid_1',
      text: 'hello',
    },
    inputText: 'hello',
  });

  assert.equal(seenPersonality, 'friendly');
});

test('CodexProviderPlugin maps official four-mode permissions into runtime overrides', async () => {
  const seenThreadStarts: any[] = [];
  const seenTurnStarts: any[] = [];
  const plugin = makePlugin(() => ({
    async start() {},
    async startThread(params: any) {
      seenThreadStarts.push(params);
      return { threadId: 'thread-1', title: 'Thread 1', cwd: params.cwd ?? null };
    },
    async startTurn(params: any) {
      seenTurnStarts.push(params);
      return {
        outputText: 'done',
        threadId: params.threadId,
        title: null,
      };
    },
    async listThreads() {
      return { items: [], nextCursor: null };
    },
    async listModels() {
      return [{
        id: 'gpt-5.5',
        model: 'gpt-5.5',
        displayName: 'GPT-5.5',
        description: '',
        isDefault: true,
        supportedReasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
      }];
    },
  }));

  await plugin.startThread({
    providerProfile: makeProfile(),
    cwd: '/tmp/work',
    title: 'Thread 1',
    metadata: {
      sessionSettings: makeSessionSettings({
        permissionsMode: 'auto-review',
        accessPreset: 'default',
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write',
        approvalsReviewer: 'auto_review',
      }),
    },
  });
  assert.equal(seenThreadStarts[0]?.approvalPolicy, 'on-request');
  assert.equal(seenThreadStarts[0]?.sandboxMode, 'workspace-write');
  assert.deepEqual(seenThreadStarts[0]?.configOverrides, {
    approvals_reviewer: 'auto_review',
  });

  await plugin.startTurn({
    providerProfile: makeProfile(),
    bridgeSession: makeBridgeSession(),
    sessionSettings: makeSessionSettings({
      permissionsMode: 'custom',
      accessPreset: null,
      approvalPolicy: null,
      sandboxMode: null,
      approvalsReviewer: null,
    }),
    event: {
      platform: 'weixin',
      externalScopeId: 'wxid_1',
      text: 'hello',
    },
    inputText: 'hello',
  });
  assert.equal(seenTurnStarts[0]?.approvalPolicy, null);
  assert.equal(seenTurnStarts[0]?.sandboxMode, null);
  assert.equal(seenTurnStarts[0]?.configOverrides, null);
});
