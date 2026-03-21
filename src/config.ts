import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

function optionalFloat(name: string, fallback: number): number {
  const value = process.env[name];
  return value ? parseFloat(value) : fallback;
}

function optionalInt(name: string, fallback: number): number {
  const value = process.env[name];
  return value ? parseInt(value, 10) : fallback;
}

const provider = (process.env.MESSAGING_PROVIDER ?? 'whatsapp') as 'whatsapp' | 'telegram';
const modelProvider = (process.env.MODEL_PROVIDER ?? 'anthropic') as 'anthropic' | 'gemini' | 'gemini-adk';

function requiredForProvider(name: string, forProvider: 'whatsapp' | 'telegram'): string {
  const value = process.env[name];
  if (!value && provider === forProvider) {
    throw new Error(`Missing required environment variable for ${forProvider}: ${name}`);
  }
  return value ?? '';
}

function requiredForModel(name: string, forModel: 'anthropic' | 'gemini'): string {
  const value = process.env[name];
  const activeIsGemini = modelProvider === 'gemini' || modelProvider === 'gemini-adk';
  const needsThisKey = forModel === 'gemini' ? activeIsGemini : modelProvider === forModel;
  if (!value && needsThisKey) {
    throw new Error(`Missing required environment variable for model provider ${forModel}: ${name}`);
  }
  return value ?? '';
}

export const config = {
  betfair: {
    username: required('BETFAIR_USERNAME'),
    password: required('BETFAIR_PASSWORD'),
    appKey: required('BETFAIR_APP_KEY'),
  },
  model: {
    provider: modelProvider,
    // Anthropic settings
    anthropicApiKey: requiredForModel('ANTHROPIC_API_KEY', 'anthropic'),
    anthropicModel: optional('ANTHROPIC_MODEL') ?? 'claude-opus-4-6',
    // Gemini settings
    geminiApiKey: requiredForModel('GEMINI_API_KEY', 'gemini'),
    geminiModel: optional('GEMINI_MODEL') ?? 'gemini-2.5-pro-preview-05-06',
  },
  // Keep for backward compatibility — agent.ts reads config.anthropic.apiKey
  anthropic: {
    apiKey: optional('ANTHROPIC_API_KEY') ?? '',
  },
  messaging: {
    provider,
  },
  // Twilio WhatsApp (default provider)
  whatsapp: {
    accountSid: requiredForProvider('TWILIO_ACCOUNT_SID', 'whatsapp'),
    authToken: requiredForProvider('TWILIO_AUTH_TOKEN', 'whatsapp'),
    // Sandbox number: whatsapp:+14155238886 — replace with your approved number in production
    from: optional('TWILIO_WHATSAPP_FROM') ?? 'whatsapp:+14155238886',
    to: requiredForProvider('WHATSAPP_TO', 'whatsapp'), // e.g. whatsapp:+447700900000
  },
  // Telegram (fallback provider)
  telegram: {
    botToken: requiredForProvider('TELEGRAM_BOT_TOKEN', 'telegram'),
    chatId: requiredForProvider('TELEGRAM_CHAT_ID', 'telegram'),
  },
  betting: {
    liveBetting: process.env.LIVE_BETTING === 'true',
    maxAutoStake: optionalFloat('MAX_AUTO_STAKE', 10),
    maxStakePerBet: optionalFloat('MAX_STAKE_PER_BET', 50),
    approvalTimeoutSeconds: optionalInt('APPROVAL_TIMEOUT_SECONDS', 300),
    hoursAhead: optionalInt('HOURS_AHEAD', 24),
  },
  strategy: {
    // Bankroll at which we transition from Bootstrap → Compound phase (multiple of initial)
    growthTargetMultiplier: optionalFloat('GROWTH_TARGET_MULTIPLIER', 5),
    // Initial bankroll — set this once when you start. Used to detect which phase we are in.
    initialBankroll: optionalFloat('INITIAL_BANKROLL', 0),
    // Halt betting for the session if the bankroll drops this fraction from its session peak
    sessionDrawdownLimit: optionalFloat('SESSION_DRAWDOWN_LIMIT', 0.25),
  },
} as const;
