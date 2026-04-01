import axios from 'axios';
import { config } from '../config.js';
import type { BetApprovalRequest } from './telegram.js';

// Re-export so callers can use either module's type
export type { BetApprovalRequest } from './telegram.js';

const TWILIO_BASE = `https://api.twilio.com/2010-04-01/Accounts/${config.whatsapp.accountSid}`;

const twilioAuth = {
  username: config.whatsapp.accountSid,
  password: config.whatsapp.authToken,
};

export interface TwilioMessage {
  sid: string;
  body: string;
  direction: 'inbound' | 'outbound-api' | 'outbound-reply';
  date_sent: string; // RFC 2822
  from: string;
  to: string;
  status: string;
}

interface TwilioMessagesResponse {
  messages: TwilioMessage[];
}

async function sendMessage(body: string): Promise<string> {
  const params = new URLSearchParams({
    From: config.whatsapp.from,
    To: config.whatsapp.to,
    Body: body,
  });

  const response = await axios.post<{ sid: string }>(
    `${TWILIO_BASE}/Messages.json`,
    params.toString(),
    {
      auth: twilioAuth,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    },
  );

  return response.data.sid;
}

export async function getInboundMessagesSince(since: Date): Promise<TwilioMessage[]> {
  // Twilio's DateSent filter only accepts a date (YYYY-MM-DD), so we fetch
  // that day's messages and filter by exact time client-side.
  const dateSent = since.toISOString().split('T')[0];

  const response = await axios.get<TwilioMessagesResponse>(
    `${TWILIO_BASE}/Messages.json`,
    {
      auth: twilioAuth,
      params: {
        From: config.whatsapp.to,   // inbound: user's number is the sender
        To: config.whatsapp.from,   // inbound: our Twilio number is the recipient
        DateSent: dateSent,
        PageSize: 20,
      },
    },
  );

  return (response.data.messages ?? []).filter(
    (m) => m.direction === 'inbound' && new Date(m.date_sent) > since,
  );
}

export async function requestBetApproval(bet: BetApprovalRequest): Promise<boolean> {
  const potentialReturn =
    bet.side === 'BACK'
      ? (bet.stake * bet.price).toFixed(2)
      : (bet.stake * (bet.price - 1)).toFixed(2);

  const message =
    `🎲 *Bet Approval Required*\n\n` +
    `🏟 Event: ${bet.eventName}\n` +
    `🏪 Market: ${bet.marketName}\n` +
    `🏃 Selection: ${bet.selectionName}\n` +
    `${bet.side === 'BACK' ? '📈 Back (for)' : '📉 Lay (against)'} @ ${bet.price}\n` +
    `💰 Stake: £${bet.stake.toFixed(2)}\n` +
    `📊 ${bet.side === 'BACK' ? 'Return' : 'Profit'}: £${potentialReturn}\n\n` +
    `💭 ${bet.reasoning}\n\n` +
    `⏱ Reply *YES* to approve or *NO* to reject\n` +
    `(Expires in ${Math.round(config.betting.approvalTimeoutSeconds / 60)} minutes)`;

  await sendMessage(message);

  const requestedAt = new Date();
  const deadline = Date.now() + config.betting.approvalTimeoutSeconds * 1000;
  const seen = new Set<string>();

  while (Date.now() < deadline) {
    await sleep(5000);

    const messages = await getInboundMessagesSince(requestedAt);

    for (const msg of messages) {
      if (seen.has(msg.sid)) continue;
      seen.add(msg.sid);

      const reply = msg.body.trim().toUpperCase();
      if (reply === 'YES' || reply === 'APPROVE') {
        await sendMessage(`✅ Bet approved: ${bet.selectionName} (${bet.side} @ ${bet.price}, £${bet.stake.toFixed(2)})`);
        return true;
      }
      if (reply === 'NO' || reply === 'REJECT') {
        await sendMessage(`❌ Bet rejected: ${bet.selectionName}`);
        return false;
      }
    }
  }

  await sendMessage(`⏱ Approval timed out — bet not placed: ${bet.selectionName}`);
  return false;
}

export async function sendNotification(text: string): Promise<void> {
  try {
    await sendMessage(text);
  } catch (err) {
    console.error('[WhatsApp] Failed to send notification:', err instanceof Error ? err.message : err);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
