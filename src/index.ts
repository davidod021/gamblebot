import { runAgent } from './agent.js';
import { sendNotification } from './approval/telegram.js';

async function main(): Promise<void> {
  try {
    await runAgent();
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;

    console.error('Fatal error:', message);
    if (stack) console.error(stack);

    await sendNotification(`❌ *GambleBot Fatal Error*\n\n\`${message}\``);
    process.exit(1);
  }
}

main();
