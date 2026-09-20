#!/usr/bin/env node

import { LibreLinkUpApi, LibreLinkApiError, computeAccountId } from './dist/librelink-api.js';
import { ConfigManager } from './dist/config.js';

/**
 * Low-level request debugging for the LibreLink Up API.
 * Logs request headers with the Authorization value and Account-Id redacted,
 * and never prints credentials or glucose values.
 */

function redactHeaders(headers) {
  const safe = { ...headers };
  if (safe.Authorization) safe.Authorization = `Bearer <${safe.Authorization.length - 7} chars>`;
  if (safe['Account-Id']) safe['Account-Id'] = `<sha256, ${safe['Account-Id'].length} hex chars>`;
  return safe;
}

async function debugConnections() {
  console.log('🔍 LibreLink Up Request Debug');
  console.log('=============================\n');

  const configManager = new ConfigManager();

  if (!configManager.isConfigured()) {
    console.log('❌ No credentials configured. Run: npm run configure');
    return;
  }

  const config = configManager.getConfig();

  // Trace every request the client makes.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    console.log(`→ ${method} ${url}`);
    console.log(`  headers: ${JSON.stringify(redactHeaders(init.headers || {}))}`);
    const response = await originalFetch(url, init);
    console.log(`← HTTP ${response.status}`);
    return response;
  };

  const api = new LibreLinkUpApi({
    email: config.credentials.email,
    password: config.credentials.password,
    region: config.client.region,
    version: config.client.version
  });

  try {
    await api.login();
    console.log('\n✅ Login succeeded');
    console.log(`   Host: ${api.apiUrl}`);
    console.log(`   Version header: ${api.lluVersion}`);
    console.log(`   Account-Id matches SHA-256 of user id: ${
      api.me?.id ? computeAccountId(api.me.id).length === 64 : 'n/a'
    }`);

    const connections = await api.fetchConnections();
    console.log(`\n📊 Connections: ${connections.length}`);
    connections.forEach((conn, i) => console.log(`   ${i + 1}. patientId ${conn.patientId}`));

    if (connections.length > 0) {
      const graph = await api.fetchGraph();
      console.log(`\n🩸 Graph: ${graph.graphData.length} points, ${graph.activeSensors.length} active sensor(s)`);
    }
  } catch (error) {
    const code = error instanceof LibreLinkApiError ? error.code : 'UNKNOWN';
    console.log(`\n❌ [${code}] ${error.message}`);
    if (error instanceof LibreLinkApiError) {
      console.log(`   endpoint: ${error.endpoint ?? 'n/a'}  httpStatus: ${error.httpStatus ?? 'n/a'}  apiStatus: ${error.apiStatus ?? 'n/a'}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

debugConnections().catch(console.error);
