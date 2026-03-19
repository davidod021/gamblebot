import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import type {
  ModelSession,
  ModelResponse,
  ToolResult,
  ToolDefinition,
  ContentBlock,
  StopReason,
} from './types.js';

export class AnthropicSession implements ModelSession {
  private readonly client: Anthropic;
  private readonly systemPrompt: string;
  private readonly tools: Anthropic.Tool[];
  private messages: Anthropic.MessageParam[] = [];

  constructor(systemPrompt: string, toolDefs: ToolDefinition[]) {
    this.client = new Anthropic({ apiKey: config.model.anthropicApiKey });
    this.systemPrompt = systemPrompt;

    this.tools = [
      // Server-side web search — no client handler needed
      { type: 'web_search_20260209', name: 'web_search' } as unknown as Anthropic.Tool,
      // Cast our generic ToolDefinition[] — Anthropic accepts this shape exactly
      ...(toolDefs as unknown as Anthropic.Tool[]),
    ];
  }

  async send(userMessage: string): Promise<ModelResponse> {
    this.messages.push({ role: 'user', content: userMessage });
    return this._call();
  }

  async submitToolResults(results: ToolResult[]): Promise<ModelResponse> {
    const toolResults: Anthropic.ToolResultBlockParam[] = results.map((r) => ({
      type: 'tool_result',
      tool_use_id: r.toolUseId,
      content: r.content,
    }));
    this.messages.push({ role: 'user', content: toolResults });
    return this._call();
  }

  async resume(): Promise<ModelResponse> {
    // pause_turn: Anthropic server-side web search hit its iteration limit.
    // Re-send with an empty user turn to let it continue.
    this.messages.push({ role: 'user', content: [] });
    return this._call();
  }

  private async _call(): Promise<ModelResponse> {
    const response = await this.client.messages.create({
      model: config.model.anthropicModel,
      max_tokens: 8192,
      thinking: { type: 'adaptive' } as never,
      system: this.systemPrompt,
      tools: this.tools,
      messages: this.messages,
    });

    // Always store the full assistant response (thinking blocks need their
    // `signature` field preserved for multi-turn conversations)
    this.messages.push({ role: 'assistant', content: response.content });

    const content = this._normalise(response.content);
    const stopReason = this._stopReason(response.stop_reason);

    return { stopReason, content };
  }

  private _normalise(blocks: Anthropic.ContentBlock[]): ContentBlock[] {
    const result: ContentBlock[] = [];
    for (const block of blocks) {
      if (block.type === 'thinking') {
        result.push({ type: 'thinking', thinking: block.thinking });
      } else if (block.type === 'text') {
        result.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        result.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
      // server_tool_use blocks (web_search) are kept in messages[] by Anthropic
      // but we don't need to expose them to the agent loop
    }
    return result;
  }

  private _stopReason(reason: string | null): StopReason {
    if (reason === 'tool_use') return 'tool_use';
    if (reason === 'pause_turn') return 'pause_turn';
    return 'end_turn';
  }
}
