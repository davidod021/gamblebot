/**
 * Unified messaging listener for continuous mode.
 *
 * Polls the configured messaging provider for new user messages and calls
 * onPrompt() with any message that is not a bet approval response (YES/NO).
 *
 * WhatsApp: polls Twilio every 15 seconds.
 * Telegram: subscribes to the centralized update dispatcher.
 */

import { config } from '../config.js';
import { telegramDispatcher } from './telegram-dispatcher.js';
import { getInboundMessagesSince } from '../approval/whatsapp.js';

// Words that are clearly bet approval responses — ignore them so the agent
// isn't triggered by a user replying to an approval request.
const APPROVAL_WORDS = new Set(['YES', 'NO', 'APPROVE', 'REJECT']);

function isApprovalResponse(text: string): boolean {
  return APPROVAL_WORDS.has(text.trim().toUpperCase());
}

/**
 * Start listening for user-initiated prompts from the messaging app.
 * @param onPrompt Called with the message text whenever a non-approval message arrives.
 */
export function startMessagingListener(onPrompt: (prompt: string) => void): void {
  if (config.messaging.provider === 'telegram') {
    startTelegramListener(onPrompt);
  } else {
    startWhatsAppListener(onPrompt);
  }
}

function startTelegramListener(onPrompt: (prompt: string) => void): void {
  // The dispatcher must be running so it can deliver text messages
  void telegramDispatcher.init().then(() => {
    telegramDispatcher.start();
  });

  telegramDispatcher.onMessage((text) => {
    if (isApprovalResponse(text)) return;
    console.log(`[Listener] Telegram message: "${text.slice(0, 120)}"`);
    onPrompt(text.trim());
  });

  console.log('[Listener] Telegram message listener active.');
}

function startWhatsAppListener(onPrompt: (prompt: string) => void): void {
  let lastCheckedAt = new Date();
  const seen = new Set<string>();

  const poll = async (): Promise<void> => {
    try {
      const messages = await getInboundMessagesSince(lastCheckedAt);
      lastCheckedAt = new Date();

      for (const msg of messages) {
        if (seen.has(msg.sid)) continue;
        seen.add(msg.sid);

        if (isApprovalResponse(msg.body)) continue;

        console.log(`[Listener] WhatsApp message: "${msg.body.slice(0, 120)}"`);
        onPrompt(msg.body.trim());
      }
    } catch (err) {
      console.error('[Listener] WhatsApp poll error:', err instanceof Error ? err.message : err);
    }
    setTimeout(() => { void poll(); }, 15_000);
  };

  // Start polling after a short delay to let the app fully initialise
  setTimeout(() => { void poll(); }, 15_000);
  console.log('[Listener] WhatsApp message listener active (polling every 15s).');
}
