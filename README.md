# GambleBot

An autonomous AI betting agent that analyses British sports markets on the Betfair exchange and identifies value bets. The AI model provider, messaging provider, and agent topology are all configurable via environment variables.

## Features

- **Value bet detection** — researches form, injuries, weather, and market signals to find edges
- **Two-phase compound strategy** — Kelly-based stake sizing that shifts from aggressive growth to capital-preservation once a target multiple is reached
- **Session drawdown guard** — automatically halts betting if the bankroll drops a configurable percentage from the session peak
- **Human approval flow** — bets above `MAX_AUTO_STAKE` require WhatsApp or Telegram approval before placement
- **Dry-run mode** — logs and notifies without placing real bets (default)
- **Multi-agent A2A topology** — standalone, coordinator/specialist, and peer modes for distributed research
- **Continuous mode** — keeps the agent alive and listens for WhatsApp/Telegram messages to trigger on-demand runs or scheduled auto-runs
- **Swappable AI providers** — Anthropic Claude (with extended thinking and web search), Google Gemini, or Google Gemini via ADK

## Supported Sports

| Sport | Competitions |
|---|---|
| Football | Premier League, Championship, FA Cup, League Cup, Scottish Premiership |
| Cricket | England Tests, ODIs, T20s, The Hundred, County Championship |
| Rugby Union | Premiership, European Champions Cup, Six Nations |
| Rugby League | Super League, Challenge Cup |

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy and fill in your credentials
cp .env.example .env
# edit .env with your Betfair, AI, and messaging credentials

# 3. Run in dry-run mode (safe default — no real bets)
npm run dev

# 4. To compile and run the production build
npm run build && npm start
```

---

## Commands

```bash
npm run dev        # Run directly with tsx (no compile step — for development)
npm run build      # Compile TypeScript to dist/
npm start          # Run compiled output
npm run typecheck  # Type-check without emitting
```

---

## Architecture

```
src/
├── index.ts              # Entry point — selects run mode (standalone / coordinator / specialist / continuous)
├── agent.ts              # Core agentic loop — drives model sessions and tool dispatch
├── config.ts             # Environment variable parsing and validation
├── strategy.ts           # Two-phase Kelly staking and drawdown logic
├── model/
│   ├── anthropic.ts      # Anthropic Claude session (thinking + web search)
│   ├── gemini.ts         # Google Gemini session (native function calling)
│   ├── gemini-adk.ts     # Google ADK session (Google Search + Betfair tools)
│   ├── types.ts          # Provider-agnostic interfaces
│   └── index.ts          # createSession() factory
├── betfair/
│   ├── auth.ts           # Interactive login; auto-renews at 3.5 h
│   ├── client.ts         # Betfair Exchange REST API wrappers
│   └── types.ts          # Betfair request/response interfaces
├── tools/
│   └── betfair-tools.ts  # Tool definitions and executeTool() dispatcher
├── approval/
│   ├── whatsapp.ts       # Twilio WhatsApp approval + notification
│   ├── telegram.ts       # Telegram bot approval + notification
│   └── index.ts          # Routes to active MESSAGING_PROVIDER
├── messaging/
│   └── listener.ts       # Polls WhatsApp/Telegram for user-triggered runs (continuous mode)
└── a2a/
    ├── server.ts          # A2A HTTP server + agent card
    ├── specialist-executor.ts  # Sport-specialist agent executor
    ├── peer-executor.ts        # Read-only peer research executor
    └── client-tools.ts         # consult_*_specialist and consult_peer tools
```

---

## AI Model Providers

Set `MODEL_PROVIDER` to choose the AI backend. Only the API key for the active provider is required.

| `MODEL_PROVIDER` | Description |
|---|---|
| `anthropic` (default) | Claude with extended thinking and server-side web search |
| `gemini` | Gemini 2.5 Pro with native function calling |
| `gemini-adk` | Gemini via Google ADK — Google Search built in alongside Betfair tools |

---

## Messaging Providers

Set `MESSAGING_PROVIDER` to choose how bet approvals and notifications are sent.

### WhatsApp via Twilio (default)

1. Create a Twilio account at <https://www.twilio.com>.
2. Go to **Messaging → Try it out → Send a WhatsApp message** and activate the sandbox.
3. From your personal WhatsApp, send the displayed join code to the sandbox number.
4. Copy your **Account SID** and **Auth Token** from <https://console.twilio.com>.
5. Set `TWILIO_WHATSAPP_FROM=whatsapp:+14155238886` (sandbox) and `WHATSAPP_TO=whatsapp:+44...`.
6. For production, register a dedicated WhatsApp Business number and update `TWILIO_WHATSAPP_FROM`.

Reply `YES` or `NO` to approval messages.

### Telegram

1. Message `@BotFather` on Telegram → `/newbot` → save the token as `TELEGRAM_BOT_TOKEN`.
2. Send any message to your new bot.
3. Visit `https://api.telegram.org/bot<TOKEN>/getUpdates` and find `message.chat.id` → save as `TELEGRAM_CHAT_ID`.

Approval is via inline **Approve / Reject** keyboard buttons.

---

## Betting Strategy

### Two-Phase Compound Strategy

The agent uses a Kelly Criterion-based staking model with two phases:

| Phase | Trigger | Kelly Fraction | Max Bet | Min Edge |
|---|---|---|---|---|
| **Bootstrap** | Bankroll below growth target | Half Kelly (50%) | 5% of bankroll | 3% |
| **Compound** | Bankroll at or above growth target | Quarter Kelly (25%) | 3% of bankroll | 5% |

- `INITIAL_BANKROLL` — set this once at the start. Used to determine which phase the agent is in.
- `GROWTH_TARGET_MULTIPLIER` — phase switches at this multiple of `INITIAL_BANKROLL` (default `5` = 5×).

### Session Drawdown Limit

If the bankroll drops `SESSION_DRAWDOWN_LIMIT` (default 25%) from its session peak, betting halts for the rest of the session. A notification is sent immediately.

### Bet Approval

- Bets at or below `MAX_AUTO_STAKE` (default £10) are placed automatically.
- Bets above `MAX_AUTO_STAKE` (up to `MAX_STAKE_PER_BET`, default £50) require a `YES` reply.
- Bets are never placed on timeout — they are skipped.

---

## Multi-Agent A2A Topology

The agent supports the [A2A protocol](https://google.github.io/A2A/) for multi-agent coordination.

### Modes

| `A2A_ROLE` | Description |
|---|---|
| `standalone` (default) | Single agent does all research and betting |
| `coordinator` | Delegates sport-specific research to specialist agents, then validates and places bets |
| `specialist` | Handles research for one sport (`A2A_SPORT`) and returns structured findings — does not place bets |

### Peer Mode (standalone + research sharing)

Set `A2A_PEER_URL` to give a standalone agent a `consult_peer` tool. The peer is another GambleBot instance that can research markets but cannot place bets. Both agents pool findings to increase confidence.

### Running a Multi-Agent Setup

```bash
# Terminal 1 — football specialist on port 3010
A2A_ROLE=specialist A2A_SPORT=football A2A_PORT=3010 npm run dev

# Terminal 2 — cricket specialist on port 3011
A2A_ROLE=specialist A2A_SPORT=cricket A2A_PORT=3011 npm run dev

# Terminal 3 — coordinator, connected to both specialists
A2A_ROLE=coordinator A2A_FOOTBALL_URL=http://localhost:3010 A2A_CRICKET_URL=http://localhost:3011 npm run dev
```

---

## Continuous Mode

Set `CONTINUOUS_MODE=true` to keep the process running indefinitely:

- A2A peer server stays alive so other agents can connect at any time.
- WhatsApp / Telegram is polled for user messages — any non-approval message triggers a new analysis run.
- `AUTO_RUN_INTERVAL_MINUTES` schedules automatic runs (0 = disabled).

```bash
CONTINUOUS_MODE=true AUTO_RUN_INTERVAL_MINUTES=360 npm run dev
```

### CLI Arguments

You can override the operating mode and auto-run interval directly on the command line without changing `.env`. This is useful for one-off runs or quick testing.

| Argument | Values | Description |
|---|---|---|
| `--mode` | `continuous`, `standalone`, `coordinator`, `specialist` | Operating mode — overrides `CONTINUOUS_MODE` / `A2A_ROLE` |
| `--interval` | integer (minutes) | Auto-run interval — overrides `AUTO_RUN_INTERVAL_MINUTES` |
| `--live` | _(flag)_ | Enable live betting — overrides `LIVE_BETTING=true` |
| `--dry-run` | _(flag)_ | Disable live betting — overrides `LIVE_BETTING=false` |

```bash
# Temporarily enable continuous mode with a 2-minute auto-run interval
npm run dev -- --mode continuous --interval 2

# Run once as coordinator without editing .env
npm run dev -- --mode coordinator

# Production build — continuous with a 5-minute interval, live betting on
node dist/index.js --mode continuous --interval 5 --live

# Force a dry run even if LIVE_BETTING=true in .env
npm run dev -- --dry-run
```

---

## Cloud Deployment

The agent is a single-run process — invoke it on a schedule (cron job, AWS EventBridge, GCP Cloud Scheduler, etc.). No persistent server is needed in one-shot mode. Inject environment variables via the platform's secrets manager.

For always-on deployments (continuous mode or A2A specialist), use a long-running container (Cloud Run with `--min-instances 1`, ECS, Kubernetes, etc.).

> **Note:** The interactive Betfair login (`identitysso.betfair.com/api/login`) works for automated use but sessions expire after 4 hours (auto-renewed at 3.5 h). For high-frequency production bots, Betfair recommends certificate-based login (`identitysso.betfair.com/api/certlogin`).

---

## Environment Variables

See [.env.example](.env.example) for a fully annotated template. Key variables:

| Variable | Default | Description |
|---|---|---|
| `MODEL_PROVIDER` | `anthropic` | AI provider: `anthropic`, `gemini`, or `gemini-adk` |
| `MESSAGING_PROVIDER` | `whatsapp` | Approval/notification channel: `whatsapp` or `telegram` |
| `LIVE_BETTING` | `false` | Set `true` to place real bets |
| `MAX_AUTO_STAKE` | `10` | Bets at or below this GBP amount are placed without approval |
| `MAX_STAKE_PER_BET` | `50` | Hard cap on any single bet |
| `APPROVAL_TIMEOUT_SECONDS` | `300` | Seconds to wait for approval before skipping the bet |
| `HOURS_AHEAD` | `24` | How far ahead to search for upcoming markets |
| `CONTINUOUS_MODE` | `false` | Keep the agent alive and listen for user messages |
| `AUTO_RUN_INTERVAL_MINUTES` | `0` | Auto-run interval in continuous mode (0 = disabled) |
| `INITIAL_BANKROLL` | `0` | Starting bankroll for phase detection (0 = use current balance) |
| `GROWTH_TARGET_MULTIPLIER` | `5` | Phase switch at this multiple of `INITIAL_BANKROLL` |
| `SESSION_DRAWDOWN_LIMIT` | `0.25` | Halt if bankroll drops this fraction from session peak |
| `A2A_ROLE` | `standalone` | Agent role: `standalone`, `coordinator`, or `specialist` |
| `A2A_SPORT` | — | Required for `specialist` role: `football`, `cricket`, or `rugby` |
| `A2A_PORT` | `3001` | Port for A2A server (specialist / peer) |
| `A2A_PEER_URL` | — | URL of a remote peer agent to consult for research |
| `A2A_FOOTBALL_URL` | — | URL of football specialist (coordinator mode) |
| `A2A_CRICKET_URL` | — | URL of cricket specialist (coordinator mode) |
| `A2A_RUGBY_URL` | — | URL of rugby specialist (coordinator mode) |
