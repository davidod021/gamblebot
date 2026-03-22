import axios from 'axios';
import { randomUUID } from 'crypto';
import { config } from '../config.js';

const BASE_URL = `https://api.telegram.org/bot${config.telegram.botToken}`;

interface TelegramUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    data: string;
    message: {
      message_id: number;
      chat: { id: number };
    };
  };
}

interface TelegramResponse<T> {
  ok: boolean;
  result: T;
}

async function getUpdates(offset?: number): Promise<TelegramUpdate[]> {
  const response = await axios.get<TelegramResponse<TelegramUpdate[]>>(`${BASE_URL}/getUpdates`, {
    params: { offset, timeout: 0, allowed_updates: ['callback_query'] },
    timeout: 10_000,
  });
  return response.data.result ?? [];
}

async function getLatestUpdateId(): Promise<number | undefined> {
  const updates = await getUpdates();
  if (updates.length === 0) return undefined;
  return updates[updates.length - 1].update_id;
}

async function sendMessageWithKeyboard(
  text: string,
  buttons: Array<{ text: string; callbackData: string }>,
): Promise<number> {
  const response = await axios.post<TelegramResponse<{ message_id: number }>>(`${BASE_URL}/sendMessage`, {
    chat_id: config.telegram.chatId,
    text,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        buttons.map((btn) => ({ text: btn.text, callback_data: btn.callbackData })),
      ],
    },
  });
  return response.data.result.message_id;
}

async function answerCallbackQuery(callbackQueryId: string): Promise<void> {
  await axios.post(`${BASE_URL}/answerCallbackQuery`, { callback_query_id: callbackQueryId });
}

async function editMessageText(messageId: number, text: string): Promise<void> {
  await axios.post(`${BASE_URL}/editMessageText`, {
    chat_id: config.telegram.chatId,
    message_id: messageId,
    text,
    parse_mode: 'Markdown',
  });
}

export interface BetApprovalRequest {
  marketName: string;
  eventName: string;
  selectionName: string;
  side: 'BACK' | 'LAY';
  price: number;
  stake: number;
  reasoning: string;
}

export async function requestBetApproval(bet: BetApprovalRequest): Promise<boolean> {
  const approveId = `approve_${randomUUID()}`;
  const rejectId = `reject_${randomUUID()}`;

  const potentialReturn = bet.side === 'BACK'
    ? (bet.stake * bet.price).toFixed(2)
    : (bet.stake * (bet.price - 1)).toFixed(2);

  const message =
    `🎲 *Bet Approval Required*\n\n` +
    `🏟 *Event:* ${bet.eventName}\n` +
    `🏪 *Market:* ${bet.marketName}\n` +
    `🏃 *Selection:* ${bet.selectionName}\n` +
    `${bet.side === 'BACK' ? '📈 Back (for)' : '📉 Lay (against)'} @ ${bet.price}\n` +
    `💰 *Stake:* £${bet.stake.toFixed(2)}\n` +
    `📊 *Potential ${bet.side === 'BACK' ? 'return' : 'profit'}:* £${potentialReturn}\n\n` +
    `💭 *Reasoning:*\n${bet.reasoning}\n\n` +
    `⏱ Expires in ${Math.round(config.betting.approvalTimeoutSeconds / 60)} minutes`;

  // Snapshot the current update stream before sending our message,
  // so we don't accidentally pick up stale callback queries.
  const baseUpdateId = await getLatestUpdateId();
  let nextOffset = baseUpdateId !== undefined ? baseUpdateId + 1 : undefined;

  const messageId = await sendMessageWithKeyboard(message, [
    { text: '✅ Approve', callbackData: approveId },
    { text: '❌ Reject', callbackData: rejectId },
  ]);

  const deadline = Date.now() + config.betting.approvalTimeoutSeconds * 1000;

  while (Date.now() < deadline) {
    await sleep(2000);

    const updates = await getUpdates(nextOffset);
    for (const update of updates) {
      nextOffset = update.update_id + 1;

      if (!update.callback_query) continue;
      const { data, id } = update.callback_query;

      if (data === approveId) {
        await answerCallbackQuery(id);
        await editMessageText(messageId, message + '\n\n✅ *APPROVED*');
        return true;
      }
      if (data === rejectId) {
        await answerCallbackQuery(id);
        await editMessageText(messageId, message + '\n\n❌ *REJECTED*');
        return false;
      }
    }
  }

  await editMessageText(messageId, message + '\n\n⏱ *TIMED OUT — bet not placed*');
  return false;
}

export async function sendNotification(text: string): Promise<void> {
  try {
    await axios.post(`${BASE_URL}/sendMessage`, {
      chat_id: config.telegram.chatId,
      text,
    });
  } catch (err) {
    // Non-fatal — log but don't crash the agent
    console.error('[Telegram] Failed to send notification:', err instanceof Error ? err.message : err);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
