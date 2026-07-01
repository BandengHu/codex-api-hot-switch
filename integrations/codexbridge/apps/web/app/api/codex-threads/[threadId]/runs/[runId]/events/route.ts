import { getReplyRunManager, type ReplyRunEvent } from '@/server/reply-run-manager';

export const dynamic = 'force-dynamic';

const encoder = new TextEncoder();

function writeEvent(controller: ReadableStreamDefaultController<Uint8Array>, event: ReplyRunEvent) {
  controller.enqueue(encoder.encode(`event: ${event.type}\n`));
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(event.run)}\n\n`));
}

export async function GET(
  request: Request,
  context: { params: Promise<{ threadId: string; runId: string }> },
) {
  const { runId, threadId } = await context.params;
  const manager = getReplyRunManager();
  const snapshot = manager.getSnapshot(runId);
  if (!snapshot || snapshot.sourceThreadId !== threadId) {
    return new Response('not_found', { status: 404 });
  }

  let unsubscribe: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let aborted = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (aborted) {
          return;
        }
        aborted = true;
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        unsubscribe?.();
        unsubscribe = null;
        try {
          controller.close();
        } catch {
          // ignore closed stream
        }
      };

      const onAbort = () => close();
      request.signal.addEventListener('abort', onAbort, { once: true });

      writeEvent(controller, { type: 'snapshot', run: snapshot });
      if (snapshot.status === 'completed' || snapshot.status === 'failed') {
        close();
        return;
      }

      unsubscribe = manager.subscribe(runId, (event) => {
        writeEvent(controller, event);
        if (event.run.status === 'completed' || event.run.status === 'failed') {
          close();
        }
      });

      heartbeat = setInterval(() => {
        if (aborted) {
          return;
        }
        controller.enqueue(encoder.encode(': ping\n\n'));
      }, 15_000);
    },
    cancel() {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      unsubscribe?.();
      unsubscribe = null;
      aborted = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    },
  });
}
