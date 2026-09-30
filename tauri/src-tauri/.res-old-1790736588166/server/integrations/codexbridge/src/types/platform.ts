import type { PlatformScopeRef } from './core.js';

export type InboundAttachmentKind = 'image' | 'voice' | 'file' | 'video';

export interface InboundAttachment {
  kind: InboundAttachmentKind;
  localPath: string;
  fileName?: string | null;
  mimeType?: string | null;
  transcriptText?: string | null;
  durationSeconds?: number | null;
}

export interface InboundTextEvent extends PlatformScopeRef {
  text: string;
  attachments?: InboundAttachment[];
  cwd?: string | null;
  locale?: string | null;
  metadata?: Record<string, unknown>;
}

export interface PlatformDeliveryRequest {
  kind: string;
  payload: Record<string, unknown>;
}

export interface PlatformTextDeliveryResult {
  success: boolean;
  deliveredCount: number;
  deliveredText: string;
  failedIndex: number | null;
  failedText: string;
  error: string;
  errorCode?: number | null;
}

export interface PlatformMediaDeliveryResult {
  success: boolean;
  messageId: string | null;
  sentPath: string;
  sentCaption: string;
  error: string;
  errorCode?: number | null;
}

export interface PlatformStatusInfo {
  data?: Record<string, unknown> | null;
}

export interface TypingDeliveryRequest {
  externalScopeId: string;
  action: 'start' | 'stop';
}

export interface PlatformStreamSession {
  /** Push the latest cumulative text into the same streaming bubble. Returns false when the stream can no longer be updated (caller should fall back to sendText). */
  push(fullText: string): Promise<boolean>;
  /** Finalize the streaming bubble with the final cumulative text. Returns false when finalization failed (caller should fall back to sendText). */
  finish(fullText: string): Promise<boolean>;
  /** Abandon the stream without finalizing (e.g. before falling back to sendText). */
  abort(): Promise<void> | void;
}

export interface PlatformPluginContract {
  id: string;
  displayName: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  normalizeInboundEvent(payload: Record<string, unknown>): InboundTextEvent | null | Promise<InboundTextEvent | null>;
  buildTextDeliveries(params: {
    externalScopeId: string;
    content: string;
  }): PlatformDeliveryRequest[];
  sendText?(params: {
    externalScopeId: string;
    content: string;
  }): Promise<PlatformTextDeliveryResult | null | undefined>;
  /**
   * Begin a real streaming reply bound to the latest inbound message of this scope.
   * Returns null when streaming is unavailable (caller falls back to sendText).
   */
  beginStream?(params: {
    externalScopeId: string;
  }): Promise<PlatformStreamSession | null | undefined> | PlatformStreamSession | null | undefined;
  sendTyping?(params: {
    externalScopeId: string;
    status: 'start' | 'stop';
  }): Promise<void> | void;
  sendMedia?(params: {
    externalScopeId: string;
    filePath: string;
    caption?: string | null;
  }): Promise<PlatformMediaDeliveryResult | null | undefined>;
  getStatus?(params: {
    externalScopeId?: string | null;
  }): Promise<PlatformStatusInfo | null | undefined> | PlatformStatusInfo | null | undefined;
}
