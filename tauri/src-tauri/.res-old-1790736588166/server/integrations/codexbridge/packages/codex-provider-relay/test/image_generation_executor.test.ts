import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCodexProviderRelayImageGenerationExecutor,
  createCodexProviderRelayOpenAICompatibleImageGenerationProvider,
  type CodexProviderRelayImageGenerationExecutorContent,
} from '../src/index.js';

function baseRequest(argumentsValue: Record<string, any>) {
  return {
    toolName: 'image_generation' as const,
    relayToolName: 'relay_image_generation',
    callId: 'call_image_1',
    arguments: argumentsValue,
    rawArguments: JSON.stringify(argumentsValue),
    model: 'example-model',
    providerKind: 'openai-compatible',
    providerName: 'Example',
  };
}

test('image_generation executor sends normalized prompt and options to provider', async () => {
  const seen: any[] = [];
  const executor = createCodexProviderRelayImageGenerationExecutor({
    generate(request) {
      seen.push(JSON.parse(JSON.stringify({
        prompt: request.prompt,
        size: request.size,
        quality: request.quality,
        background: request.background,
        output_format: request.output_format,
        n: request.n,
        toolName: request.toolRequest.toolName,
      })));
      return [{
        b64_json: 'aW1hZ2U=',
        mime_type: 'image/png',
        revised_prompt: 'A small bridge icon.',
      }];
    },
  });

  const result = await executor(baseRequest({
    prompt: 'A bridge icon',
    size: '1024x1024',
    quality: 'high',
    background: 'transparent',
    output_format: 'png',
    n: 1,
  }));
  const content = result.content as CodexProviderRelayImageGenerationExecutorContent;

  assert.deepEqual(seen[0], {
    prompt: 'A bridge icon',
    size: '1024x1024',
    quality: 'high',
    background: 'transparent',
    output_format: 'png',
    n: 1,
    toolName: 'image_generation',
  });
  assert.equal(content.images[0].b64_json, 'aW1hZ2U=');
  assert.equal(content.images[0].mime_type, 'image/png');
  assert.equal(content.images[0].revised_prompt, 'A small bridge icon.');
  assert.equal(result.metadata?.imageCount, 1);
});

test('OpenAI-compatible image provider posts image generation requests', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const provider = createCodexProviderRelayOpenAICompatibleImageGenerationProvider({
    apiKey: 'img-test',
    model: 'gpt-image-1',
    endpoint: 'https://example.test/v1/images/generations',
    fetchImpl: (async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({
        data: [{
          b64_json: 'aW1hZ2U=',
          revised_prompt: 'A revised prompt.',
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });

  const images = await provider({
    prompt: 'Generate a relay logo',
    size: '1024x1024',
    quality: 'medium',
    background: 'opaque',
    output_format: 'webp',
    n: 2,
    toolRequest: baseRequest({ prompt: 'Generate a relay logo' }),
  });
  const body = JSON.parse(String(calls[0].init.body));

  assert.equal(calls[0].url, 'https://example.test/v1/images/generations');
  assert.equal((calls[0].init.headers as any).Authorization, 'Bearer img-test');
  assert.equal(body.model, 'gpt-image-1');
  assert.equal(body.prompt, 'Generate a relay logo');
  assert.equal(body.output_format, 'webp');
  assert.equal(images[0].b64_json, 'aW1hZ2U=');
});

test('image_generation executor requires an explicit provider', () => {
  assert.throws(() => createCodexProviderRelayImageGenerationExecutor({} as any), /requires an explicit/u);
});
