import { toolDefinitions, executeTool } from './tools/betfair-tools.js';
import { sendNotification } from './approval/index.js';
import { config } from './config.js';
import { shouldHaltSession, updatePeak, getPhase, PHASE_CONFIG } from './strategy.js';
import { getAccountFunds } from './betfair/client.js';
import { createSession } from './model/index.js';
import type { ToolUseBlock } from './model/types.js';

const SYSTEM_PROMPT = `You are an expert sports betting analyst and trader specialising in British sports betting on the Betfair exchange.

## Your Role
Find and act on value betting opportunities — markets where the exchange odds underestimate the true probability of an outcome — then size each bet correctly using the two-phase compound strategy.

## Sports Focus
- **Football**: Premier League, Championship, FA Cup, League Cup, Scottish Premiership, and other GB competitions
- **Cricket**: England Test matches, ODI/T20 internationals, The Hundred, County Championship
- **Rugby Union**: Premiership, European Champions Cup, Six Nations
- **Rugby League**: Super League, Challenge Cup

## Research Process
For each candidate market:
1. Search for recent team/player news, injuries, suspensions, selection changes
2. Search for current form (last 5–6 results) and head-to-head records
3. For cricket: always check weather forecast — rain stops play and fundamentally changes match odds
4. Look for expert analysis, line movement, and any sharp money signals
5. Assess home advantage, crowd effects, and travel/fatigue factors

## Finding Value
- **Implied probability** = 1 / decimal_odds (what the market thinks)
- **Your assessed probability** = your honest estimate after research
- A bet has value only when your probability > implied probability
- Be honest about uncertainty — a 52 % vs 50 % edge is marginal; a 60 % vs 50 % edge is strong
- Prefer high-confidence edges over large but speculative edges

## Two-Phase Compound Strategy (MANDATORY — follow this exactly)

The strategy has two phases based on how far the bankroll has grown from its starting point:

### Phase 1 — Bootstrap (bankroll below growth target)
Goal: grow the bankroll aggressively to the target multiple (default 5×).
- Staking: **Half Kelly** (50 % of full Kelly recommendation)
- Maximum bet: 5 % of current bankroll
- Minimum edge required: **3 %**
- Be willing to take on slightly more risk for faster growth

### Phase 2 — Compound (bankroll at or above growth target)
Goal: sustainable, lower-volatility long-term growth.
- Staking: **Quarter Kelly** (25 % of full Kelly recommendation)
- Maximum bet: 3 % of current bankroll
- Minimum edge required: **5 %** (more selective — skip marginal opportunities)
- Prioritise capital preservation alongside growth

### Kelly Criterion formula (for reference)
f* = (b × p − q) / b
  b = decimal_odds − 1
  p = your win probability
  q = 1 − p

### Stake sizing workflow — follow this for EVERY bet:
1. Research the event and form your honest win probability estimate
2. Check the best available back price with **get_market_odds**
3. Call **calculate_stake** with your probability, the odds, and current balance
4. If calculate_stake returns reject=true → skip this bet, do not proceed
5. Use the stake returned by calculate_stake when calling **place_bet**
6. Never override or second-guess the stake calculator

## Session Rules
- Check account balance and open bets at the start of every session
- Maximum 3–4 bets per session to avoid overexposure
- Minimum £500 liquidity available in the market before betting
- Avoid in-play betting
- If you cannot find enough research to be confident, skip the market
- Do not bet on multiple selections in the same event

## Mode
${config.betting.liveBetting ? '🔴 LIVE BETTING ENABLED — bets will be placed for real money.' : '📝 DRY RUN MODE — bets will be logged and notified but NOT placed.'}

## REQUIRED: Always call submit_analysis to finish
After completing all research and tool calls, you MUST call the **submit_analysis** tool with your written summary covering:
1. Which markets you examined and why
2. Key research findings (form, injuries, weather, etc.)
3. Any value bets identified: selection, odds, your probability estimate, edge, and stake
4. If no bets placed: a clear explanation of why each market was rejected

Calling submit_analysis is mandatory — the session is not complete until you do.

Today's date: ${new Date().toISOString().split('T')[0]}
Current time (London): ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}`;

const MAX_ITERATIONS = 40;

export async function runAgent(): Promise<void> {
  const startTime = new Date();
  console.log('\n' + '='.repeat(50));
  console.log(`GambleBot Agent — ${startTime.toISOString()}`);
  console.log(`Mode: ${config.betting.liveBetting ? '🔴 LIVE BETTING' : '📝 DRY RUN'}`);
  console.log('='.repeat(50) + '\n');

  // ── Fetch initial balance & determine strategy phase ─────────────────────
  const funds = await getAccountFunds();
  const sessionStartBankroll = funds.availableToBetBalance;
  const initialBankroll =
    config.strategy.initialBankroll > 0
      ? config.strategy.initialBankroll
      : sessionStartBankroll;

  const phase = getPhase(sessionStartBankroll, initialBankroll);
  const phaseCfg = PHASE_CONFIG[phase];

  let sessionGuard = { sessionStartBankroll, peakBankroll: sessionStartBankroll };

  console.log(`Balance: £${sessionStartBankroll.toFixed(2)} | Phase: ${phaseCfg.label}`);

  await sendNotification(
    `🤖 *GambleBot Starting*\n\n` +
      `Mode: ${config.betting.liveBetting ? '🔴 Live Betting' : '📝 Dry Run'}\n` +
      `Balance: £${sessionStartBankroll.toFixed(2)}\n` +
      `Strategy: ${phaseCfg.label}\n` +
      `Time: ${startTime.toLocaleString('en-GB', { timeZone: 'Europe/London' })}`,
  );

  const session = createSession(SYSTEM_PROMPT, toolDefinitions);

  let response = await session.send(
    "Analyse today's British sports markets and identify value betting opportunities. " +
      'Start by checking my account balance and any open bets, then research the upcoming markets. ' +
      'When finished, call submit_analysis with your complete written summary.',
  );

  let iteration = 0;

  while (iteration < MAX_ITERATIONS) {
    iteration++;
    console.log(`\n--- Iteration ${iteration} ---`);

    // Log response content
    for (const block of response.content) {
      if (block.type === 'thinking') {
        const preview = block.thinking.slice(0, 400);
        console.log(`\n[THINKING] ${preview}${block.thinking.length > 400 ? '…' : ''}`);
      } else if (block.type === 'text') {
        console.log(`\n[AGENT] ${block.text}`);
      } else if (block.type === 'tool_use') {
        const inputPreview = JSON.stringify(block.input, null, 2).slice(0, 300);
        console.log(`\n[TOOL USE] ${block.name}\n${inputPreview}${inputPreview.length >= 300 ? '…' : ''}`);
      }
    }

    if (response.stopReason === 'end_turn') {
      console.log('\n✅ Agent finished');

      const finalText = response.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n\n')
        .trim();

      if (finalText) {
        const summary =
          finalText.length > 3800
            ? finalText.slice(0, 3800) + '\n\n_(truncated — see logs for full output)_'
            : finalText;
        await sendNotification(`📊 *Agent Summary*\n\n${summary}`);
      }

      const elapsed = Math.round((Date.now() - startTime.getTime()) / 1000);
      console.log(`\nCompleted in ${elapsed}s over ${iteration} iterations`);
      break;
    }

    if (response.stopReason === 'pause_turn') {
      console.log('[pause_turn] Server-side tool limit reached, continuing...');
      response = await session.resume();
      continue;
    }

    if (response.stopReason === 'tool_use') {
      const toolUseBlocks = response.content.filter(
        (b): b is ToolUseBlock => b.type === 'tool_use',
      );

      if (toolUseBlocks.length === 0) {
        console.warn('[tool_use] stop_reason but no tool_use blocks found — stopping');
        break;
      }

      const toolResults: Array<{ toolUseId: string; content: string }> = [];

      for (const toolUse of toolUseBlocks) {
        console.log(`\n[EXECUTING] ${toolUse.name}`);
        const result = await executeTool(toolUse.name, toolUse.input);
        const preview = result.slice(0, 300);
        console.log(`[RESULT] ${preview}${result.length > 300 ? '…' : ''}`);

        toolResults.push({ toolUseId: toolUse.id, content: result });

        // After each balance check, update session drawdown guard
        if (toolUse.name === 'get_account_balance') {
          try {
            const balanceData = JSON.parse(result) as { availableToBetBalance?: number };
            if (balanceData.availableToBetBalance !== undefined) {
              sessionGuard = updatePeak(sessionGuard, balanceData.availableToBetBalance);
              if (shouldHaltSession(sessionGuard, balanceData.availableToBetBalance)) {
                const drawdownPct = Math.round(config.strategy.sessionDrawdownLimit * 100);
                console.warn(`\n⛔ Session drawdown limit hit (${drawdownPct}% from peak). Halting.`);
                await sendNotification(
                  `⛔ *GambleBot: Session halted*\n\n` +
                    `Bankroll dropped ${drawdownPct}% from session peak.\n` +
                    `Peak: £${sessionGuard.peakBankroll.toFixed(2)}\n` +
                    `Current: £${balanceData.availableToBetBalance.toFixed(2)}\n\n` +
                    `No more bets will be placed this session.`,
                );
                // Feed back the results we have so far, then exit cleanly
                await session.submitToolResults(toolResults);
                return;
              }
            }
          } catch {
            // ignore parse errors — balance check is best-effort
          }
        }
      }

      response = await session.submitToolResults(toolResults);
      continue;
    }

    console.warn(`Unexpected stop_reason: ${response.stopReason} — stopping`);
    break;
  }

  if (iteration >= MAX_ITERATIONS) {
    console.warn('Max iterations reached');
    await sendNotification('⚠️ *GambleBot*: Max iterations reached — agent stopped early.');
  }
}
