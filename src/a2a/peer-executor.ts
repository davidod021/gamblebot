import crypto from 'node:crypto';
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import type { Message } from '@a2a-js/sdk';
import { createSession } from '../model/index.js';
import { toolDefinitions, executeTool } from '../tools/betfair-tools.js';
import { config } from '../config.js';
import type { ToolUseBlock, ToolDefinition } from '../model/types.js';

/**
 * Read-only tools only — peers can research markets but NEVER place bets
 * or use the local account for staking calculations.
 */
const PEER_TOOL_NAMES = [
  'list_upcoming_markets',
  'get_market_odds',
  'get_account_balance',
  'get_current_bets',
];

const BLOCKED_TOOLS = ['place_bet', 'calculate_stake'];

const MAX_PEER_ITERATIONS = 30;

const PEER_SYSTEM_PROMPT = `You are a sports betting research analyst specialising in British sports on the Betfair exchange.

You are running as a PEER agent — another agent instance has connected to you via A2A to share research.

## Your Role
Analyse markets, research teams and conditions, and report your findings. You are a research-only agent:
- You CAN list markets, check odds, check account balance, and view current bets
- You CANNOT place bets or calculate stakes — these capabilities are disabled

## Sports Focus
- Football: Premier League, Championship, FA Cup, League Cup, Scottish Premiership
- Cricket: England Tests, ODI/T20 internationals, The Hundred, County Championship
- Rugby Union: Premiership, European Champions Cup, Six Nations
- Rugby League: Super League, Challenge Cup

## Research Process
For each candidate market:
1. Check available markets and current odds/liquidity
2. Assess implied probabilities from exchange prices
3. Note any markets where you believe odds are mispriced

## Output
Provide your analysis clearly and concisely. Focus on:
- Markets examined with current odds and liquidity
- Your assessment of true probabilities vs market prices
- Any value opportunities you've identified (with reasoning)
- Key factors: form, injuries, conditions, home advantage

When finished, call submit_analysis with your complete findings.

Today's date: ${new Date().toISOString().split('T')[0]}
Current time (London): ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}`;

/**
 * A2A executor for peer agents. Creates a completely isolated ModelSession
 * per request — no shared state with the local agent loop. Only read-only
 * Betfair tools are available; bet placement is blocked at multiple levels.
 */
export class PeerExecutor implements AgentExecutor {
  private readonly readOnlyTools: ToolDefinition[];

  constructor() {
    this.readOnlyTools = toolDefinitions.filter((d) => PEER_TOOL_NAMES.includes(d.name));
  }

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const userText = requestContext.userMessage.parts
      .filter((p): p is { kind: 'text'; text: string } & { kind: string } => 'text' in p)
      .map((p) => p.text)
      .join('\n');

    console.log(`\n[A2A PEER] Incoming request: ${userText.slice(0, 200)}${userText.length > 200 ? '…' : ''}`);

    let responseText = '';

    try {
      // Fresh, isolated session — completely separate from the local agent loop
      const session = createSession(PEER_SYSTEM_PROMPT, this.readOnlyTools);
      let response = await session.send(userText);
      let iteration = 0;

      while (iteration < MAX_PEER_ITERATIONS) {
        iteration++;

        // Collect text output
        for (const block of response.content) {
          if (block.type === 'text') {
            responseText += block.text + '\n';
          }
        }

        if (response.stopReason === 'end_turn') {
          console.log(`[A2A PEER] Finished in ${iteration} iterations`);
          break;
        }

        if (response.stopReason === 'pause_turn') {
          response = await session.resume();
          continue;
        }

        if (response.stopReason === 'tool_use') {
          const toolUseBlocks = response.content.filter(
            (b): b is ToolUseBlock => b.type === 'tool_use',
          );

          if (toolUseBlocks.length === 0) break;

          const toolResults: Array<{ toolUseId: string; content: string }> = [];

          for (const toolUse of toolUseBlocks) {
            // Defence in depth: block dangerous tools even if somehow registered
            if (BLOCKED_TOOLS.includes(toolUse.name)) {
              console.warn(`[A2A PEER] Blocked tool call: ${toolUse.name}`);
              toolResults.push({
                toolUseId: toolUse.id,
                content: JSON.stringify({
                  error: `Tool "${toolUse.name}" is not available in peer mode. You can only research markets, not place bets.`,
                }),
              });
              continue;
            }

            console.log(`[A2A PEER] Executing: ${toolUse.name}`);
            const result = await executeTool(toolUse.name, toolUse.input);
            toolResults.push({ toolUseId: toolUse.id, content: result });
          }

          response = await session.submitToolResults(toolResults);
          continue;
        }

        break;
      }

      if (iteration >= MAX_PEER_ITERATIONS) {
        responseText += '\n[Peer agent reached iteration limit]';
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[A2A PEER] Error:', message);
      responseText = `Error during peer analysis: ${message}`;
    }

    const finalText = responseText.trim() || 'No analysis produced.';

    const msg: Message = {
      kind: 'message',
      messageId: crypto.randomUUID(),
      role: 'agent',
      taskId: requestContext.taskId,
      contextId: requestContext.contextId,
      parts: [{ kind: 'text', text: finalText }],
    };

    eventBus.publish(msg);
    eventBus.finished();
  }

  async cancelTask(_taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const msg: Message = {
      kind: 'message',
      messageId: crypto.randomUUID(),
      role: 'agent',
      parts: [{ kind: 'text', text: 'Peer analysis cancelled.' }],
    };
    eventBus.publish(msg);
    eventBus.finished();
  }
}
