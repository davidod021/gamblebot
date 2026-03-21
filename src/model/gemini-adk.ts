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

  constructor(systemPrompt: string, toolDefs: ToolDefinition[]) {
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
            // Return parsed JSON if possible, otherwise wrap in object
            try {
              return JSON.parse(result) as Record<string, unknown>;
            } catch {
              return { result };
            }
          },
        }),
    );

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
      tools: [new AgentTool({ agent: researchAgent }), ...functionTools],
    });

    this.sessionService = new InMemorySessionService();
    this.runner = new Runner({
      agent,
      sessionService: this.sessionService,
      appName: this.appName,
    });
  }

  async send(userMessage: string): Promise<ModelResponse> {
    const content: ContentBlock[] = [];

    for await (const event of this.runner.runEphemeral({
      userId: this.userId,
      newMessage: { role: 'user', parts: [{ text: userMessage }] },
    })) {
      const parts = event.content?.parts ?? [];

      // Log intermediate tool calls
      const functionCalls = getFunctionCalls(event);
      if (functionCalls.length > 0) {
        for (const fc of functionCalls) {
          if (fc.name !== 'google_search') {
            // Betfair tool calls are already logged in execute()
            // Google Search calls we log here
          } else {
            const query = (fc.args as Record<string, unknown>)?.query ?? '';
            console.log(`\n[GOOGLE SEARCH] ${query}`);
          }
        }
      }

      // Log thinking and text from intermediate events
      for (const part of parts) {
        if (part.thought && part.text) {
          const preview = part.text.slice(0, 400);
          console.log(`\n[THINKING] ${preview}${part.text.length > 400 ? '…' : ''}`);
        } else if (part.text && !part.thought && !isFinalResponse(event)) {
          // Intermediate agent text (e.g. reasoning before tool calls)
          console.log(`\n[AGENT] ${part.text}`);
        }
      }

      // Collect final response
      if (isFinalResponse(event)) {
        for (const part of parts) {
          if (part.thought && part.text) {
            content.push({ type: 'thinking', thinking: part.text });
          } else if (part.text && !part.thought) {
            content.push({ type: 'text', text: part.text });
          }
        }
      }
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
