import axios from 'axios';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { telegramDispatcher } from '../messaging/telegram-dispatcher.js';

const BASE_URL = `https://api.telegram.org/bot${config.telegram.botToken}`;

async function sendMessageWithKeyboard(
  text: string,
  buttons: Array<{ text: string; callbackData: string }>,
): Promise<number> {
  const response = await axios.post<{ ok: boolean; result: { message_id: number } }>(`${BASE_URL}/sendMessage`, {
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

  const potentialReturn =
    bet.side === 'BACK'
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

  // Ensure the dispatcher has drained stale updates and is polling
  await telegramDispatcher.init();
  telegramDispatcher.start();

  // Register approval BEFORE sending the message to avoid missing rapid clicks
  const approvalPromise = telegramDispatcher.registerApproval(approveId, rejectId);

  const messageId = await sendMessageWithKeyboard(message, [
    { text: '✅ Approve', callbackData: approveId },
    { text: '❌ Reject', callbackData: rejectId },
  ]);

  const result = await Promise.race([
    approvalPromise,
    sleep(config.betting.approvalTimeoutSeconds * 1000).then(() => null as null),
  ]);

  if (result === null) {
    telegramDispatcher.cancelApproval(approveId, rejectId);
    await editMessageText(messageId, message + '\n\n⏱ *TIMED OUT — bet not placed*');
    return false;
  }

  await editMessageText(messageId, message + (result ? '\n\n✅ *APPROVED*' : '\n\n❌ *REJECTED*'));
  return result;
}

export async function sendNotification(text: string): Promise<void> {
  try {
    await axios.post(`${BASE_URL}/sendMessage`, {
      chat_id: config.telegram.chatId,
      text,
    });
  } catch (err) {
    console.error('[Telegram] Failed to send notification:', err instanceof Error ? err.message : err);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
