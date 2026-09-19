#!/usr/bin/env node

import { LibreLinkUpApi, LibreLinkApiError, MINIMUM_LLU_VERSION } from './dist/librelink-api.js';
import { ConfigManager } from './dist/config.js';

/**
 * Diagnose a configured LibreLink Up account: authentication, the headers the
 * API now requires, and whether any patient data is actually shared with it.
 * Prints no passwords, tokens or glucose values.
 */

async function diagnoseAccount() {
  console.log('🔍 LibreLink Account Diagnostic');
  console.log('==============================\n');

  const configManager = new ConfigManager();

  if (!configManager.isConfigured()) {
    console.log('❌ No credentials configured. Run: npm run configure');
    return;
  }

  const config = configManager.getConfig();
  const api = new LibreLinkUpApi({
    email: config.credentials.email,
    password: config.credentials.password,
    region: config.client.region,
    version: config.client.version
  });

  console.log(`🌍 Configured region: ${config.client.region}`);
  console.log(`🔢 Configured version: ${config.client.version} → sending: ${api.lluVersion} (minimum ${MINIMUM_LLU_VERSION})\n`);

  console.log('1. Authenticating...');
  try {
    await api.login();
  } catch (error) {
    const code = error instanceof LibreLinkApiError ? error.code : 'UNKNOWN';
    console.log(`   ❌ [${code}] ${error.message}`);
    return;
  }

  console.log('   ✅ Authenticated');
  console.log(`   Host in use: ${api.apiUrl}`);

  const accountType = api.me?.accountType;
  console.log(`   Account type: ${accountType ?? 'unknown'}` +
    (accountType === 'pat' ? ' (patient / sensor wearer)' : accountType === 'car' ? ' (LibreLinkUp follower)' : ''));
  console.log('   Account-Id header: derived from the user id (SHA-256), sent on every authenticated request\n');

  console.log('2. Checking patient connections...');
  let connections = [];
  try {
    connections = await api.fetchConnections();
  } catch (error) {
    const code = error instanceof LibreLinkApiError ? error.code : 'UNKNOWN';
    console.log(`   ❌ [${code}] ${error.message}`);
    return;
  }

  console.log(`   Found ${connections.length} connection(s)`);

  if (connections.length === 0) {
    console.log('   ❌ No patient data is shared with this account.\n');
    if (accountType === 'pat') {
      console.log('   This is the sensor wearer\'s own LibreLink account. LibreLink Up serves glucose');
      console.log('   data to *followers*, so this account cannot read its own readings here.');
      console.log('\n   Fix:');
      console.log('     1. LibreLink app → Connected Apps → LibreLinkUp → invite a follower (a different email).');
      console.log('     2. Install LibreLinkUp, sign up with that email, accept the invitation.');
      console.log('     3. Run: npm run configure  — and enter the follower credentials.');
    } else {
      console.log('   Ask the sensor wearer to invite this account from LibreLink app →');
      console.log('   Connected Apps → LibreLinkUp, then accept the invitation in the LibreLinkUp app.');
    }
    return;
  }

  connections.forEach((conn, index) => {
    console.log(`   Connection ${index + 1}: patientId ${conn.patientId} (status ${conn.status ?? 'unknown'})`);
  });

  console.log('\n3. Fetching sensor data...');
  try {
    const graph = await api.fetchGraph();
    console.log('   ✅ Data retrieved');
    console.log(`   Active sensors: ${graph.activeSensors.length}`);
    console.log(`   History points: ${graph.graphData.length}`);
    console.log(`   Current measurement present: ${graph.connection.glucoseItem ? 'yes' : 'no'}`);
  } catch (error) {
    const code = error instanceof LibreLinkApiError ? error.code : 'UNKNOWN';
    console.log(`   ❌ [${code}] ${error.message}`);
  }
}

diagnoseAccount().catch(console.error);
