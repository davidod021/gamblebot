/**
 * Messaging provider abstraction.
 * Defaults to WhatsApp (Twilio). Set MESSAGING_PROVIDER=telegram to use Telegram instead.
 */
import { config } from '../config.js';
import * as telegram from './telegram.js';
import * as whatsapp from './whatsapp.js';

export type { BetApprovalRequest } from './telegram.js';

function provider() {
  return config.messaging.provider === 'telegram' ? telegram : whatsapp;
}

export function sendNotification(text: string): Promise<void> {
  return provider().sendNotification(text);
}

export function requestBetApproval(
  bet: Parameters<typeof telegram.requestBetApproval>[0],
): Promise<boolean> {
  return provider().requestBetApproval(bet);
}
