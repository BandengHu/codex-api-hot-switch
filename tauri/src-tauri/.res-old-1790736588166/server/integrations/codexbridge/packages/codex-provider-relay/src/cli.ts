#!/usr/bin/env node

import {
  createCodexProviderRelayStandaloneServerFromEnv,
  resolveCodexProviderRelayStandaloneServerEnv,
} from './server/standalone_server.js';

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const env = resolveCodexProviderRelayStandaloneServerEnv({
    env: {
      ...process.env,
      ...(args.trace ? { CODEX_PROVIDER_RELAY_TRACE: '1' } : {}),
    },
    envFilePath: args.envFilePath,
  });
  const { config, server } = createCodexProviderRelayStandaloneServerFromEnv(env);
  await server.start();

  console.log('Codex Provider Relay standalone server started.');
  console.log(`Provider preset: ${config.presetId}`);
  console.log(`Provider: ${config.providerName} (${config.providerKind})`);
  console.log(`Upstream base URL: ${config.upstreamBaseUrl}`);
  console.log(`Default model: ${config.defaultModel}`);
  console.log(`Local base URL: ${server.baseUrl}`);
  console.log(`Model catalog source: ${config.modelCatalogSource}`);
  console.log(`Trace mode: ${config.traceMode}`);
  if (args.envFilePath || env.CODEX_PROVIDER_RELAY_ENV_FILE || env.CODEX_GATEWAY_ENV_FILE) {
    console.log(`Env file: ${args.envFilePath ?? env.CODEX_PROVIDER_RELAY_ENV_FILE ?? env.CODEX_GATEWAY_ENV_FILE}`);
  }
  console.log('Routes: GET /models (alias /v1/models), POST /responses (alias /v1/responses), POST /responses/compact (alias /v1/responses/compact)');
  console.log('Press Ctrl+C to stop.');

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, stopping Codex Provider Relay standalone server...`);
    await server.stop();
    process.exit(0);
  };

  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

function parseCliArgs(argv: string[]): {
  envFilePath: string | null;
  help: boolean;
  trace: boolean;
} {
  let envFilePath: string | null = null;
  let help = false;
  let trace = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }
    if (arg === '--env-file') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('--env-file requires a path argument.');
      }
      envFilePath = next;
      index += 1;
      continue;
    }
    if (arg === '--trace') {
      trace = true;
      continue;
    }
    throw new Error(`Unknown codex-provider-relay-server argument: ${arg}`);
  }

  return { envFilePath, help, trace };
}

function printHelp(): void {
  console.log([
    'Usage: codex-provider-relay-server [--env-file <path>] [--trace]',
    '',
    'Internal-only launcher for the Codex Provider Relay local Responses adapter server.',
    '',
    'Options:',
    '  --env-file <path>  Load dotenv-style defaults before resolving provider env',
    '  --trace            Emit structured trace events to stderr as NDJSON',
    '  -h, --help         Show this help message',
  ].join('\n'));
}
