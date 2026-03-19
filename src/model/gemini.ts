import { GoogleGenAI, Type } from '@google/genai';
import { config } from '../config.js';
import type {
  ModelSession,
  ModelResponse,
  ToolResult,
  ToolDefinition,
  ContentBlock,
  SchemaProperty,
} from './types.js';

// Gemini doesn't have native tool-call IDs, so we generate short ones
let _idCounter = 0;
function newId(): string {
  return `fc_${Date.now()}_${++_idCounter}`;
}

export class GeminiSession implements ModelSession {
  private readonly ai: GoogleGenAI;
  private readonly systemPrompt: string;
  private readonly tools: object[];
  private readonly functionDeclarations: object[];
  // Native Gemini conversation history
  private history: object[] = [];

  constructor(systemPrompt: string, toolDefs: ToolDefinition[]) {
    this.ai = new GoogleGenAI({ apiKey: config.model.geminiApiKey });
    this.systemPrompt = systemPrompt;
    this.functionDeclarations = toolDefs.map(this._convertTool);
    this.tools = [
      { googleSearch: {} },                            // grounding — Gemini's web search
      { functionDeclarations: this.functionDeclarations },
    ];
  }

  async send(userMessage: string): Promise<ModelResponse> {
    this.history.push({ role: 'user', parts: [{ text: userMessage }] });
    return this._call();
  }

  async submitToolResults(results: ToolResult[]): Promise<ModelResponse> {
    // Gemini expects function responses as separate parts in a user turn
    const parts = results.map((r) => ({
      functionResponse: {
        name: r.toolUseId,   // we stored the function name as the "id"
        response: { result: r.content },
      },
    }));
    this.history.push({ role: 'user', parts });
    return this._call();
  }

  // Gemini doesn't have a pause_turn concept — this is a no-op that re-sends
  async resume(): Promise<ModelResponse> {
    return this._call();
  }

  private async _call(): Promise<ModelResponse> {
    const response = await (this.ai as unknown as {
      models: {
        generateContent: (params: object) => Promise<{
          candidates?: Array<{
            content: { role: string; parts: Array<{
              text?: string;
              thought?: boolean;
              functionCall?: { name: string; args: Record<string, unknown> };
            }> };
            finishReason?: string;
          }>;
        }>;
      };
    }).models.generateContent({
      model: config.model.geminiModel,
      contents: this.history,
      config: {
        systemInstruction: this.systemPrompt,
        tools: this.tools,
        thinkingConfig: { thinkingBudget: -1 }, // adaptive thinking
      },
    });

    const candidate = response.candidates?.[0];
    if (!candidate) {
      return { stopReason: 'end_turn', content: [] };
    }

    const parts = candidate.content?.parts ?? [];
    const content: ContentBlock[] = [];
    const hasFunctionCall = parts.some((p) => p.functionCall);

    // Map Gemini's function call IDs → our tool-use IDs
    // We use the function name as the ID (same we'll receive back in submitToolResults)
    const functionCallIds = new Map<string, string>();

    for (const part of parts) {
      if (part.thought && part.text) {
        content.push({ type: 'thinking', thinking: part.text });
      } else if (part.text && !part.thought) {
        content.push({ type: 'text', text: part.text });
      } else if (part.functionCall) {
        // Generate a unique ID for this call
        const id = newId();
        functionCallIds.set(part.functionCall.name, id);
        content.push({
          type: 'tool_use',
          id,
          name: part.functionCall.name,
          input: part.functionCall.args ?? {},
        });
      }
    }

    // Append assistant turn to history
    this.history.push({ role: 'model', parts });

    const finishReason = candidate.finishReason ?? '';
    let stopReason: ModelResponse['stopReason'] = 'end_turn';
    if (hasFunctionCall || finishReason === 'STOP' && content.some((b) => b.type === 'tool_use')) {
      stopReason = 'tool_use';
    } else if (finishReason === 'MAX_TOKENS') {
      stopReason = 'end_turn';
    }

    // Override: if there are tool_use blocks, always treat as tool_use
    if (content.some((b) => b.type === 'tool_use')) {
      stopReason = 'tool_use';
    }

    return { stopReason, content };
  }

  private _convertTool(def: ToolDefinition): object {
    const properties: Record<string, object> = {};
    for (const [key, prop] of Object.entries(def.input_schema.properties)) {
      properties[key] = convertProperty(prop);
    }
    return {
      name: def.name,
      description: def.description,
      parameters: {
        type: Type.OBJECT,
        properties,
        required: def.input_schema.required,
      },
    };
  }
}

function convertProperty(prop: SchemaProperty): object {
  const base: Record<string, unknown> = { description: prop.description };
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
        base.items = { type: prop.items.type === 'string' ? Type.STRING : Type.NUMBER };
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
