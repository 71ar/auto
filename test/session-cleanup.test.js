const assert = require('node:assert/strict');
const test = require('node:test');
const { WebSocketServer } = require('ws');

const { createSession } = require('../src/index');

test('createSession closes a gateway socket after authentication rejection', async () => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  let resolveSocketClosed;
  const socketClosed = new Promise(resolve => {
    resolveSocketClosed = resolve;
  });

  server.on('connection', socket => {
    socket.on('message', data => {
      const request = Buffer.from(data);
      const header = Buffer.from([3, request[1], request[2]]);
      socket.send(Buffer.concat([header, Buffer.from('response')]));
    });
    socket.once('close', resolveSocketClosed);
  });

  try {
    await assert.rejects(
      createSession(createContext(`ws://127.0.0.1:${port}`), {
        uid: 'fake-uid',
        token: 'fake-token'
      }),
      /oauth2Auth failed/
    );
    await Promise.race([
      socketClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('socket close timeout')), 1000))
    ]);
    assert.equal(server.clients.size, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

function createContext(endpoint) {
  const requestType = {
    verify: () => null,
    encode: () => ({ finish: () => Buffer.alloc(0) })
  };
  return {
    server: {
      key: 'en',
      origin: 'https://mahjongsoul.game.yo-star.com',
      loginMode: 'oauth_code',
      oauthType: 22,
      currencyPlatforms: [1, 4, 5, 9, 12],
      tag: 'en'
    },
    routes: [{ id: 'en-test', endpoint }],
    clientMetadata: {
      clientVersion: { resource: '0.16.231', package: '4.0.10' },
      clientVersionString: 'WebGL_2022-0.16.231'
    },
    proto: {
      Wrapper: {
        create: value => value,
        encode: value => ({ finish: () => Buffer.from(value.name) }),
        decode: data => ({ data })
      },
      ReqRequestConnection: requestType,
      ReqHeartbeat: requestType,
      ReqOauth2Auth: requestType,
      ReqCommon: requestType,
      ResRequestConnection: { decode: () => ({}) },
      ResHeartbeat: { decode: () => ({}) },
      ResOauth2Auth: {
        decode: () => ({ error: { code: 151, message: 'ERR_CLIENT_VERSION' } })
      }
    }
  };
}
