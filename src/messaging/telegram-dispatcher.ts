/**
 * Central Telegram update dispatcher.
 *
 * Runs a single polling loop for all Telegram updates and routes them to:
 *  - Registered approval handlers (callback_query events from inline keyboard buttons)
 *  - Message handlers (regular text messages from the configured chat)
 *
 * This prevents two concurrent callers from racing over the global update offset.
 */

import axios from 'axios';
import { config } from '../config.js';

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    data: string;
    message: { message_id: number; chat: { id: number } };
  };
}

type MessageHandler = (text: string) => void;

interface PendingApproval {
  approveId: string;
  rejectId: string;
  resolve: (approved: boolean) => void;
}

class TelegramUpdateDispatcher {
  private nextOffset: number | undefined;
  private pendingApprovals: PendingApproval[] = [];
  private messageHandlers: MessageHandler[] = [];
  private loopRunning = false;
  private initialized = false;

  /**
   * Drain any stale updates so we never act on old callbacks.
   * Idempotent — safe to call multiple times.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const updates = await this.fetchUpdates(undefined);
    if (updates.length > 0) {
      this.nextOffset = updates[updates.length - 1].update_id + 1;
    }
  }

  /** Start the background polling loop. Idempotent. */
  start(): void {
    if (this.loopRunning) return;
    this.loopRunning = true;
    void this.loop();
    console.log('[Telegram] Update dispatcher started.');
  }

  private async loop(): Promise<void> {
    while (this.loopRunning) {
      try {
        const updates = await this.fetchUpdates(this.nextOffset);
        for (const update of updates) {
          this.nextOffset = update.update_id + 1;
          this.dispatch(update);
        }
      } catch {
        // Transient network errors — ignore and retry
      }
      await sleep(2000);
    }
  }

  private dispatch(update: TelegramUpdate): void {
    if (update.callback_query) {
      const { data, id: queryId } = update.callback_query;
      const idx = this.pendingApprovals.findIndex(
        (p) => p.approveId === data || p.rejectId === data,
      );
      if (idx !== -1) {
        const pending = this.pendingApprovals.splice(idx, 1)[0];
        this.ackCallback(queryId);
        pending.resolve(data === pending.approveId);
      }
      return;
    }

    if (update.message?.text) {
      const chatId = update.message.chat.id;
      if (String(chatId) === String(config.telegram.chatId)) {
        for (const handler of this.messageHandlers) {
          try {
            handler(update.message.text);
          } catch (err) {
            console.error('[Telegram] Message handler error:', err instanceof Error ? err.message : err);
          }
        }
      }
    }
  }

  private ackCallback(queryId: string): void {
    const url = `https://api.telegram.org/bot${config.telegram.botToken}/answerCallbackQuery`;
    void axios.post(url, { callback_query_id: queryId }).catch(() => {});
  }

  private async fetchUpdates(offset: number | undefined): Promise<TelegramUpdate[]> {
    const url = `https://api.telegram.org/bot${config.telegram.botToken}/getUpdates`;
    const res = await axios.get<{ ok: boolean; result: TelegramUpdate[] }>(url, {
      params: { offset, timeout: 0, allowed_updates: ['message', 'callback_query'] },
      timeout: 10_000,
    });
    return res.data.result ?? [];
  }

  /**
   * Register a pending bet approval.
   * Returns a Promise that resolves to true (approved) or false (rejected).
   * The caller is responsible for handling the timeout.
   */
  registerApproval(approveId: string, rejectId: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.pendingApprovals.push({ approveId, rejectId, resolve });
    });
  }

  /** Remove a registered approval — call on timeout to avoid memory leaks. */
  cancelApproval(approveId: string, rejectId: string): void {
    const idx = this.pendingApprovals.findIndex(
      (p) => p.approveId === approveId && p.rejectId === rejectId,
    );
    if (idx !== -1) this.pendingApprovals.splice(idx, 1);
  }

  /**
   * Register a handler for incoming text messages from the configured chat.
   * Returns an unsubscribe function.
   */
  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.push(handler);
    return () => {
      this.messageHandlers = this.messageHandlers.filter((h) => h !== handler);
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const telegramDispatcher = new TelegramUpdateDispatcher();
