# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Run directly with tsx (no compile step, for development)
npm run build        # Compile TypeScript to dist/
npm start            # Run compiled output
npm run typecheck    # Type-check without emitting
```

## Architecture

This is an autonomous AI betting agent that analyses British sports markets on the Betfair exchange and identifies value bets. The AI model provider is swappable via `MODEL_PROVIDER`.

### Model abstraction (`src/model/`)

- `types.ts` — Provider-agnostic interfaces: `ModelSession`, `ToolDefinition`, `ContentBlock`, `ModelResponse`
- `anthropic.ts` — `AnthropicSession`: uses `claude-opus-4-6` (or `ANTHROPIC_MODEL`) with `thinking: { type: 'adaptive' }` and the `web_search_20260209` server-side tool
- `gemini.ts` — `GeminiSession`: uses Gemini 2.5 Pro (or `GEMINI_MODEL`) with native function calling. Cannot mix Google Search grounding with function declarations in the same request.
- `gemini-adk.ts` — `GeminiAdkSession`: uses Google ADK (`@google/adk`) with `GOOGLE_SEARCH` as a built-in tool alongside Betfair `FunctionTool`s. ADK handles the full tool-dispatch loop internally so `agent.ts` always receives `end_turn`. Use `MODEL_PROVIDER=gemini-adk`.
- `index.ts` — `createSession(systemPrompt, tools)` factory; selects provider from `MODEL_PROVIDER` env var

Both sessions maintain their own native message history internally to avoid lossy cross-format conversion (critical: Anthropic thinking blocks need their `signature` field preserved for multi-turn conversations).

### Entry point & agent loop (`src/index.ts` → `src/agent.ts`)

`runAgent()` drives a provider-agnostic agentic loop using `ModelSession`:
- `tool_use` → execute client-side Betfair tools, feed results back via `session.submitToolResults()`
- `pause_turn` → Anthropic server-side web search hit iteration limit, re-send via `session.resume()`
- `end_turn` → done, send summary via messaging provider

### Betfair API (`src/betfair/`)

- `auth.ts` — Interactive login to `identitysso.betfair.com`. Sessions last 4 hours; auto-renews at 3.5 hours.
- `client.ts` — Thin wrappers around the Betfair Exchange REST API v1.0 (`api.betfair.com/exchange/betting/rest/v1.0`).
- `types.ts` — TypeScript interfaces for all Betfair request/response shapes.

All API calls require `X-Application` (App Key) and `X-Authentication` (session token) headers.

### Approval flow (`src/approval/`)

The provider is selected by `MESSAGING_PROVIDER` (default `whatsapp`). All other code imports from `src/approval/index.ts` which routes to the active provider.

**WhatsApp via Twilio (`src/approval/whatsapp.ts`) — default**
1. `requestBetApproval()` sends a formatted WhatsApp message via the Twilio API.
2. Polls Twilio's inbound message list every 5 seconds for a `YES`/`NO` reply from the user.
3. Times out after `APPROVAL_TIMEOUT_SECONDS` (default 5 min) — bet is not placed on timeout.

**Telegram (`src/approval/telegram.ts`) — fallback**
1. Sends a message with Approve/Reject inline keyboard buttons.
2. Polls `getUpdates` every 2 seconds, tracking update offset to avoid stale callbacks.
3. Same timeout behaviour.

### Tool execution (`src/tools/betfair-tools.ts`)

`executeTool(name, input)` dispatches to the five Betfair tools:
- `list_upcoming_markets` — `listMarketCatalogue` filtered to GB, British sport IDs (Football=1, Cricket=4, Rugby Union=5, Rugby League=9)
- `get_market_odds` — `listMarketBook` with best 3 prices depth
- `get_account_balance` — `getAccountFunds`
- `get_current_bets` — `listCurrentOrders`
- `place_bet` — validates stake, triggers approval if needed, calls `placeOrders`

### Key configuration (`src/config.ts`)

All settings come from environment variables (see `.env.example`). Critical ones:
- `MODEL_PROVIDER` — `anthropic` (default), `gemini`, or `gemini-adk` (Gemini via Google ADK with Google Search)
- `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` — only the key for the active provider is required
- `ANTHROPIC_MODEL` / `GEMINI_MODEL` — optional model overrides
- `LIVE_BETTING=false` — dry-run by default; set `true` to place real bets
- `MAX_AUTO_STAKE` — bets at or below this GBP amount are placed without approval (default £10)
- `MAX_STAKE_PER_BET` — hard cap on any single bet (default £50)

## Betfair API Notes

- The interactive login (`identitysso.betfair.com/api/login`) works for automated use but sessions expire after 4 hours.
- For production high-frequency bots, Betfair recommends certificate-based login (`identitysso.betfair.com/api/certlogin`) — this would replace `src/betfair/auth.ts`.
- All betting API calls are POST to `https://api.betfair.com/exchange/betting/rest/v1.0/<operation>/`.
- Prices must use valid Betfair price increments (e.g. 1.01–2.0 in steps of 0.01, 2.0–3.0 in steps of 0.02, etc.).

## WhatsApp Setup (Twilio — default)

1. Create a Twilio account at https://www.twilio.com.
2. Go to **Messaging → Try it out → Send a WhatsApp message** and activate the sandbox.
3. From your personal WhatsApp, send the displayed join code (e.g. `join <word>-<word>`) to the sandbox number.
4. Copy your **Account SID** and **Auth Token** from https://console.twilio.com.
5. Set `TWILIO_WHATSAPP_FROM=whatsapp:+14155238886` (sandbox) and `WHATSAPP_TO=whatsapp:+44...` (your number).
6. For production, register a dedicated WhatsApp Business number through Twilio and update `TWILIO_WHATSAPP_FROM`.

## Telegram Setup (fallback)

Set `MESSAGING_PROVIDER=telegram`, then:
1. Message `@BotFather` on Telegram → `/newbot` → save the bot token as `TELEGRAM_BOT_TOKEN`.
2. Send any message to your new bot.
3. Visit `https://api.telegram.org/bot<TOKEN>/getUpdates` and find `message.chat.id` — save as `TELEGRAM_CHAT_ID`.

## Cloud Deployment

The agent is a single-run process — invoke it on a schedule (cron job, AWS EventBridge, GCP Cloud Scheduler, etc.). No persistent server is needed. Environment variables should be injected via the platform's secrets manager.
