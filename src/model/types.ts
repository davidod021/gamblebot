/**
 * Provider-agnostic types for the model session abstraction.
 * Both Anthropic and Gemini sessions implement ModelSession.
 */

// ─── Normalised tool schema ────────────────────────────────────────────────────

/** JSON Schema property descriptor (subset we actually use). */
export interface SchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: string[];
  items?: { type: string };
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, SchemaProperty>;
    required: string[];
  };
}

// ─── Normalised response types ─────────────────────────────────────────────────

export type StopReason = 'end_turn' | 'tool_use' | 'pause_turn';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ThinkingBlock;

export interface ModelResponse {
  stopReason: StopReason;
  content: ContentBlock[];
}

// ─── Tool result ───────────────────────────────────────────────────────────────

export interface ToolResult {
  toolUseId: string;
  content: string;
}

// ─── Session interface ─────────────────────────────────────────────────────────

/**
 * A stateful model session. Each provider maintains its own native message
 * history format internally — callers only see normalised ContentBlock[].
 */
export interface ModelSession {
  /** Send the first (or next) user message. */
  send(userMessage: string): Promise<ModelResponse>;
  /** Feed tool results back after a tool_use stop. */
  submitToolResults(results: ToolResult[]): Promise<ModelResponse>;
  /**
   * Re-send with an empty user turn after pause_turn (Anthropic server-side
   * tool limit). Gemini does not emit pause_turn so this is a no-op there.
   */
  resume(): Promise<ModelResponse>;
}
