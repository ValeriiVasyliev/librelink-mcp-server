#!/usr/bin/env node

import {
  LibreLinkUpApi,
  LibreLinkApiError,
  computeAccountId,
  resolveLluVersion,
  isVersionAtLeast,
  MINIMUM_LLU_VERSION
} from './dist/librelink-api.js';
import { LibreLinkClient } from './dist/librelink-client.js';
import { createHash } from 'crypto';

/**
 * Unit tests for the LibreLink Up API client.
 * Every request is mocked - no real credentials or network calls.
 */

const TEST_CREDENTIALS = { email: 'test@example.invalid', password: 'not-a-real-password' };
const USER_ID = '00000000-1111-2222-3333-444444444444';
const PATIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function expectError(name, fn, expectedCode) {
  try {
    await fn();
    check(name, false, `expected ${expectedCode}, but the call succeeded`);
  } catch (error) {
    const code = error instanceof LibreLinkApiError ? error.code : error?.code;
    check(name, code === expectedCode, `expected ${expectedCode}, got ${code}: ${error?.message}`);
  }
}

/** Install a mock fetch. `routes` maps "METHOD /path" to a handler. */
function mockFetch(routes) {
  const calls = [];

  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const parsed = new URL(url);
    const key = `${method} ${parsed.pathname}${parsed.search}`;
    calls.push({ url, method, path: parsed.pathname, headers: init.headers || {}, origin: parsed.origin });

    const handler = routes[key] ?? routes[`${method} ${parsed.pathname}`];
    if (!handler) {
      throw new Error(`Unmocked request: ${key}`);
    }

    const { status = 200, body = {} } = await handler({ url, init, calls });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body
    };
  };

  return calls;
}

const loginSuccessBody = {
  status: 0,
  data: {
    user: { id: USER_ID, accountType: 'car' },
    authTicket: { token: 'mock-token', expires: Math.floor(Date.now() / 1000) + 3600, duration: 3600 }
  }
};

function graphBody(overrides = {}) {
  return {
    status: 0,
    data: {
      connection: {
        id: 'conn-1',
        patientId: PATIENT_ID,
        glucoseItem: {
          Timestamp: '9/19/2026 10:30:00 AM',
          ValueInMgPerDl: 112,
          TrendArrow: 4,
          MeasurementColor: 1
        },
        ...overrides.connection
      },
      activeSensors: overrides.activeSensors ?? [
        { sensor: { deviceId: 'dev-1', sn: 'SN123', a: 1789859876, w: 60, pt: 14 }, device: { did: 'd1', dtid: 40066 } }
      ],
      graphData: overrides.graphData ?? [
        { Timestamp: '9/19/2026 09:30:00 AM', ValueInMgPerDl: 100, TrendArrow: 3, MeasurementColor: 1 },
        { Timestamp: '9/19/2026 10:00:00 AM', ValueInMgPerDl: 108, TrendArrow: 4, MeasurementColor: 1 }
      ]
    }
  };
}

const connectionsBody = { status: 0, data: [{ id: 'conn-1', patientId: PATIENT_ID }] };

function newApi(extra = {}) {
  return new LibreLinkUpApi({ ...TEST_CREDENTIALS, region: 'EU', ...extra });
}

// ---------------------------------------------------------------------------

async function testVersionResolution() {
  console.log('\n1. API version configuration');

  check('4.16.0 satisfies the minimum', isVersionAtLeast('4.16.0', MINIMUM_LLU_VERSION));
  check('4.7.0 does not satisfy the minimum', !isVersionAtLeast('4.7.0', MINIMUM_LLU_VERSION));
  check('4.12.0 does not satisfy the minimum', !isVersionAtLeast('4.12.0', MINIMUM_LLU_VERSION));
  check('5.0.0 satisfies the minimum', isVersionAtLeast('5.0.0', MINIMUM_LLU_VERSION));
  check('4.16.1 satisfies the minimum', isVersionAtLeast('4.16.1', MINIMUM_LLU_VERSION));

  check('stale configured version is raised', resolveLluVersion('4.7.0') === MINIMUM_LLU_VERSION);
  check('missing configured version defaults to minimum', resolveLluVersion(undefined) === MINIMUM_LLU_VERSION);
  check('newer configured version is kept', resolveLluVersion('4.20.0') === '4.20.0');
  check('client reports the enforced version', newApi({ version: '4.12.0' }).lluVersion === MINIMUM_LLU_VERSION);
}

async function testAccountId() {
  console.log('\n2. Account-Id generation');

  const expected = createHash('sha256').update(USER_ID).digest('hex');
  check('Account-Id is the SHA-256 hex of the user id', computeAccountId(USER_ID) === expected);
  check('Account-Id is 64 hex characters', /^[0-9a-f]{64}$/.test(computeAccountId(USER_ID)));
  check('Account-Id is deterministic', computeAccountId(USER_ID) === computeAccountId(USER_ID));
  check('different user ids give different Account-Ids', computeAccountId('other') !== computeAccountId(USER_ID));
}

async function testRequiredHeaders() {
  console.log('\n3. Required request headers');

  const calls = mockFetch({
    'POST /llu/auth/login': () => ({ body: loginSuccessBody }),
    'GET /llu/connections': () => ({ body: connectionsBody })
  });

  const api = newApi();
  await api.fetchConnections();

  const login = calls.find(c => c.path === '/llu/auth/login');
  const connections = calls.find(c => c.path === '/llu/connections');

  check('login sends product=llu.android', login.headers.product === 'llu.android');
  check('login sends version >= minimum', isVersionAtLeast(login.headers.version, MINIMUM_LLU_VERSION));
  check('login sends content-type json', login.headers['content-type'] === 'application/json');
  check('login sends no Authorization header', login.headers.Authorization === undefined);
  check('login sends no Account-Id header', login.headers['Account-Id'] === undefined);

  check('authenticated request sends Bearer token', connections.headers.Authorization === 'Bearer mock-token');
  check('authenticated request sends Account-Id', connections.headers['Account-Id'] === computeAccountId(USER_ID));
  check('authenticated request sends version >= minimum', isVersionAtLeast(connections.headers.version, MINIMUM_LLU_VERSION));
  check('authenticated request sends product header', connections.headers.product === 'llu.android');
}

async function testRegionHandling() {
  console.log('\n4. Regional endpoint handling');

  check('EU region starts at api-eu', newApi({ region: 'EU' }).apiUrl === 'https://api-eu.libreview.io');
  check('US region starts at api-us', newApi({ region: 'US' }).apiUrl === 'https://api-us.libreview.io');
  check('unknown region falls back to US', newApi({ region: 'XX' }).apiUrl === 'https://api-us.libreview.io');

  // Redirect: api-us -> api-eu, resolved via the country config endpoint.
  let loginCount = 0;
  const calls = mockFetch({
    'POST /llu/auth/login': ({ calls }) => {
      loginCount++;
      const origin = new URL(calls[calls.length - 1].url).origin;
      if (origin === 'https://api-us.libreview.io') {
        return { body: { status: 0, data: { redirect: true, region: 'eu' } } };
      }
      return { body: loginSuccessBody };
    },
    'GET /llu/config/country?country=DE': () => ({
      body: { status: 0, data: { regionalMap: { eu: { lslApi: 'https://api-eu.libreview.io/' } } } }
    })
  });

  const api = newApi({ region: 'US' });
  await api.login();

  check('redirect is followed to the regional host', api.apiUrl === 'https://api-eu.libreview.io');
  check('trailing slash from regionalMap is trimmed', !api.apiUrl.endsWith('/'));
  check('login is retried exactly once after redirect', loginCount === 2);
  check('country lookup was performed', calls.some(c => c.path === '/llu/config/country'));

  // A region with no published server must not be reported as a sensor problem.
  mockFetch({
    'POST /llu/auth/login': () => ({ body: { status: 0, data: { redirect: true, region: 'ap' } } }),
    'GET /llu/config/country?country=DE': () => ({ body: { status: 0, data: { regionalMap: {} } } })
  });
  await expectError('unknown region yields REGION_ERROR', () => newApi({ region: 'US' }).login(), 'REGION_ERROR');
}

async function testAuthenticationErrors() {
  console.log('\n5. Authentication behaviour');

  mockFetch({ 'POST /llu/auth/login': () => ({ body: { status: 2 } }) });
  await expectError('API status 2 yields INVALID_CREDENTIALS', () => newApi().login(), 'INVALID_CREDENTIALS');

  mockFetch({ 'POST /llu/auth/login': () => ({ body: { status: 4 } }) });
  await expectError('API status 4 yields TERMS_NOT_ACCEPTED', () => newApi().login(), 'TERMS_NOT_ACCEPTED');

  mockFetch({ 'POST /llu/auth/login': () => ({ body: { status: 0, data: { user: { id: USER_ID } } } }) });
  await expectError('login without a ticket yields UNKNOWN_API_ERROR', () => newApi().login(), 'UNKNOWN_API_ERROR');

  try {
    new LibreLinkUpApi({ email: '', password: '' });
    check('empty credentials are rejected', false, 'constructor did not throw');
  } catch (error) {
    check('empty credentials are rejected', error?.code === 'INVALID_CREDENTIALS');
  }

  mockFetch({
    'POST /llu/auth/login': () => {
      throw new TypeError('fetch failed');
    }
  });
  await expectError('transport failure yields NETWORK_ERROR', () => newApi().login(), 'NETWORK_ERROR');
}

async function test403Status920() {
  console.log('\n6. HTTP 403 / status 920 and missing Account-Id');

  mockFetch({
    'POST /llu/auth/login': () => ({ body: loginSuccessBody }),
    'GET /llu/connections': () => ({
      status: 403,
      body: { status: 920, data: { minimumVersion: '4.16.0' } }
    })
  });

  const api = newApi();
  try {
    await api.fetchConnections();
    check('403/920 is surfaced', false, 'no error thrown');
  } catch (error) {
    check('403/920 yields API_VERSION_UNSUPPORTED', error.code === 'API_VERSION_UNSUPPORTED');
    check('error names the required version', error.message.includes('4.16.0'));
    check('error records the HTTP status', error.httpStatus === 403);
    check('error records the API status', error.apiStatus === 920);
    check('error is not reported as a sensor problem', !/sensor/i.test(error.message));
    check('error does not leak the password', !error.message.includes(TEST_CREDENTIALS.password));
  }

  mockFetch({
    'POST /llu/auth/login': () => ({ body: loginSuccessBody }),
    'GET /llu/connections': () => ({ status: 400, body: { message: 'RequiredHeaderMissing' } })
  });
  await expectError('RequiredHeaderMissing yields MISSING_ACCOUNT_ID', () => newApi().fetchConnections(), 'MISSING_ACCOUNT_ID');

  mockFetch({
    'POST /llu/auth/login': () => ({ body: loginSuccessBody }),
    'GET /llu/connections': () => ({ status: 429, body: { message: 'Too many requests' } })
  });
  await expectError('HTTP 429 yields RATE_LIMITED', () => newApi().fetchConnections(), 'RATE_LIMITED');

  mockFetch({
    'POST /llu/auth/login': () => ({ body: loginSuccessBody }),
    'GET /llu/connections': () => ({ status: 500, body: { message: 'boom' } })
  });
  await expectError('HTTP 500 yields UNKNOWN_API_ERROR', () => newApi().fetchConnections(), 'UNKNOWN_API_ERROR');
}

async function testNoConnections() {
  console.log('\n7. Missing patient connections');

  mockFetch({
    'POST /llu/auth/login': () => ({
      body: { ...loginSuccessBody, data: { ...loginSuccessBody.data, user: { id: USER_ID, accountType: 'pat' } } }
    }),
    'GET /llu/connections': () => ({ body: { status: 0, data: [] } })
  });

  const api = newApi();
  try {
    await api.getPatientId();
    check('empty connections are surfaced', false, 'no error thrown');
  } catch (error) {
    check('empty connections yield NO_CONNECTIONS', error.code === 'NO_CONNECTIONS');
    check('patient accounts get sharing guidance', /LibreLinkUp/.test(error.message));
    check('error is not reported as invalid credentials', error.code !== 'INVALID_CREDENTIALS');
  }
}

async function testTokenRefresh() {
  console.log('\n8. Token refresh behaviour');

  let loginCount = 0;
  let connectionAttempts = 0;
  mockFetch({
    'POST /llu/auth/login': () => {
      loginCount++;
      return { body: loginSuccessBody };
    },
    'GET /llu/connections': () => {
      connectionAttempts++;
      if (connectionAttempts === 1) {
        return { status: 401, body: { message: 'Unauthorized' } };
      }
      return { body: connectionsBody };
    }
  });

  const api = newApi();
  const connections = await api.fetchConnections();

  check('a 401 triggers one re-login', loginCount === 2);
  check('the request is retried after re-login', connectionAttempts === 2);
  check('the retried request returns data', connections.length === 1);

  // An expired ticket must be refreshed before the request is even sent.
  loginCount = 0;
  mockFetch({
    'POST /llu/auth/login': () => {
      loginCount++;
      return {
        body: {
          status: 0,
          data: {
            user: { id: USER_ID, accountType: 'car' },
            authTicket: { token: 'mock-token', expires: Math.floor(Date.now() / 1000) - 10, duration: 3600 }
          }
        }
      };
    },
    'GET /llu/connections': () => ({ body: connectionsBody })
  });

  const expiring = newApi();
  await expiring.fetchConnections();
  await expiring.fetchConnections();
  check('an expired ticket is refreshed on the next call', loginCount === 2);

  // A live ticket must not cause a redundant login.
  loginCount = 0;
  mockFetch({
    'POST /llu/auth/login': () => {
      loginCount++;
      return { body: loginSuccessBody };
    },
    'GET /llu/connections': () => ({ body: connectionsBody })
  });
  const reused = newApi();
  await reused.fetchConnections();
  await reused.fetchConnections();
  check('a valid ticket is reused', loginCount === 1);
}

async function testSuccessfulConnection() {
  console.log('\n9. Successful connection (mocked)');

  mockFetch({
    'POST /llu/auth/login': () => ({ body: loginSuccessBody }),
    'GET /llu/connections': () => ({ body: connectionsBody }),
    [`GET /llu/connections/${PATIENT_ID}/graph`]: () => ({ body: graphBody() })
  });

  const config = {
    credentials: TEST_CREDENTIALS,
    client: { version: '4.12.0', region: 'EU' },
    cache: { enabled: false, ttl_minutes: 5 },
    ranges: { target_low: 70, target_high: 180 }
  };

  const client = new LibreLinkClient(config);

  check('client enforces the minimum version', client.lluVersion === MINIMUM_LLU_VERSION);

  const reading = await client.getCurrentGlucose();
  check('current glucose value is parsed', reading.value === 112);
  check('timestamp is a Date', reading.timestamp instanceof Date && !isNaN(reading.timestamp.getTime()));
  check('trend arrow 4 maps to FortyFiveUp', reading.trend === 'FortyFiveUp');
  check('in-range reading is not flagged high or low', !reading.isHigh && !reading.isLow);

  const history = await client.getGlucoseHistory(24 * 365 * 100);
  check('history returns graph readings', history.length === 2);
  check('history is sorted ascending', history[0].timestamp <= history[1].timestamp);

  const sensors = await client.getSensorInfo();
  check('sensor serial number comes from the API', sensors[0].serialNumber === 'SN123');
  check('sensor device type is resolved', sensors[0].deviceType === 'FreeStyle Libre 3');
  check('sensor activation time comes from the API', sensors[0].activationTime.getTime() === 1789859876 * 1000);

  const result = await client.validateConnection();
  check('validateConnection reports success', result.valid === true);
}

async function testClientErrorReporting() {
  console.log('\n10. Client error reporting');

  mockFetch({
    'POST /llu/auth/login': () => ({ body: loginSuccessBody }),
    'GET /llu/connections': () => ({ status: 403, body: { status: 920, data: { minimumVersion: '4.16.0' } } })
  });

  const config = {
    credentials: TEST_CREDENTIALS,
    client: { version: '4.16.0', region: 'EU' },
    cache: { enabled: false, ttl_minutes: 5 },
    ranges: { target_low: 70, target_high: 180 }
  };

  const result = await new LibreLinkClient(config).validateConnection();
  check('validateConnection reports failure', result.valid === false);
  check('failure carries the API_VERSION_UNSUPPORTED code', result.code === 'API_VERSION_UNSUPPORTED');
  check('failure is not blamed on the sensor', !/sensor status/i.test(result.message));
  check('failure message omits credentials', !result.message.includes(TEST_CREDENTIALS.password));

  // A genuinely absent measurement must still be reported as a sensor problem.
  mockFetch({
    'POST /llu/auth/login': () => ({ body: loginSuccessBody }),
    'GET /llu/connections': () => ({ body: connectionsBody }),
    [`GET /llu/connections/${PATIENT_ID}/graph`]: () => ({
      body: graphBody({ connection: { glucoseItem: undefined, glucoseMeasurement: undefined } })
    })
  });
  await expectError(
    'a missing measurement yields SENSOR_UNAVAILABLE',
    () => new LibreLinkClient(config).getCurrentGlucose(),
    'SENSOR_UNAVAILABLE'
  );
}

async function main() {
  console.log('🧪 LibreLink Up API Client Tests');
  console.log('================================');

  const originalFetch = globalThis.fetch;

  try {
    await testVersionResolution();
    await testAccountId();
    await testRequiredHeaders();
    await testRegionHandling();
    await testAuthenticationErrors();
    await test403Status920();
    await testNoConnections();
    await testTokenRefresh();
    await testSuccessfulConnection();
    await testClientErrorReporting();
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.log(`\n================================`);
  console.log(`Passed: ${passed}   Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Test harness error:', error);
  process.exit(1);
});
