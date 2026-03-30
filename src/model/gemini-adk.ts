import {
  LlmAgent,
  AgentTool,
  FunctionTool,
  GOOGLE_SEARCH,
  Runner,
  InMemorySessionService,
  isFinalResponse,
  getFunctionCalls,
} from '@google/adk';
import { Type } from '@google/genai';
import type { Schema } from '@google/genai';
import { config } from '../config.js';
import { executeTool } from '../tools/betfair-tools.js';
import type {
  ModelSession,
  ModelResponse,
  ToolResult,
  ToolDefinition,
  ContentBlock,
  SchemaProperty,
} from './types.js';

export class GeminiAdkSession implements ModelSession {
  private readonly runner: Runner;
  private readonly sessionService: InMemorySessionService;
  private readonly userId = 'gamblebot-user';
  private readonly appName = 'gamblebot';
  private capturedSummary: string | null = null;

  constructor(systemPrompt: string, toolDefs: ToolDefinition[], extraFunctionTools: FunctionTool[] = []) {
    const functionTools = toolDefs.map(
      (def) =>
        new FunctionTool({
          name: def.name,
          description: def.description,
          parameters: convertToSchema(def) as Schema,
          execute: async (args: unknown) => {
            const input = args as Record<string, unknown>;
            console.log(`\n[TOOL USE] ${def.name}`);
            const inputPreview = JSON.stringify(input, null, 2).slice(0, 300);
            console.log(inputPreview);
            const result = await executeTool(def.name, input);
            const preview = result.slice(0, 300);
            console.log(`[RESULT] ${preview}${result.length > 300 ? '…' : ''}`);
            // Gemini function responses must be objects, not arrays.
            // Wrap arrays in { items: [...] } and parse failures in { result }.
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

    // Tool the model MUST call at the end to submit its written analysis
    const submitAnalysisTool = new FunctionTool({
      name: 'submit_analysis',
      description:
        'REQUIRED: Call this tool at the end of your session to submit your written analysis. Include a full summary of markets examined, research done, any value bets identified, and reasoning for bets placed or skipped.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          summary: {
            type: Type.STRING,
            description:
              'Full written analysis: markets examined, research findings, value bets identified (or why none were placed).',
          },
        },
        required: ['summary'],
      } as Schema,
      execute: async (args: unknown) => {
        const { summary } = args as { summary: string };
        this.capturedSummary = summary;
        console.log(`\n[AGENT SUMMARY]\n${summary}`);
        return { status: 'ok' };
      },
    });

    // Sub-agent with only GOOGLE_SEARCH — avoids the Gemini API restriction
    // that prevents built-in tools and function declarations in the same request.
    const researchAgent = new LlmAgent({
      name: 'research_sports_news',
      description: 'Search the web for sports news, team form, injury updates, weather forecasts, and expert analysis. Pass a specific research question and receive a detailed summary.',
      model: config.model.geminiModel,
      instruction: 'You are a sports research assistant. Search the web thoroughly to answer the research question provided. Return a detailed, factual summary covering all relevant findings.',
      tools: [GOOGLE_SEARCH],
    });

    const agent = new LlmAgent({
      name: 'gamblebot',
      model: config.model.geminiModel,
      instruction: systemPrompt,
      tools: [new AgentTool({ agent: researchAgent }), ...functionTools, ...extraFunctionTools, submitAnalysisTool],
      afterModelCallback: ({ response }) => {
        // If the model returns with no content and no function calls, it has
        // silently terminated. Inject a submit_analysis call so the loop
        // continues and we capture a summary.
        const hasFunctionCalls = response.content?.parts?.some(
          (p) => (p as Record<string, unknown>).functionCall,
        );
        const hasText = response.content?.parts?.some((p) => p.text && !p.thought);
        if (!hasFunctionCalls && !hasText && !response.content) {
          console.log('[ADK] Empty response intercepted — injecting submit_analysis call');
          return {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'submit_analysis',
                    args: {
                      summary:
                        'No value betting opportunities were identified in today\'s available markets. ' +
                        'The markets available had insufficient liquidity or did not meet the minimum edge threshold required for the current Bootstrap phase (3% minimum edge). No bets were placed.',
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
      appName: this.appName,
    });
  }

  async send(userMessage: string): Promise<ModelResponse> {
    this.capturedSummary = null;
    const content: ContentBlock[] = [];

    for await (const event of this.runner.runEphemeral({
      userId: this.userId,
      newMessage: { role: 'user', parts: [{ text: userMessage }] },
    })) {
      const parts = event.content?.parts ?? [];

      // Log Google Search calls
      const functionCalls = getFunctionCalls(event);
      for (const fc of functionCalls) {
        if (fc.name === 'google_search') {
          const query = (fc.args as Record<string, unknown>)?.query ?? '';
          console.log(`\n[GOOGLE SEARCH] ${query}`);
        }
      }

      // Surface ADK-level errors (e.g. invalid API key, quota exceeded)
      const ev = event as unknown as Record<string, unknown>;
      if (ev.errorCode) {
        throw new Error(`[ADK] Model error ${ev.errorCode}: ${ev.errorMessage ?? 'unknown error'}`);
      }

      // Collect and log all text/thinking from every event
      for (const part of parts) {
        if (part.thought && part.text) {
          const preview = part.text.slice(0, 400);
          console.log(`\n[THINKING] ${preview}${part.text.length > 400 ? '…' : ''}`);
          if (isFinalResponse(event)) {
            content.push({ type: 'thinking', thinking: part.text });
          }
        } else if (part.text && !part.thought) {
          console.log(`\n[AGENT] ${part.text}`);
          content.push({ type: 'text', text: part.text });
        }
      }
    }

    // If the model called submit_analysis, use that as the text content
    if (this.capturedSummary && !content.some((b) => b.type === 'text')) {
      content.push({ type: 'text', text: this.capturedSummary });
    }

    return { stopReason: 'end_turn', content };
  }

  // ADK handles all tool calls internally — these are no-ops
  async submitToolResults(_results: ToolResult[]): Promise<ModelResponse> {
    return { stopReason: 'end_turn', content: [] };
  }

  async resume(): Promise<ModelResponse> {
    return { stopReason: 'end_turn', content: [] };
  }
}

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
