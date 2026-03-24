import { runAgent } from './agent.js';
import { sendNotification } from './approval/index.js';
import { config } from './config.js';
import type http from 'node:http';

async function main(): Promise<void> {
  try {
    // Start peer A2A server if configured (runs alongside any mode)
    let peerServer: http.Server | undefined;
    if (config.a2a.peerPort) {
      peerServer = await startPeerServer(config.a2a.peerPort);
    }

    if (config.a2a.role === 'specialist') {
      await runSpecialist();
      // Server keeps the process alive — no process.exit here
    } else if (config.a2a.role === 'coordinator') {
      await runCoordinator();
      await shutdownPeerServer(peerServer);
      process.exit(0);
    } else {
      await runStandalone();
      await shutdownPeerServer(peerServer);
      process.exit(0);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;

    console.error('Fatal error:', message);
    if (stack) console.error(stack);

    await sendNotification(`❌ *GambleBot Fatal Error*\n\n\`${message}\``);
    process.exit(1);
  }
}

async function runSpecialist(): Promise<void> {
  const { sport, port } = config.a2a;
  if (!sport) throw new Error('A2A_SPORT must be set when A2A_ROLE=specialist (football|cricket|rugby)');

  const { SportSpecialistExecutor } = await import('./a2a/specialist-executor.js');
  const { startA2AServer, buildAgentCard } = await import('./a2a/server.js');

  const sportDescriptions: Record<string, string> = {
    football: 'Analyses British football markets (Premier League, Championship, FA Cup) and identifies value bets',
    cricket: 'Analyses British cricket markets (Tests, ODIs, T20s, The Hundred) including weather research',
    rugby: 'Analyses British rugby markets (Premiership, Six Nations, Super League) and identifies value bets',
  };

  const executor = new SportSpecialistExecutor(sport);
  const agentCard = buildAgentCard(sport, port, sportDescriptions[sport] ?? `${sport} specialist`);
  startA2AServer(executor, agentCard, port);

  console.log(`\n[A2A] ${sport} specialist ready. Ctrl+C to stop.`);
}

async function runCoordinator(): Promise<void> {
  const { footballUrl, cricketUrl, rugbyUrl } = config.a2a;
  const hasAnyPeer = footballUrl || cricketUrl || rugbyUrl;

  if (!hasAnyPeer) {
    console.warn('[A2A] Coordinator mode: no specialist URLs configured. Running as standard agent.');
    await runAgent();
    return;
  }

  const { createSpecialistTools } = await import('./a2a/client-tools.js');
  const extraFunctionTools = createSpecialistTools({
    football: footballUrl,
    cricket: cricketUrl,
    rugby: rugbyUrl,
  });

  const sportList = [
    footballUrl ? 'football' : null,
    cricketUrl ? 'cricket' : null,
    rugbyUrl ? 'rugby' : null,
  ]
    .filter(Boolean)
    .join(', ');

  const systemPromptSuffix = `## A2A Specialist Agents

You are running in coordinator mode with access to specialist agents for: **${sportList}**.

Use the \`consult_*_specialist\` tools to delegate sport-specific market analysis in parallel. Each specialist will:
- Search their sport's upcoming markets on Betfair
- Research team news, form, injuries, and conditions
- Return structured JSON with value bets found, including market IDs, selection IDs, estimated edges, and reasoning

**Recommended workflow:**
1. Call all available specialist tools (you can do this simultaneously or in sequence)
2. Review their findings — check the identified market IDs with \`get_market_odds\` to confirm current prices
3. Rank opportunities by edge and confidence across all sports
4. Apply the staking strategy (use \`calculate_stake\`) and place the best bets
5. Avoid placing more than one bet per event; respect the session limit of 3–4 bets total

The specialists handle research; you handle final validation and execution.`;

  console.log(`\n[A2A] Coordinator mode — connected specialists: ${sportList}`);
  await runAgent({ extraFunctionTools, systemPromptSuffix });
}

async function runStandalone(): Promise<void> {
  const { peerUrl } = config.a2a;

  if (!peerUrl) {
    await runAgent();
    return;
  }

  // Peer URL configured — add a consult_peer tool so this agent can query the remote peer
  const { createPeerTool } = await import('./a2a/client-tools.js');
  const peerTool = createPeerTool(peerUrl);

  const systemPromptSuffix = `## A2A Peer Agent

You have access to a remote peer GambleBot agent via the \`consult_peer\` tool.

The peer is another instance running its own analysis independently. Use it to **pool research**:
- Delegate specific sports or markets to the peer for a second opinion
- Ask the peer to research markets you don't have time to cover
- Compare your findings with the peer's analysis to increase confidence

The peer can research markets and check odds but **cannot place bets** — only you can do that.

**Recommended workflow:**
1. Start your own research on the most promising markets
2. In parallel, delegate other sports/markets to the peer via \`consult_peer\`
3. Compare findings — if both you and the peer identify value in the same market, that's higher confidence
4. Make final betting decisions based on the combined research`;

  console.log(`\n[A2A] Standalone + peer mode — peer at ${peerUrl}`);
  await runAgent({ extraFunctionTools: [peerTool], systemPromptSuffix });
}

async function startPeerServer(port: number): Promise<http.Server> {
  const { PeerExecutor } = await import('./a2a/peer-executor.js');
  const { startA2AServer, buildAgentCard } = await import('./a2a/server.js');

  const executor = new PeerExecutor();
  const agentCard = buildAgentCard(
    'peer',
    port,
    'GambleBot peer agent — shares market research and analysis via A2A. Read-only: cannot place bets.',
  );

  const server = startA2AServer(executor, agentCard, port);
  console.log(`[A2A PEER] Server ready on port ${port}. Remote agents can connect to share research.`);
  return server;
}

async function shutdownPeerServer(server: http.Server | undefined): Promise<void> {
  if (!server) return;
  console.log('[A2A PEER] Draining in-flight requests...');
  await new Promise<void>((resolve) => {
    // Stop accepting new connections; existing requests finish naturally
    server.close(() => resolve());
    // Safety timeout — don't hang forever if a request is stuck
    setTimeout(() => {
      console.warn('[A2A PEER] Shutdown timeout — forcing close.');
      resolve();
    }, 300_000);
  });
  console.log('[A2A PEER] Server shut down.');
}

main();
