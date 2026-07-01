import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCodexProviderRelayWebSearchExecutor,
  createCodexProviderRelayProviderWebSearchSource,
  type CodexProviderRelayWebSearchExecutorContent,
} from '../src/index.js';

function baseRequest(argumentsValue: Record<string, any>) {
  return {
    toolName: 'web_search' as const,
    relayToolName: 'relay_web_search',
    callId: 'call_search_1',
    arguments: argumentsValue,
    rawArguments: JSON.stringify(argumentsValue),
    model: 'example-model',
    providerKind: 'openai-compatible',
    providerName: 'Example',
  };
}

test('Tavily web_search executor posts Bearer-authenticated search requests', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const executor = createCodexProviderRelayWebSearchExecutor({
    provider: 'tavily',
    apiKey: 'tvly-test',
    maxResults: 2,
    fetchImpl: (async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({
        answer: 'short answer',
        results: [{
          title: 'Result A',
          url: 'https://example.com/a',
          content: 'Snippet A',
          score: 0.9,
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });

  const result = await executor(baseRequest({
    query: 'codex relay',
    search_context_size: 'high',
  }));
  const body = JSON.parse(String(calls[0].init.body));

  assert.equal(calls[0].url, 'https://api.tavily.com/search');
  assert.equal((calls[0].init.headers as any).Authorization, 'Bearer tvly-test');
  assert.equal(body.query, 'codex relay');
  assert.equal(body.search_depth, 'advanced');
  const content = result.content as CodexProviderRelayWebSearchExecutorContent;
  assert.equal(content.provider, 'tavily');
  assert.equal(content.answer, 'short answer');
  assert.equal(content.results[0].url, 'https://example.com/a');
});

test('Brave web_search executor maps web.results into normalized results', async () => {
  const calls: string[] = [];
  const executor = createCodexProviderRelayWebSearchExecutor({
    provider: 'brave',
    apiKey: 'brave-test',
    maxResults: 3,
    country: 'us',
    language: 'en',
    fetchImpl: (async (url, init) => {
      calls.push(String(url));
      assert.equal((init?.headers as any)['X-Subscription-Token'], 'brave-test');
      return new Response(JSON.stringify({
        web: {
          results: [{
            title: 'Brave Result',
            url: 'https://example.com/brave',
            description: 'Brave snippet',
            page_age: '2026-06-07',
          }],
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });

  const result = await executor(baseRequest({ query: 'brave query' }));
  const url = new URL(calls[0]);

  assert.equal(url.origin + url.pathname, 'https://api.search.brave.com/res/v1/web/search');
  assert.equal(url.searchParams.get('q'), 'brave query');
  assert.equal(url.searchParams.get('count'), '3');
  assert.equal(url.searchParams.get('country'), 'US');
  const content = result.content as CodexProviderRelayWebSearchExecutorContent;
  assert.equal(content.provider, 'brave');
  assert.equal(content.results[0].snippet, 'Brave snippet');
});

test('Serper web_search executor maps organic results and answer boxes', async () => {
  const calls: RequestInit[] = [];
  const executor = createCodexProviderRelayWebSearchExecutor({
    provider: 'serper',
    apiKey: 'serper-test',
    maxResults: 1,
    fetchImpl: (async (_url, init) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({
        answerBox: {
          answer: 'answer box',
        },
        organic: [{
          title: 'Serper Result',
          link: 'https://example.com/serper',
          snippet: 'Serper snippet',
          position: 1,
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });

  const result = await executor(baseRequest({ query: 'serper query' }));
  const body = JSON.parse(String(calls[0].body));

  assert.equal((calls[0].headers as any)['X-API-KEY'], 'serper-test');
  assert.equal(body.q, 'serper query');
  assert.equal(body.num, 1);
  const content = result.content as CodexProviderRelayWebSearchExecutorContent;
  assert.equal(content.provider, 'serper');
  assert.equal(content.answer, 'answer box');
  assert.equal(content.results[0].url, 'https://example.com/serper');
});

test('web_search executor rejects offline mode when only live providers are configured', async () => {
  let called = false;
  const executor = createCodexProviderRelayWebSearchExecutor({
    provider: 'tavily',
    apiKey: 'tvly-test',
    fetchImpl: (async () => {
      called = true;
      return new Response('{}');
    }) as typeof fetch,
  });

  await assert.rejects(
    executor(baseRequest({
      query: 'offline query',
      external_web_access: false,
    })),
    /external_web_access=false requires a cache\/offline source/u,
  );
  assert.equal(called, false);
});

test('web_search executor uses cache source when external_web_access is false', async () => {
  let liveCalled = false;
  const executor = createCodexProviderRelayWebSearchExecutor({
    sources: [
      createCodexProviderRelayProviderWebSearchSource({
        provider: 'brave',
        apiKey: 'brave-test',
        fetchImpl: (async () => {
          liveCalled = true;
          return new Response('{}');
        }) as typeof fetch,
      }),
      {
        name: 'cache-index',
        type: 'cache',
        live: false,
        search(request) {
          assert.equal(request.externalWebAccess, false);
          assert.equal(request.returnTokenBudget, 400);
          assert.deepEqual(request.userLocation, {
            type: 'approximate',
            country: 'US',
            city: 'New York',
          });
          return {
            answer: 'cached answer',
            results: [{
              title: 'Cached Result',
              url: 'https://example.com/cache',
              snippet: 'Cached snippet',
              source: 'cache-index',
            }],
            sources: [{
              title: 'Cached Source',
              url: 'https://example.com/cache',
              source: 'cache-index',
            }],
            citations: [{
              type: 'url_citation',
              title: 'Cached Citation',
              url: 'https://example.com/cache',
            }],
          };
        },
      },
    ],
  });

  const result = await executor(baseRequest({
    query: 'cached query',
    external_web_access: false,
    return_token_budget: 400,
    user_location: {
      type: 'approximate',
      country: 'US',
      city: 'New York',
    },
  }));
  const content = result.content as CodexProviderRelayWebSearchExecutorContent;

  assert.equal(liveCalled, false);
  assert.equal(content.provider, 'cache-index');
  assert.equal(content.answer, 'cached answer');
  assert.equal(content.external_web_access, false);
  assert.equal(content.search_context_size, 'medium');
  assert.equal(content.return_token_budget, 400);
  assert.equal(content.sources?.[0].url, 'https://example.com/cache');
  assert.equal(content.citations?.[0].url, 'https://example.com/cache');
});

test('web_search executor passes v2 fields and filters source results', async () => {
  const sourceRequests: any[] = [];
  const executor = createCodexProviderRelayWebSearchExecutor({
    sources: [{
      name: 'custom-live',
      type: 'custom',
      live: true,
      search(request) {
        sourceRequests.push(JSON.parse(JSON.stringify({
          query: request.query,
          searchContextSize: request.searchContextSize,
          filters: request.filters,
          externalWebAccess: request.externalWebAccess,
          returnTokenBudget: request.returnTokenBudget,
        })));
        return {
          results: [{
            title: 'Allowed Result',
            url: 'https://docs.example.com/allowed',
            snippet: 'Allowed snippet',
          }, {
            title: 'Blocked Result',
            url: 'https://blocked.example.com/blocked',
            snippet: 'Blocked snippet',
          }],
        };
      },
    }],
  });

  const result = await executor(baseRequest({
    query: 'filtered query',
    search_context_size: 'high',
    return_token_budget: 900,
    filters: {
      allowed_domains: ['docs.example.com'],
      blocked_domains: ['blocked.example.com'],
    },
  }));
  const content = result.content as CodexProviderRelayWebSearchExecutorContent;

  assert.equal(sourceRequests[0].query, 'filtered query');
  assert.equal(sourceRequests[0].searchContextSize, 'high');
  assert.equal(sourceRequests[0].externalWebAccess, true);
  assert.equal(sourceRequests[0].returnTokenBudget, 900);
  assert.deepEqual(sourceRequests[0].filters.allowedDomains, ['docs.example.com']);
  assert.deepEqual(sourceRequests[0].filters.blockedDomains, ['blocked.example.com']);
  assert.equal(content.results.length, 1);
  assert.equal(content.results[0].url, 'https://docs.example.com/allowed');
  assert.equal(content.sources?.[0].url, 'https://docs.example.com/allowed');
});

test('Tavily web_search source forwards domain filters to provider request', async () => {
  const calls: RequestInit[] = [];
  const executor = createCodexProviderRelayWebSearchExecutor({
    provider: 'tavily',
    apiKey: 'tvly-test',
    fetchImpl: (async (_url, init) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({
        results: [{
          title: 'Allowed Result',
          url: 'https://docs.example.com/allowed',
          content: 'Allowed snippet',
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });

  const result = await executor(baseRequest({
    query: 'domain query',
    filters: {
      allowed_domains: ['https://docs.example.com/path'],
      blocked_domains: ['blocked.example.com'],
    },
  }));
  const body = JSON.parse(String(calls[0].body));
  const content = result.content as CodexProviderRelayWebSearchExecutorContent;

  assert.deepEqual(body.include_domains, ['docs.example.com']);
  assert.deepEqual(body.exclude_domains, ['blocked.example.com']);
  assert.equal(content.results[0].url, 'https://docs.example.com/allowed');
});
