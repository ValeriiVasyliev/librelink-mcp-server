#!/usr/bin/env node

import { spawn } from 'child_process';
import { createWriteStream, copyFileSync, existsSync, unlinkSync, renameSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

/**
 * This suite replaces the user's config with a test fixture so it never
 * authenticates against a real LibreLink account. Back the real file up first
 * and always put it back, so running the tests cannot destroy real credentials.
 */
const CONFIG_FILE = join(homedir(), '.librelink-mcp', 'config.json');
const CONFIG_BACKUP = `${CONFIG_FILE}.test-backup`;

function backupUserConfig() {
  if (existsSync(CONFIG_FILE)) {
    copyFileSync(CONFIG_FILE, CONFIG_BACKUP);
  }
}

/**
 * Install known-bad credentials before the server starts.
 *
 * The suite asserts that auth-dependent tools fail. It used to get that state
 * as a side effect of `configure_credentials` overwriting the config with test
 * data; that tool no longer accepts credentials, so the fixture is written here
 * instead. This also stops the suite from authenticating against the real
 * LibreLink account of whoever runs it.
 */
function writeTestConfig() {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(
    CONFIG_FILE,
    JSON.stringify(
      {
        credentials: { email: 'test@example.com', password: 'testpassword' },
        client: { version: '4.16.0', region: 'US' },
        cache: { enabled: false, ttl_minutes: 5 },
        ranges: { target_low: 70, target_high: 180 }
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
}

function restoreUserConfig() {
  if (existsSync(CONFIG_BACKUP)) {
    renameSync(CONFIG_BACKUP, CONFIG_FILE);
    console.log('[TEST] Restored your original ~/.librelink-mcp/config.json');
  } else if (existsSync(CONFIG_FILE)) {
    // There was no config before the run; do not leave test credentials behind.
    unlinkSync(CONFIG_FILE);
  }
}

/**
 * Test script for LibreLink MCP Server
 * Tests the MCP protocol communication without requiring real LibreLink credentials
 */

class MCPTester {
  constructor() {
    this.server = null;
    this.testResults = [];
  }

  log(message) {
    console.log(`[TEST] ${message}`);
    this.testResults.push(message);
  }

  async startServer() {
    this.log('Starting MCP server...');
    
    this.server = spawn('node', ['dist/index.js'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.server.stderr.on('data', (data) => {
      const message = data.toString().trim();
      if (message.includes('LibreLink MCP Server running')) {
        this.log('✅ Server started successfully');
      } else if (message) {
        this.log(`Server stderr: ${message}`);
      }
    });

    // Give server time to start
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    return this.server.pid ? true : false;
  }

  async sendMCPMessage(message) {
    return new Promise((resolve, reject) => {
      let response = '';
      let timeoutId;

      const onData = (data) => {
        response += data.toString();
        // Look for complete JSON-RPC message
        try {
          const lines = response.split('\n');
          for (const line of lines) {
            if (line.trim() && line.startsWith('{')) {
              const parsed = JSON.parse(line);
              clearTimeout(timeoutId);
              this.server.stdout.off('data', onData);
              resolve(parsed);
              return;
            }
          }
        } catch (e) {
          // Continue accumulating response
        }
      };

      this.server.stdout.on('data', onData);

      timeoutId = setTimeout(() => {
        this.server.stdout.off('data', onData);
        reject(new Error(`Timeout waiting for response to: ${JSON.stringify(message)}`));
      }, 5000);

      this.server.stdin.write(JSON.stringify(message) + '\n');
    });
  }

  async testListTools() {
    this.log('Testing list_tools...');
    
    const message = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {}
    };

    try {
      const response = await this.sendMCPMessage(message);
      
      if (response.result && response.result.tools) {
        const toolNames = response.result.tools.map(tool => tool.name);
        this.log(`✅ Found ${toolNames.length} tools: ${toolNames.join(', ')}`);
        
        // Verify expected tools exist
        const expectedTools = [
          'get_current_glucose',
          'get_glucose_history', 
          'get_glucose_stats',
          'get_glucose_trends',
          'get_sensor_info',
          'configure_credentials',
          'configure_ranges',
          'validate_connection'
        ];
        
        const missingTools = expectedTools.filter(tool => !toolNames.includes(tool));
        if (missingTools.length === 0) {
          this.log('✅ All expected tools are present');
          return true;
        } else {
          this.log(`❌ Missing tools: ${missingTools.join(', ')}`);
          return false;
        }
      } else {
        this.log('❌ No tools returned in response');
        return false;
      }
    } catch (error) {
      this.log(`❌ Error testing list_tools: ${error.message}`);
      return false;
    }
  }

  async testConfigureCredentials() {
    this.log('Testing configure_credentials sets the region...');

    const message = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'configure_credentials',
        arguments: { region: 'US' }
      }
    };

    try {
      const response = await this.sendMCPMessage(message);

      if (response.result && response.result.content) {
        const content = response.result.content[0].text;
        if (content.includes('region set to US')) {
          this.log('✅ Region configuration successful');
          return true;
        }
        this.log(`❌ Unexpected response: ${content}`);
        return false;
      }
      this.log('❌ No content in configure_credentials response');
      return false;
    } catch (error) {
      this.log(`❌ Error testing configure_credentials: ${error.message}`);
      return false;
    }
  }

  /**
   * Credentials passed to an MCP tool end up in conversation history, so the
   * tool must refuse them outright rather than accept and store them.
   */
  async testConfigureCredentialsRejectsSecrets() {
    this.log('Testing configure_credentials refuses email/password...');

    const message = {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'configure_credentials',
        arguments: {
          email: 'test@example.com',
          password: 'testpassword',
          region: 'US'
        }
      }
    };

    try {
      const response = await this.sendMCPMessage(message);
      const text = JSON.stringify(response);

      if (!/does not accept/i.test(text)) {
        this.log(`❌ Secrets were not rejected: ${text}`);
        return false;
      }

      // The rejection must not echo the password back to the caller.
      if (text.includes('testpassword')) {
        this.log('❌ Rejection echoed the submitted password');
        return false;
      }

      this.log('✅ Credentials rejected without echoing the password');
      return true;
    } catch (error) {
      this.log(`❌ Error testing credential rejection: ${error.message}`);
      return false;
    }
  }

  async testValidateConnection() {
    this.log('Testing validate_connection (expected to fail with test credentials)...');
    
    const message = {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'validate_connection',
        arguments: {}
      }
    };

    try {
      const response = await this.sendMCPMessage(message);
      
      if (response.result && response.result.content) {
        const content = response.result.content[0].text;
        if (content.includes('connection failed') || content.includes('Error')) {
          this.log('✅ Connection validation failed as expected (test credentials)');
          return true;
        } else {
          this.log(`❌ Unexpected success: ${content}`);
          return false;
        }
      } else {
        this.log('❌ No content in validate_connection response');
        return false;
      }
    } catch (error) {
      this.log(`❌ Error testing validate_connection: ${error.message}`);
      return false;
    }
  }

  async testGlucoseDataWithoutAuth() {
    this.log('Testing glucose data retrieval (expected to fail without valid auth)...');
    
    const message = {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'get_current_glucose',
        arguments: {}
      }
    };

    try {
      const response = await this.sendMCPMessage(message);
      
      if (response.result && response.result.content) {
        const content = response.result.content[0].text;
        if (content.includes('Error') || content.includes('AUTH_FAILED')) {
          this.log('✅ Glucose data request failed as expected (no valid auth)');
          return true;
        } else {
          this.log(`❌ Unexpected response: ${content}`);
          return false;
        }
      } else {
        this.log('❌ No content in glucose data response');
        return false;
      }
    } catch (error) {
      this.log(`❌ Error testing glucose data: ${error.message}`);
      return false;
    }
  }

  async stopServer() {
    if (this.server) {
      this.log('Stopping server...');
      this.server.kill('SIGTERM');
      
      // Wait for server to exit
      await new Promise(resolve => {
        this.server.on('exit', resolve);
        setTimeout(resolve, 2000); // Timeout after 2 seconds
      });
      
      this.log('✅ Server stopped');
    }
  }

  async runAllTests() {
    console.log('🧪 LibreLink MCP Server Test Suite');
    console.log('=====================================\n');

    let passed = 0;
    let total = 0;

    backupUserConfig();
    writeTestConfig();

    try {
      // Start server
      const serverStarted = await this.startServer();
      if (!serverStarted) {
        this.log('❌ Failed to start server');
        process.exitCode = 1;
        return;
      }

      // Run tests
      const tests = [
        this.testListTools.bind(this),
        this.testConfigureCredentials.bind(this),
        this.testConfigureCredentialsRejectsSecrets.bind(this),
        this.testValidateConnection.bind(this),
        this.testGlucoseDataWithoutAuth.bind(this)
      ];

      for (const test of tests) {
        total++;
        const result = await test();
        if (result) passed++;
        console.log(''); // Add spacing between tests
      }

    } catch (error) {
      this.log(`❌ Test suite error: ${error.message}`);
    } finally {
      await this.stopServer();
      restoreUserConfig();
    }

    console.log('\n📊 Test Results');
    console.log('================');
    console.log(`Passed: ${passed}/${total}`);
    console.log(`Success Rate: ${Math.round((passed/total) * 100)}%`);
    
    if (passed === total) {
      console.log('🎉 All tests passed! The MCP server is working correctly.');
      console.log('\nNext steps:');
      console.log('1. Add real LibreLink credentials using: npm run configure');
      console.log('2. Test with real credentials');
      console.log('3. Integrate with Claude Desktop');
    } else {
      console.log('⚠️  Some tests failed. Check the output above for details.');
      // Without this the suite exits 0 and `npm test` reports success even
      // though tests failed, which hid a stale assertion in this file.
      process.exitCode = 1;
    }
  }
}

// Run tests
process.on('SIGINT', () => { restoreUserConfig(); process.exit(130); });
process.on('SIGTERM', () => { restoreUserConfig(); process.exit(143); });

const tester = new MCPTester();
tester.runAllTests().catch(error => {
  console.error(error);
  restoreUserConfig();
});