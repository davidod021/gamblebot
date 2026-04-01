import crypto from 'node:crypto';
import { FunctionTool } from '@google/adk';
import { Type } from '@google/genai';
import type { Schema } from '@google/genai';
import { ClientFactory } from '@a2a-js/sdk/client';
import type { Message, Task } from '@a2a-js/sdk';
import { sendNotification } from '../approval/index.js';

export interface SpecialistUrls {
  football?: string;
  cricket?: string;
  rugby?: string;
}

const A2A_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 60000} minutes`)), ms),
    ),
  ]);
}

function extractText(result: Message | Task): string {
  if ('kind' in result && result.kind === 'message') {
    return (result as Message).parts
      .filter((p): p is { kind: 'text'; text: string } & object => p.kind === 'text')
      .map((p) => (p as { kind: 'text'; text: string }).text)
      .join('\n');
  }
  return JSON.stringify(result);
}

function createSpecialistTool(
  sport: string,
  description: string,
  agentUrl: string,
): FunctionTool {
  const factory = new ClientFactory();
  // Cache the client after first connection
  let cachedClient: Awaited<ReturnType<typeof factory.createFromUrl>> | null = null;

  return new FunctionTool({
    name: `consult_${sport}_specialist`,
    description,
    parameters: {
      type: Type.OBJECT,
      properties: {
        task: {
          type: Type.STRING,
          description:
            'The analysis task to delegate, e.g. "Identify value betting opportunities in upcoming football markets for today."',
        },
      },
      required: ['task'],
    } as Schema,
    execute: async (args: unknown) => {
      const { task } = args as { task: string };
      console.log(`\n[A2A] Consulting ${sport} specialist at ${agentUrl}`);
      try {
        if (!cachedClient) {
          cachedClient = await factory.createFromUrl(agentUrl);
        }
        const result = await withTimeout(
          cachedClient.sendMessage({
            message: {
              kind: 'message',
              messageId: crypto.randomUUID(),
              role: 'user',
              parts: [{ kind: 'text', text: task }],
            },
          }),
          A2A_TIMEOUT_MS,
          `${sport} specialist`,
        );
        const text = extractText(result);
        console.log(`[A2A] ${sport} specialist responded (${text.length} chars)`);
        const displayName = `${sport.charAt(0).toUpperCase() + sport.slice(1)} Specialist`;
        const preview = text.length > 400 ? text.slice(0, 400) + '…' : text;
        await sendNotification(`📡 *A2A: ${displayName}*\n\nReceived analysis from *${displayName}*:\n\n${preview}`);
        return { analysis: text };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[A2A] ${sport} specialist error: ${message}`);
        return { error: message, analysis: `Failed to reach ${sport} specialist: ${message}` };
      }
    },
  });
}

async function connectWithRetry(
  factory: ClientFactory,
  url: string,
  retries = 5,
  delayMs = 3000,
): Promise<Awaited<ReturnType<ClientFactory['createFromUrl']>>> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await factory.createFromUrl(url);
    } catch (err) {
      if (attempt === retries) throw err;
      console.log(`[A2A] Peer not ready, retrying in ${delayMs / 1000}s (${attempt}/${retries})...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('unreachable');
}

async function fetchPeerName(peerUrl: string): Promise<string> {
  try {
    const res = await fetch(`${peerUrl}/.well-known/agent-card.json`);
    if (res.ok) {
      const card = await res.json() as { name?: string };
      return card.name ?? 'Peer Agent';
    }
  } catch {
    // ignore — fall back to default
  }
  return 'Peer Agent';
}

export function createPeerTool(peerUrl: string): FunctionTool {
  const factory = new ClientFactory();
  let cachedClient: Awaited<ReturnType<typeof factory.createFromUrl>> | null = null;
  let cachedPeerName: string | null = null;

  return new FunctionTool({
    name: 'consult_peer',
    description:
      'Consult a remote peer GambleBot agent to pool research. The peer has its own model session ' +
      'and can independently research markets, check odds, and assess value. Use this to get a ' +
      'second opinion or delegate research on specific sports/markets. The peer cannot place bets.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        task: {
          type: Type.STRING,
          description:
            'The research task to delegate, e.g. "Research upcoming cricket markets and identify any value opportunities."',
        },
      },
      required: ['task'],
    } as Schema,
    execute: async (args: unknown) => {
      const { task } = args as { task: string };
      console.log(`\n[A2A] Consulting peer at ${peerUrl}`);
      try {
        if (!cachedClient) {
          [cachedClient, cachedPeerName] = await Promise.all([
            connectWithRetry(factory, peerUrl),
            fetchPeerName(peerUrl),
          ]);
        }
        const result = await withTimeout(
          cachedClient.sendMessage({
            message: {
              kind: 'message',
              messageId: crypto.randomUUID(),
              role: 'user',
              parts: [{ kind: 'text', text: task }],
            },
          }),
          A2A_TIMEOUT_MS,
          'Peer agent',
        );
        const text = extractText(result);
        const peerName = cachedPeerName ?? 'Peer Agent';
        console.log(`[A2A] Peer responded (${text.length} chars)`);
        const preview = text.length > 400 ? text.slice(0, 400) + '…' : text;
        await sendNotification(`📡 *A2A: ${peerName}*\n\nReceived analysis from *${peerName}*:\n\n${preview}`);
        return { analysis: text };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[A2A] Peer error: ${message}`);
        return { error: message, analysis: `Failed to reach peer: ${message}` };
      }
    },
  });
}

export function createSpecialistTools(urls: SpecialistUrls): FunctionTool[] {
  const tools: FunctionTool[] = [];

  if (urls.football) {
    tools.push(
      createSpecialistTool(
        'football',
        'Consult the remote football specialist agent to analyse upcoming football markets (Premier League, Championship, FA Cup, Scottish Premiership) and identify value betting opportunities. Returns structured JSON findings with specific market IDs, selection details, estimated probabilities and edges.',
        urls.football,
      ),
    );
  }

  if (urls.cricket) {
    tools.push(
      createSpecialistTool(
        'cricket',
        'Consult the remote cricket specialist agent to analyse upcoming cricket markets (Tests, ODIs, T20s, The Hundred, County Championship) and identify value bets. Includes weather and pitch research.',
        urls.cricket,
      ),
    );
  }

  if (urls.rugby) {
    tools.push(
      createSpecialistTool(
        'rugby',
        'Consult the remote rugby specialist agent to analyse upcoming rugby union and rugby league markets (Premiership, Six Nations, Super League) and identify value betting opportunities.',
        urls.rugby,
      ),
    );
  }

  return tools;
}
