import { config } from '../config.js';
import { AnthropicSession } from './anthropic.js';
import { GeminiSession } from './gemini.js';
import type { ModelSession, ToolDefinition } from './types.js';

export { type ModelSession, type ToolDefinition };
export type { ContentBlock, TextBlock, ToolUseBlock, ThinkingBlock, ToolResult, ModelResponse, StopReason } from './types.js';

export function createSession(systemPrompt: string, tools: ToolDefinition[]): ModelSession {
  if (config.model.provider === 'gemini') {
    console.log(`Model: Gemini (${config.model.geminiModel})`);
    return new GeminiSession(systemPrompt, tools);
  }
  console.log(`Model: Anthropic (${config.model.anthropicModel})`);
  return new AnthropicSession(systemPrompt, tools);
}
