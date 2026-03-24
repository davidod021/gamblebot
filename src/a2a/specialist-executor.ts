import crypto from 'node:crypto';
import {
  LlmAgent,
  Runner,
  InMemorySessionService,
  isFinalResponse,
  getFunctionCalls,
  FunctionTool,
  GOOGLE_SEARCH,
  AgentTool,
} from '@google/adk';
import { Type } from '@google/genai';
import type { Schema } from '@google/genai';
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import type { Message } from '@a2a-js/sdk';
import { toolDefinitions, executeTool } from '../tools/betfair-tools.js';
import { config } from '../config.js';
import type { SchemaProperty, ToolDefinition } from '../model/types.js';

export type SportSpecialty = 'football' | 'cricket' | 'rugby';

// Read-only tools only — specialists analyse but never place bets
const READ_ONLY_TOOL_NAMES = [
  'list_upcoming_markets',
  'get_market_odds',
  'get_account_balance',
  'get_current_bets',
];

const SPORT_INSTRUCTIONS: Record<SportSpecialty, string> = {
  football: `You are a specialist football (soccer) betting analyst for British Betfair markets.

Your remit is ONLY football: Premier League, Championship, FA Cup, League Cup, Scottish Premiership.

Your task:
1. Call list_upcoming_markets with event_type_ids=["1"] to see available football markets
2. For each promising market, search for team news, injuries, form, and head-to-head records
3. Identify markets where the exchange odds appear to underestimate the true probability
4. Call get_market_odds for each candidate to check available prices and liquidity

Do NOT place any bets. Call submit_findings at the end with your complete analysis.`,

  cricket: `You are a specialist cricket betting analyst for British Betfair markets.

Your remit is ONLY cricket: England Test matches, ODI/T20 internationals, The Hundred, County Championship.

Your task:
1. Call list_upcoming_markets with event_type_ids=["4"] to see available cricket markets
2. Always check weather forecasts — rain affects play fundamentally
3. Research team selection, pitch conditions, and recent form
4. Identify markets where the exchange odds appear to underestimate the true probability

Do NOT place any bets. Call submit_findings at the end with your complete analysis.`,

  rugby: `You are a specialist rugby betting analyst for British Betfair markets.

Your remit is Rugby Union (Premiership, European Champions Cup, Six Nations) AND Rugby League (Super League, Challenge Cup).

Your task:
1. Call list_upcoming_markets with event_type_ids=["5","9"] to see available rugby markets
2. Research team news, injuries, suspensions, recent form, and home advantage
3. Identify markets where the exchange odds appear to underestimate the true probability

Do NOT place any bets. Call submit_findings at the end with your complete analysis.`,
};

const FINDINGS_SCHEMA = `JSON object with:
- markets_examined: array of {market_id, event_name, market_name, status: "value found"|"no value"|"insufficient liquidity"}
- value_bets: array of {market_id, selection_id, selection_name, event_name, market_name, side: "BACK"|"LAY", recommended_price, estimated_probability, edge_pct, reasoning}
- research_summary: key findings from news/form research
- total_markets_checked: number`;

export class SportSpecialistExecutor implements AgentExecutor {
  private readonly sport: SportSpecialty;
  private readonly runner: Runner;
  private readonly sessionService: InMemorySessionService;
  private capturedFindings: string | null = null;

  constructor(sport: SportSpecialty) {
    this.sport = sport;

    const readOnlyDefs = toolDefinitions.filter((d) => READ_ONLY_TOOL_NAMES.includes(d.name));
    const betfairTools = readOnlyDefs.map(
      (def) =>
        new FunctionTool({
          name: def.name,
          description: def.description,
          parameters: convertToSchema(def) as Schema,
          execute: async (args: unknown) => {
            const input = args as Record<string, unknown>;
            console.log(`\n[${sport.toUpperCase()} SPECIALIST] ${def.name}`);
            const result = await executeTool(def.name, input);
            try {
              const parsed = JSON.parse(result) as unknown;
              if (Array.isArray(parsed)) return { items: parsed };
              return parsed as Record<string, unknown>;
            } catch {
              return { result };
            }
          },
        }),
    );

    const submitFindingsTool = new FunctionTool({
      name: 'submit_findings',
      description: `REQUIRED: Submit your analysis findings. Include all value bets found. Schema: ${FINDINGS_SCHEMA}`,
      parameters: {
        type: Type.OBJECT,
        properties: {
          findings: {
            type: Type.STRING,
            description: `Your complete findings as a JSON string matching: ${FINDINGS_SCHEMA}`,
          },
        },
        required: ['findings'],
      } as Schema,
      execute: async (args: unknown) => {
        const { findings } = args as { findings: string };
        this.capturedFindings = findings;
        console.log(`\n[${sport.toUpperCase()} SPECIALIST] Findings submitted`);
        return { status: 'ok' };
      },
    });

    const researchAgent = new LlmAgent({
      name: 'research_sports_news',
      description:
        'Search the web for sports news, team form, injury updates, weather forecasts, and expert analysis.',
      model: config.model.geminiModel,
      instruction:
        'You are a sports research assistant. Search the web thoroughly to answer research questions. Return detailed, factual summaries covering all relevant findings.',
      tools: [GOOGLE_SEARCH],
    });

    const agent = new LlmAgent({
      name: `${sport}_specialist`,
      model: config.model.geminiModel,
      instruction:
        SPORT_INSTRUCTIONS[sport] +
        `\n\nToday's date: ${new Date().toISOString().split('T')[0]}\nCurrent time (London): ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' })}`,
      tools: [new AgentTool({ agent: researchAgent }), ...betfairTools, submitFindingsTool],
      afterModelCallback: ({ response }) => {
        const hasFunctionCalls = response.content?.parts?.some(
          (p) => (p as Record<string, unknown>).functionCall,
        );
        const hasText = response.content?.parts?.some((p) => p.text && !p.thought);
        if (!hasFunctionCalls && !hasText && !response.content) {
          return {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'submit_findings',
                    args: {
                      findings: JSON.stringify({
                        markets_examined: [],
                        value_bets: [],
                        research_summary: `No ${sport} value opportunities found in available markets.`,
                        total_markets_checked: 0,
                      }),
                    },
                  },
                },
              ],
            },
          };
        }
        return undefined;
      },
    });

    this.sessionService = new InMemorySessionService();
    this.runner = new Runner({
      agent,
      sessionService: this.sessionService,
      appName: `gamblebot-${sport}`,
    });
  }

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    this.capturedFindings = null;

    const userText = requestContext.userMessage.parts
      .filter((p): p is { kind: 'text'; text: string } & { kind: string } => 'text' in p)
      .map((p) => p.text)
      .join('\n');

    let responseText = '';
    try {
      for await (const event of this.runner.runEphemeral({
        userId: 'coordinator',
        newMessage: { role: 'user', parts: [{ text: userText }] },
      })) {
        if (isFinalResponse(event)) {
          const parts = event.content?.parts ?? [];
          for (const part of parts) {
            if (part.text && !part.thought) responseText += part.text;
          }
        }
        for (const fc of getFunctionCalls(event)) {
          if (fc.name === 'google_search') {
            const query = (fc.args as Record<string, unknown>)?.query ?? '';
            console.log(`[${this.sport.toUpperCase()} SPECIALIST] google_search: ${query}`);
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${this.sport.toUpperCase()} SPECIALIST] Error:`, message);
      this.capturedFindings = JSON.stringify({
        markets_examined: [],
        value_bets: [],
        research_summary: `Error during analysis: ${message}`,
        total_markets_checked: 0,
      });
    }

    const finalText =
      this.capturedFindings ??
      (responseText || JSON.stringify({
        markets_examined: [],
        value_bets: [],
        research_summary: `No ${this.sport} opportunities found.`,
        total_markets_checked: 0,
      }));

    const response: Message = {
      kind: 'message',
      messageId: crypto.randomUUID(),
      role: 'agent',
      taskId: requestContext.taskId,
      contextId: requestContext.contextId,
      parts: [{ kind: 'text', text: finalText }],
    };

    eventBus.publish(response);
    eventBus.finished();
  }

  async cancelTask(_taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const response: Message = {
      kind: 'message',
      messageId: crypto.randomUUID(),
      role: 'agent',
      parts: [{ kind: 'text', text: JSON.stringify({ value_bets: [], research_summary: 'Task cancelled.' }) }],
    };
    eventBus.publish(response);
    eventBus.finished();
  }
}

// ─── Schema helpers (mirrors gemini-adk.ts) ───────────────────────────────────

function convertToSchema(def: ToolDefinition): object {
  const properties: Record<string, object> = {};
  for (const [key, prop] of Object.entries(def.input_schema.properties)) {
    properties[key] = convertProperty(prop);
  }
  return {
    type: Type.OBJECT,
    properties,
    required: def.input_schema.required.length > 0 ? def.input_schema.required : undefined,
  };
}

function convertProperty(prop: SchemaProperty): object {
  const base: Record<string, unknown> = {};
  if (prop.description) base.description = prop.description;
  switch (prop.type) {
    case 'string':
      base.type = Type.STRING;
      if (prop.enum) base.enum = prop.enum;
      return base;
    case 'number':
      base.type = Type.NUMBER;
      return base;
    case 'boolean':
      base.type = Type.BOOLEAN;
      return base;
    case 'array':
      base.type = Type.ARRAY;
      if (prop.items) {
        base.items = { type: prop.items.type === 'number' ? Type.NUMBER : Type.STRING };
      }
      return base;
    case 'object':
      base.type = Type.OBJECT;
      return base;
    default:
      base.type = Type.STRING;
      return base;
  }
}
