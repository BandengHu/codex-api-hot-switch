import { WSClient, generateReqId, type WsFrame, type WsFrameHeaders } from '@wecom/aibot-node-sdk';
import { writeSequencedDebugLog } from '../../core/sequenced_stderr.js';
import type {
  InboundTextEvent,
  PlatformDeliveryRequest,
  PlatformPluginContract,
  PlatformTextDeliveryResult,
  PlatformStatusInfo,
  PlatformStreamSession,
} from '../../types/platform.js';

interface WecomPlatformPluginOptions {
  botId: string;
  secret: string;
  corpId?: string | null;
  cwd?: string | null;
  maxMessageLength?: number;
  logger?: {
    debug?: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
}

interface WecomTextBody {
  msgid?: string;
  chatid?: string;
  chattype?: 'single' | 'group';
  from?: {
    userid?: string;
  };
  text?: {
    content?: string;
  };
}

type WecomTextFrame = WsFrame<WecomTextBody>;

interface QueuedEvent {
  id: string;
  event: InboundTextEvent;
}

export class WecomPlatformPlugin implements Pick<
  PlatformPluginContract,
  'id' | 'displayName' | 'start' | 'stop' | 'normalizeInboundEvent' | 'buildTextDeliveries' | 'sendText' | 'beginStream' | 'sendTyping' | 'getStatus'
> {
  constructor({
    botId,
    secret,
    corpId = null,
    cwd = null,
    maxMessageLength = 4000,
    logger = {},
  }: WecomPlatformPluginOptions) {
    this.id = 'wecom';
    this.displayName = 'Enterprise WeChat';
    this.botId = normalizeText(botId);
    this.secret = normalizeText(secret);
    this.corpId = normalizeText(corpId);
    this.cwd = normalizeText(cwd);
    this.maxMessageLength = Math.max(200, Number(maxMessageLength) || 4000);
    this.logger = logger;
    this.client = null;
    this.queue = [];
    this.waiters = [];
    this.nextEventId = 0;
    this.committedCursor = 0;
    this.running = false;
    this.connected = false;
    this.lastMessageAt = null;
    this.lastError = null;
    this.latestFrameByScope = new Map();
  }

  id: string;
  displayName: string;
  botId: string;
  secret: string;
  corpId: string;
  cwd: string;
  maxMessageLength: number;
  logger: WecomPlatformPluginOptions['logger'];
  client: WSClient | null;
  queue: QueuedEvent[];
  waiters: Array<() => void>;
  nextEventId: number;
  committedCursor: number;
  running: boolean;
  connected: boolean;
  lastMessageAt: string | null;
  lastError: string | null;
  // Latest inbound frame per scope, required for passive streaming replies (replyStream/req_id).
  latestFrameByScope: Map<string, { frame: WsFrameHeaders; capturedAt: number }>;

  async start() {
    if (this.running && this.client) return;
    if (!this.botId) throw new Error('Missing wecom bot id');
    if (!this.secret) throw new Error('Missing wecom secret');

    const client = new WSClient({
      botId: this.botId,
      secret: this.secret,
      logger: {
        debug: (message: unknown, ...args: unknown[]) => this.log('debug', message, ...args),
        info: (message: unknown, ...args: unknown[]) => this.log('info', message, ...args),
        warn: (message: unknown, ...args: unknown[]) => this.log('warn', message, ...args),
        error: (message: unknown, ...args: unknown[]) => this.log('error', message, ...args),
      },
    });

    client.on('message.text', (frame: WecomTextFrame) => {
      void this.enqueueTextFrame(frame).catch((error) => {
        this.lastError = formatError(error);
        this.log('error', 'message.text failed', error);
      });
    });
    client.on('connected', () => {
      this.log('info', 'connected');
    });
    client.on('authenticated', () => {
      this.connected = true;
      this.lastError = null;
      this.log('info', 'authenticated');
    });
    client.on('error', (error: unknown) => {
      this.lastError = formatError(error);
      this.log('error', 'client error', error);
    });
    client.on('reconnecting', (attempt: number) => {
      this.connected = false;
      this.log('warn', 'reconnecting', attempt);
    });
    client.on('disconnected', (reason: string) => {
      this.connected = false;
      this.log('warn', 'client closed', reason);
    });

    this.client = client;
    this.running = true;
    client.connect();
  }

  async stop() {
    this.running = false;
    this.connected = false;
    this.wakePollers();
    if (this.client) {
      this.client.disconnect();
      this.client.removeAllListeners();
      this.client = null;
    }
  }

  async normalizeInboundEvent(payload: Record<string, unknown>): Promise<InboundTextEvent | null> {
    const frame = payload as unknown as WecomTextFrame;
    return this.frameToEvent(frame);
  }

  buildTextDeliveries({ externalScopeId, content }: { externalScopeId: string; content: string }): PlatformDeliveryRequest[] {
    return splitText(formatMarkdown(content), this.maxMessageLength).map((text) => ({
      kind: 'wecom.sendmessage',
      payload: {
        chatId: externalScopeId,
        message: markdown(text),
      },
    }));
  }

  async pollOnce({ syncCursor = null }: { syncCursor?: string | null } = {}) {
    const start = Number(syncCursor ?? this.committedCursor) || 0;
    if (this.running && !this.queue.some((item) => Number(item.id) > start)) {
      await this.waitForNextEvent(1000);
    }
    const events = this.queue
      .filter((item) => Number(item.id) > start)
      .map((item) => item.event);
    const cursor = this.queue.length > 0
      ? this.queue[this.queue.length - 1].id
      : String(start);
    return { syncCursor: cursor, events };
  }

  async commitSyncCursor(syncCursor: string | null | undefined) {
    const cursor = Number(syncCursor ?? 0) || 0;
    if (cursor <= 0) return;
    this.committedCursor = Math.max(this.committedCursor, cursor);
    while (this.queue.length > 0 && Number(this.queue[0].id) <= this.committedCursor) {
      this.queue.shift();
    }
  }

  async sendText({ externalScopeId, content }: { externalScopeId: string; content: string }): Promise<PlatformTextDeliveryResult> {
    const client = this.client;
    const chunks = splitText(formatMarkdown(content), this.maxMessageLength);
    const deliveredTexts: string[] = [];
    if (!client || !this.running) {
      return {
        success: false,
        deliveredCount: 0,
        deliveredText: '',
        failedIndex: 0,
        failedText: chunks[0] ?? String(content ?? ''),
        error: 'Enterprise WeChat bot is not running',
      };
    }

    for (let index = 0; index < chunks.length; index += 1) {
      const text = chunks[index];
      try {
        await client.sendMessage(externalScopeId, markdown(text));
        deliveredTexts.push(text);
      } catch (error) {
        const message = formatError(error);
        this.lastError = message;
        return {
          success: false,
          deliveredCount: deliveredTexts.length,
          deliveredText: deliveredTexts.join('\n'),
          failedIndex: index,
          failedText: text,
          error: message,
        };
      }
    }

    return {
      success: true,
      deliveredCount: deliveredTexts.length,
      deliveredText: deliveredTexts.join('\n'),
      failedIndex: null,
      failedText: '',
      error: '',
    };
  }

  async sendTyping() {
    // Enterprise WeChat application bot longlink does not need a typing bridge for v1.
  }

  async beginStream({ externalScopeId }: { externalScopeId: string }): Promise<PlatformStreamSession | null> {
    const client = this.client;
    const captured = this.latestFrameByScope.get(externalScopeId);
    if (!client || !this.running || !captured?.frame?.headers?.req_id) {
      return null;
    }
    const frame = captured.frame;
    const streamId = generateReqId('stream');
    const maxBytes = 20480;
    let aborted = false;
    let finished = false;
    let lastSentContent = '';

    const clampContent = (text: string) => {
      const normalized = formatMarkdown(text);
      if (Buffer.byteLength(normalized, 'utf8') <= maxBytes) return normalized;
      // Keep the tail so the freshest output stays visible inside the single bubble.
      let out = normalized;
      while (Buffer.byteLength(out, 'utf8') > maxBytes && out.length > 0) {
        out = out.slice(Math.ceil(out.length / 64));
      }
      return out;
    };

    const session: PlatformStreamSession = {
      push: async (fullText: string) => {
        if (aborted || finished) return false;
        const content = clampContent(fullText);
        if (!content || content === lastSentContent) return true;
        try {
          // Non-blocking: skip intermediate frames when the previous ack is still pending.
          const result = await client.replyStreamNonBlocking(frame, streamId, content, false);
          if (result !== 'skipped') lastSentContent = content;
          return true;
        } catch (error) {
          this.lastError = formatError(error);
          this.log('warn', 'replyStream push failed', error);
          aborted = true;
          return false;
        }
      },
      finish: async (fullText: string) => {
        if (aborted) return false;
        if (finished) return true;
        const content = clampContent(fullText);
        try {
          await client.replyStream(frame, streamId, content || '(empty)', true);
          finished = true;
          lastSentContent = content;
          return true;
        } catch (error) {
          this.lastError = formatError(error);
          this.log('warn', 'replyStream finish failed', error);
          aborted = true;
          return false;
        }
      },
      abort: () => {
        aborted = true;
      },
    };
    return session;
  }

  getStatus(): PlatformStatusInfo {
    return {
      data: {
        botId: this.botId,
        corpId: this.corpId,
        running: this.running,
        connected: this.connected,
        queuedEvents: this.queue.length,
        lastMessageAt: this.lastMessageAt,
        lastError: this.lastError,
      },
    };
  }

  private async enqueueTextFrame(frame: WecomTextFrame) {
    const event = await this.frameToEvent(frame);
    if (!event) return;
    if (frame?.headers?.req_id) {
      this.latestFrameByScope.set(event.externalScopeId, {
        frame: { headers: frame.headers },
        capturedAt: Date.now(),
      });
    }
    const id = String(++this.nextEventId);
    this.queue.push({ id, event });
    this.lastMessageAt = new Date().toISOString();
    this.wakePollers();
    this.debug('accept_message', {
      id,
      chatId: event.externalScopeId,
      text: preview(event.text),
    });
  }

  private async frameToEvent(frame: WecomTextFrame): Promise<InboundTextEvent | null> {
    const body = frame?.body ?? {};
    const text = normalizeText(body.text?.content);
    const userId = normalizeText(body.from?.userid);
    const chatId = normalizeText(body.chatid) || userId;
    if (!text || !chatId) return null;
    const chatType = body.chattype === 'group' ? 'group' : 'single';
    return {
      platform: this.id,
      externalScopeId: chatId,
      text,
      cwd: this.cwd || null,
      metadata: {
        wecom: {
          corpId: this.corpId,
          botId: this.botId,
          chatId,
          chatType,
          userId,
          messageId: normalizeText(body.msgid),
        },
      },
    };
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: unknown, ...args: unknown[]) {
    this.logger?.[level]?.(message, ...args);
    if (level === 'error') this.lastError = formatError(message);
    this.debug(`sdk_${level}`, { message: String(message), args: args.map(formatError) });
  }

  private debug(event: string, payload: unknown) {
    writeSequencedDebugLog('wecom-debug', event, payload, { envVar: 'CODEXBRIDGE_DEBUG_WECOM' });
  }

  private waitForNextEvent(timeoutMs: number) {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.waiters = this.waiters.filter((waiter) => waiter !== finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.waiters.push(finish);
    });
  }

  private wakePollers() {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }
}

function markdown(content: string) {
  return {
    msgtype: 'markdown',
    markdown: {
      content,
    },
  } as const;
}

function formatMarkdown(content: string) {
  return String(content ?? '').replace(/\r\n/g, '\n').trim() || '(empty)';
}

function splitText(content: string, maxLength: number) {
  const text = formatMarkdown(content);
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += maxLength) {
    chunks.push(text.slice(index, index + maxLength));
  }
  return chunks;
}

function normalizeText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function formatError(error: unknown) {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

function preview(value: string, maxLength = 120) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}
