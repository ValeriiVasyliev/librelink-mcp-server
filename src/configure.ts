#!/usr/bin/env node

import * as readline from 'readline';
import { ConfigManager } from './config.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(query, resolve);
  });
}

/**
 * Prompt without echoing the answer, so a password never lands in the
 * terminal scrollback of whoever runs `npm run configure`.
 *
 * readline has no public masking option; overriding `_writeToOutput` is the
 * established way to do this. The prompt itself is still echoed — only the
 * characters the user types are swallowed.
 */
function secretQuestion(query: string): Promise<string> {
  return new Promise(resolve => {
    const internal = rl as unknown as { _writeToOutput?: (chunk: string) => void };
    const originalWrite = internal._writeToOutput;

    internal._writeToOutput = function (chunk: string) {
      if (chunk.includes(query)) {
        originalWrite?.call(internal, chunk);
      }
    };

    rl.question(query, answer => {
      internal._writeToOutput = originalWrite;
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  console.log('LibreLink MCP Server Configuration');
  console.log('==================================\n');

  const configManager = new ConfigManager();
  const currentConfig = configManager.getConfig();

  // Configure credentials
  const email = await question(`LibreLink email (current: ${currentConfig.credentials.email || 'not set'}): `);
  const password = await secretQuestion(
    `LibreLink password (${currentConfig.credentials.password ? 'press Enter to keep the current one' : 'not set'}): `
  );
  
  // Configure region
  console.log('\nAvailable regions:');
  console.log('1. US (United States)');
  console.log('2. EU (Europe)');
  const regionChoice = await question(`Choose region (1 or 2, current: ${currentConfig.client.region}): `);
  const region = regionChoice === '2' ? 'EU' : 'US';

  // Configure target ranges
  const targetLow = await question(`Target glucose low (mg/dL, current: ${currentConfig.ranges.target_low}): `);
  const targetHigh = await question(`Target glucose high (mg/dL, current: ${currentConfig.ranges.target_high}): `);

  // Update configuration. A blank answer keeps the stored value, so that
  // re-running configure to change only the region cannot wipe a credential.
  const nextEmail = email.trim() || currentConfig.credentials.email;
  const nextPassword = password || currentConfig.credentials.password;

  if (nextEmail !== currentConfig.credentials.email || nextPassword !== currentConfig.credentials.password) {
    configManager.updateCredentials(nextEmail, nextPassword);
  }


  configManager.updateRegion(region as 'US' | 'EU');
  
  if (targetLow.trim() && targetHigh.trim()) {
    const low = parseInt(targetLow);
    const high = parseInt(targetHigh);
    if (!isNaN(low) && !isNaN(high)) {
      configManager.updateRanges(low, high);
    }
  }

  // Validate configuration
  const errors = configManager.validateConfig();
  if (errors.length > 0) {
    console.log('\n❌ Configuration errors:');
    errors.forEach(error => console.log(`  - ${error}`));
    rl.close();
    process.exit(1);
  }

  console.log('\n✅ Configuration saved successfully!');
  console.log('\nNext steps:');
  console.log('1. Add this server to your Claude Desktop configuration');
  console.log('2. Restart Claude Desktop');
  console.log('3. Test the connection using the validate_connection tool');

  rl.close();
}

main().catch(console.error);