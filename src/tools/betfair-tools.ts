import * as betfair from '../betfair/client.js';
import { requestBetApproval, sendNotification } from '../approval/index.js';
import { config } from '../config.js';
import type { PlaceInstruction } from '../betfair/types.js';
import { calculateStake, summariseStake, PHASE_CONFIG } from '../strategy.js';
import type { ToolDefinition } from '../model/types.js';

// Betfair event type IDs for British sports
const BRITISH_SPORT_IDS = ['1', '4', '5', '9']; // Football, Cricket, Rugby Union, Rugby League

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'list_upcoming_markets',
    description:
      'List upcoming British sports markets available on the Betfair exchange. Returns markets for football (Premier League, Championship, etc.), cricket (Test, ODI, T20, County), rugby union (Premiership, Six Nations), and rugby league (Super League). Call this to discover what is available to bet on.',
    input_schema: {
      type: 'object' as const,
      properties: {
        hours_ahead: {
          type: 'number',
          description: 'How many hours ahead to search for markets. Default 24.',
        },
        event_type_ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Filter by sport IDs. Football=1, Cricket=4, Rugby Union=5, Rugby League=9. Omit for all British sports.',
        },
        market_types: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Filter by market type codes e.g. ["MATCH_ODDS", "NEXT_GOAL", "CORRECT_SCORE"]. Omit for all types.',
        },
        include_international: {
          type: 'boolean',
          description:
            'If true, also include international markets (e.g. away fixtures, Test matches abroad). Default false (GB only).',
        },
        max_results: {
          type: 'number',
          description: 'Max number of markets to return. Default 20.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_market_odds',
    description:
      'Get the current best available back and lay odds for every runner in a market. Use the market_id from list_upcoming_markets. Check available liquidity before deciding to bet.',
    input_schema: {
      type: 'object' as const,
      properties: {
        market_id: {
          type: 'string',
          description: 'Betfair market ID, e.g. "1.234567890"',
        },
      },
      required: ['market_id'],
    },
  },
  {
    name: 'get_account_balance',
    description: 'Get the current Betfair account balance, available funds, and current exposure.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_current_bets',
    description: 'List all currently open/unmatched bets on the account to check existing exposure before placing new bets.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'place_bet',
    description: [
      `Place a bet on the Betfair exchange.`,
      `Stakes above £${config.betting.maxAutoStake} require user approval via Telegram before placement.`,
      `Maximum stake per bet: £${config.betting.maxStakePerBet}.`,
      config.betting.liveBetting
        ? `Live betting is ENABLED — bets will be placed for real.`
        : `Live betting is DISABLED (dry run). Bets will be logged and notified but NOT placed.`,
    ].join(' '),
    input_schema: {
      type: 'object' as const,
      properties: {
        market_id: { type: 'string', description: 'Betfair market ID' },
        selection_id: { type: 'number', description: 'Runner/selection ID to bet on' },
        selection_name: { type: 'string', description: 'Human-readable runner name (used in approval message)' },
        event_name: { type: 'string', description: 'Human-readable event name (used in approval message)' },
        market_name: { type: 'string', description: 'Human-readable market name (used in approval message)' },
        side: {
          type: 'string',
          enum: ['BACK', 'LAY'],
          description: 'BACK = bet for the selection to win. LAY = bet against it.',
        },
        price: {
          type: 'number',
          description: 'Decimal odds at which to place the bet (e.g. 2.5). Must be a valid Betfair price increment.',
        },
        stake: {
          type: 'number',
          description: `Stake in GBP. Maximum £${config.betting.maxStakePerBet}. Bets above £${config.betting.maxAutoStake} require manual Telegram approval.`,
        },
        reasoning: {
          type: 'string',
          description: 'Concise explanation of why this bet offers value — shown in the approval request.',
        },
      },
      required: [
        'market_id',
        'selection_id',
        'selection_name',
        'event_name',
        'market_name',
        'side',
        'price',
        'stake',
        'reasoning',
      ],
    },
  },
  {
    name: 'calculate_stake',
    description: [
      'Calculate the recommended stake for a bet using the two-phase compound strategy.',
      'Call this BEFORE place_bet to get the correct stake size.',
      'Provide your assessed win probability and the current best available odds.',
      'The tool applies Kelly Criterion with phase-appropriate fractions:',
      '  • Bootstrap phase (growing to target): Half Kelly, max 5 % of bankroll, min 3 % edge',
      '  • Compound phase (at or above target): Quarter Kelly, max 3 % of bankroll, min 5 % edge',
      'If the tool returns reject=true, do NOT place the bet.',
    ].join(' '),
    input_schema: {
      type: 'object' as const,
      properties: {
        win_probability: {
          type: 'number',
          description:
            'Your assessed probability that this selection wins, as a decimal between 0 and 1. ' +
            'E.g. 0.55 means you believe there is a 55 % chance of winning. ' +
            'This is your key contribution — be honest and well-researched.',
        },
        decimal_odds: {
          type: 'number',
          description: 'Best available back price on Betfair (e.g. 2.50). Must be > 1.0.',
        },
        current_bankroll: {
          type: 'number',
          description: 'Current available balance from get_account_balance.',
        },
      },
      required: ['win_probability', 'decimal_odds', 'current_bankroll'],
    },
  },
];

export async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<string> {
  try {
    switch (toolName) {
      case 'list_upcoming_markets':
        return await listUpcomingMarkets(toolInput);
      case 'get_market_odds':
        return await getMarketOdds(toolInput);
      case 'get_account_balance':
        return await getAccountBalance();
      case 'get_current_bets':
        return await getCurrentBets();
      case 'place_bet':
        return await placeBet(toolInput);
      case 'calculate_stake':
        return calculateStakeTool(toolInput);
      default:
        return JSON.stringify({ error: `Unknown tool: ${toolName}` });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Tool:${toolName}] Error:`, message);
    return JSON.stringify({ error: message });
  }
}

async function listUpcomingMarkets(input: Record<string, unknown>): Promise<string> {
  const hoursAhead = (input.hours_ahead as number | undefined) ?? config.betting.hoursAhead;
  const eventTypeIds =
    Array.isArray(input.event_type_ids) && input.event_type_ids.length > 0
      ? (input.event_type_ids as string[])
      : BRITISH_SPORT_IDS;
  const marketTypes = Array.isArray(input.market_types) ? (input.market_types as string[]) : undefined;
  const includeInternational = Boolean(input.include_international);
  const maxResults = (input.max_results as number | undefined) ?? 20;

  const now = new Date();
  const future = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);

  const markets = await betfair.listMarketCatalogue(
    {
      eventTypeIds,
      marketCountries: includeInternational ? undefined : ['GB'],
      marketStartTime: { from: now.toISOString(), to: future.toISOString() },
      ...(marketTypes && { marketTypeCodes: marketTypes }),
    },
    maxResults,
  );

  return JSON.stringify(markets, null, 2);
}

async function getMarketOdds(input: Record<string, unknown>): Promise<string> {
  const marketId = input.market_id as string;
  const books = await betfair.listMarketBook([marketId]);
  return JSON.stringify(books, null, 2);
}

async function getAccountBalance(): Promise<string> {
  const funds = await betfair.getAccountFunds();
  return JSON.stringify(funds, null, 2);
}

async function getCurrentBets(): Promise<string> {
  const orders = await betfair.listCurrentOrders();
  return JSON.stringify(orders, null, 2);
}

async function placeBet(input: Record<string, unknown>): Promise<string> {
  const stake = input.stake as number;
  const marketId = input.market_id as string;
  const selectionId = input.selection_id as number;
  const side = input.side as 'BACK' | 'LAY';
  const price = input.price as number;
  const reasoning = input.reasoning as string;
  const selectionName = input.selection_name as string;
  const eventName = input.event_name as string;
  const marketName = input.market_name as string;

  // Hard cap on stake
  if (stake > config.betting.maxStakePerBet) {
    return JSON.stringify({
      error: `Stake £${stake} exceeds the maximum allowed per bet of £${config.betting.maxStakePerBet}. Reduce the stake.`,
    });
  }

  // Dry-run mode — notify but do not place
  if (!config.betting.liveBetting) {
    const potReturn = side === 'BACK'
      ? (stake * price).toFixed(2)
      : (stake * (price - 1)).toFixed(2);

    await sendNotification(
      `📝 *Bet Recommendation (DRY RUN)*\n\n` +
        `🏟 ${eventName} — ${marketName}\n` +
        `🏃 ${selectionName} (${side} @ ${price})\n` +
        `💰 Stake: £${stake.toFixed(2)}  |  Return: £${potReturn}\n\n` +
        `💭 ${reasoning}`,
    );
    return JSON.stringify({
      status: 'DRY_RUN',
      message: 'Live betting is disabled. Recommendation sent via Telegram.',
      recommendation: { marketId, selectionId, selectionName, eventName, side, price, stake },
    });
  }

  // Request approval for large stakes
  if (stake > config.betting.maxAutoStake) {
    console.log(
      `[Approval] Stake £${stake} > auto-limit £${config.betting.maxAutoStake}. Requesting Telegram approval...`,
    );
    const approved = await requestBetApproval({
      marketName,
      eventName,
      selectionName,
      side,
      price,
      stake,
      reasoning,
    });

    if (!approved) {
      return JSON.stringify({ status: 'REJECTED', message: 'Bet rejected or timed out during approval.' });
    }
  }

  // Place the bet
  const instruction: PlaceInstruction = {
    orderType: 'LIMIT',
    selectionId,
    handicap: 0,
    side,
    limitOrder: {
      size: stake,
      price,
      persistenceType: 'LAPSE',
    },
  };

  const result = await betfair.placeOrders(marketId, [instruction]);

  if (result.status === 'SUCCESS') {
    const report = result.instructionReports?.[0];
    await sendNotification(
      `✅ *Bet Placed*\n\n` +
        `🏟 ${eventName} — ${marketName}\n` +
        `🏃 ${selectionName} (${side} @ ${report?.averagePriceMatched ?? price})\n` +
        `💰 Matched: £${report?.sizeMatched ?? stake}\n` +
        `🎫 Bet ID: ${report?.betId ?? 'N/A'}`,
    );
  } else {
    await sendNotification(
      `⚠️ *Bet Failed*\n\n` +
        `${eventName} — ${selectionName}\n` +
        `Status: ${result.status}\n` +
        `Error: ${result.errorCode ?? 'Unknown'}`,
    );
  }

  return JSON.stringify(result, null, 2);
}

function calculateStakeTool(input: Record<string, unknown>): string {
  const winProbability = input.win_probability as number;
  const decimalOdds = input.decimal_odds as number;
  const currentBankroll = input.current_bankroll as number;

  // Use INITIAL_BANKROLL from config; fall back to current bankroll if not set
  // (assumes the user hasn't configured it yet — treat current balance as the starting point)
  const initialBankroll =
    config.strategy.initialBankroll > 0
      ? config.strategy.initialBankroll
      : currentBankroll;

  const result = calculateStake({ winProbability, decimalOdds, currentBankroll, initialBankroll });

  const phaseConfig = PHASE_CONFIG[result.phase];
  const targetBankroll = initialBankroll * config.strategy.growthTargetMultiplier;
  const progressPct = Math.min((currentBankroll / targetBankroll) * 100, 100).toFixed(1);

  const summary = {
    ...result,
    phase_label: phaseConfig.label,
    kelly_fraction_applied: `${(phaseConfig.kellyFraction * 100).toFixed(0)}%`,
    min_edge_required: `${(phaseConfig.minEdgePct * 100).toFixed(0)}%`,
    edge_found: `${(result.edge * 100).toFixed(2)}%`,
    raw_kelly: `${(result.rawKellyPct * 100).toFixed(2)}%`,
    bootstrap_progress:
      result.phase === 'bootstrap'
        ? `${progressPct}% of way to target (£${targetBankroll.toFixed(2)})`
        : 'Target reached',
    human_summary: summariseStake(result, { winProbability, decimalOdds, currentBankroll, initialBankroll }),
  };

  return JSON.stringify(summary, null, 2);
}
