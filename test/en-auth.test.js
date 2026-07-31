const assert = require('node:assert/strict');
const test = require('node:test');

const {
  exchangeYostarCredentials,
  getServerConfig
} = require('../src/index');

test('EN uses the upstream OAuth type with a YoStar session refresh', () => {
  const server = getServerConfig('en');

  assert.equal(server.loginMode, 'yostar');
  assert.equal(server.oauthType, 22);
});

test('existing EN UID/TOKEN values are refreshed before lobby authentication', async () => {
  let request;
  const fetchImpl = async (url, init) => {
    request = { url, init };
    return new Response(
      JSON.stringify({
        Code: 200,
        Data: {
          UserInfo: {
            ID: 'refreshed-uid',
            Token: 'refreshed-token'
          }
        }
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  };

  const credentials = await exchangeYostarCredentials(
    { uid: 'saved-uid', token: 'saved-token' },
    fetchImpl,
    () => 1234567890
  );

  assert.deepEqual(credentials, {
    uid: 'refreshed-uid',
    token: 'refreshed-token'
  });
  assert.equal(request.url, 'https://en-sdk-api.yostarplat.com/user/quick-login');
  const authorization = JSON.parse(request.init.headers.Authorization);
  assert.equal(authorization.Head.UID, 'saved-uid');
  assert.equal(authorization.Head.Token, 'saved-token');
  assert.equal(authorization.Head.DeviceID, 'web|saved-uid');
  assert.equal(authorization.Head.Time, 1234567890);
  assert.match(authorization.Sign, /^[0-9A-F]{32}$/);
});
