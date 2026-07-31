const assert = require('node:assert/strict');
const test = require('node:test');

const {
  exchangePassportToken,
  getServerConfig
} = require('../src/index');

test('EN is the default server and uses the legacy passport exchange', () => {
  const server = getServerConfig();

  assert.equal(server.key, 'en');
  assert.equal(server.loginMode, 'passport');
  assert.equal(server.oauthType, 7);
});

test('exchangePassportToken preserves existing UID/TOKEN secret semantics', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ accessToken: 'passport-access-token' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  const accessToken = await exchangePassportToken(
    'https://passport.mahjongsoul.com/',
    {
      uid: 'en-login-uid',
      token: 'en-login-token'
    },
    fetchImpl
  );

  assert.equal(accessToken, 'passport-access-token');
  assert.equal(captured.url, 'https://passport.mahjongsoul.com/user/login/');
  assert.equal(captured.init.method, 'POST');
  assert.equal(
    captured.init.headers['Content-Type'],
    'application/x-www-form-urlencoded;charset=UTF-8'
  );
  assert.deepEqual(
    Object.fromEntries(new URLSearchParams(captured.init.body)),
    {
      uid: 'en-login-uid',
      token: 'en-login-token',
      deviceId: 'web|en-login-uid'
    }
  );
});

test('exchangePassportToken rejects a response without an access token', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: 'invalid token' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  await assert.rejects(
    exchangePassportToken(
      'https://passport.mahjongsoul.com/',
      { uid: 'en-login-uid', token: 'invalid' },
      fetchImpl
    ),
    /Passport login failed: accessToken not found/
  );
});

test('exchangePassportToken never sends secrets to a non-official host', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error('must not be called');
  };

  await assert.rejects(
    exchangePassportToken(
      'https://example.com/',
      { uid: 'en-login-uid', token: 'en-login-token' },
      fetchImpl
    ),
    /not an allowed official endpoint/
  );
  assert.equal(called, false);
});
