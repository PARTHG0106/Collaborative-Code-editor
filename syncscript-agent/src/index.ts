#!/usr/bin/env node
import { Command } from 'commander';
import { AgentServer } from './server.js';
import { detectRuntimes } from './runtimes.js';

const program = new Command();

program
  .name('syncscript-agent')
  .description('SyncScript Local Execution Agent — Run code on your machine from the browser IDE')
  .version('1.0.0')
  .option('-p, --port <port>', 'WebSocket port', '9876')
  .action(async (opts) => {
    const port = parseInt(opts.port);

    console.log('');
    console.log('  ╔══════════════════════════════════════╗');
    console.log('  ║   SyncScript Local Execution Agent   ║');
    console.log('  ╚══════════════════════════════════════╝');
    console.log('');
    console.log('  Detecting installed runtimes...');
    console.log('');

    const runtimes = detectRuntimes();

    if (runtimes.length === 0) {
      console.log('  ⚠  No runtimes detected.');
      console.log('     Install Node.js, Python, GCC, or Java to enable local execution.');
    } else {
      console.log('  Detected runtimes:');
      for (const rt of runtimes) {
        console.log(`    ✓ ${rt.name} (${rt.language}) — ${rt.version}`);
      }
    }

    console.log('');

    const server = new AgentServer({ port, runtimes });
    server.start();

    console.log(`  ✅ Agent listening on ws://localhost:${port}`);
    console.log('  Open SyncScript IDE in your browser to connect.');
    console.log('');
    console.log('  Press Ctrl+C to stop.');
    console.log('');

    // Graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n  Shutting down...');
      server.stop();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      server.stop();
      process.exit(0);
    });
  });

program.parse();
