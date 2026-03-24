import { config } from '../config.js';
import { AnthropicSession } from './anthropic.js';
import { GeminiSession } from './gemini.js';
import { GeminiAdkSession } from './gemini-adk.js';
import type { FunctionTool } from '@google/adk';
import type { ModelSession, ToolDefinition } from './types.js';

export { type ModelSession, type ToolDefinition };
export type { ContentBlock, TextBlock, ToolUseBlock, ThinkingBlock, ToolResult, ModelResponse, StopReason } from './types.js';

export function createSession(
  systemPrompt: string,
  tools: ToolDefinition[],
  extraFunctionTools: FunctionTool[] = [],
): ModelSession {
  if (config.model.provider === 'gemini-adk') {
    console.log(`Model: Gemini ADK (${config.model.geminiModel}) with Google Search`);
    return new GeminiAdkSession(systemPrompt, tools, extraFunctionTools);
  }
  if (config.model.provider === 'gemini') {
    console.log(`Model: Gemini (${config.model.geminiModel})`);
    return new GeminiSession(systemPrompt, tools);
  }
  console.log(`Model: Anthropic (${config.model.anthropicModel})`);
  return new AnthropicSession(systemPrompt, tools);
}
