import http from 'node:http';
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  DefaultExecutionEventBusManager,
  JsonRpcTransportHandler,
} from '@a2a-js/sdk/server';
import type { AgentExecutor } from '@a2a-js/sdk/server';
import type { AgentCard } from '@a2a-js/sdk';

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function startA2AServer(
  executor: AgentExecutor,
  agentCard: AgentCard,
  port: number,
): http.Server {
  const requestHandler = new DefaultRequestHandler(
    agentCard,
    new InMemoryTaskStore(),
    executor,
    new DefaultExecutionEventBusManager(),
  );
  const transportHandler = new JsonRpcTransportHandler(requestHandler);

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Serve agent card at the well-known path
    if (req.url === '/.well-known/agent-card.json' && req.method === 'GET') {
      const card = await requestHandler.getAgentCard();
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify(card));
      return;
    }

    // Handle JSON-RPC A2A requests
    if (req.method === 'POST') {
      try {
        const body = await readBody(req);
        const result = await transportHandler.handle(JSON.parse(body) as unknown);

        if (
          result !== null &&
          typeof result === 'object' &&
          Symbol.asyncIterator in result
        ) {
          // Streaming response via SSE
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.writeHead(200);
          for await (const chunk of result as AsyncGenerator<unknown>) {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
          res.end();
        } else {
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(200);
          res.end(JSON.stringify(result));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[A2A Server] Request error:', message);
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(500);
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  server.listen(port, () => {
    console.log(`[A2A] ${agentCard.name} listening on http://localhost:${port}`);
  });

  return server;
}

export function buildAgentCard(
  sport: string,
  port: number,
  description: string,
  agentName = 'GambleBot',
): AgentCard {
  const roleName = sport.charAt(0).toUpperCase() + sport.slice(1);
  const cardName = sport === 'peer' ? `${agentName} Peer Agent` : `${agentName} ${roleName} Specialist`;
  return {
    name: cardName,
    description,
    version: '1.0.0',
    protocolVersion: '0.2.6',
    url: `http://localhost:${port}`,
    capabilities: {
      streaming: false,
    },
    skills: [
      {
        id: `${sport}-analysis`,
        name: `${sport.charAt(0).toUpperCase() + sport.slice(1)} Market Analysis`,
        description: `Analyse upcoming ${sport} markets and identify value betting opportunities`,
        tags: [sport, 'betting', 'analysis'],
      },
    ],
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
  };
}
