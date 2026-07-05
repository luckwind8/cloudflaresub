import assert from 'node:assert/strict';
import {
  decryptPayload,
  encryptPayload,
  expandNodes,
  parseNodeLinks,
  parsePreferredEndpoints,
  renderClashSubscription,
  renderRawSubscription,
  renderSurgeSubscription,
} from '../src/core.js';
import worker from '../src/worker.js';

const vmess = 'vmess://ewogICJ2IjogIjIiLAogICJwcyI6ICJkZW1vLXdzLXRscyIsCiAgImFkZCI6ICJlZGdlLmV4YW1wbGUuY29tIiwKICAicG9ydCI6ICI0NDMiLAogICJpZCI6ICIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLAogICJzY3kiOiAiYXV0byIsCiAgIm5ldCI6ICJ3cyIsCiAgInRscyI6ICJ0bHMiLAogICJwYXRoIjogIi93cyIsCiAgImhvc3QiOiAiZWRnZS5leGFtcGxlLmNvbSIsCiAgInNuaSI6ICJlZGdlLmV4YW1wbGUuY29tIiwKICAiZnAiOiAiY2hyb21lIiwKICAiYWxwbiI6ICJoMixodHRwLzEuMSIKfQ==';

const { nodes } = parseNodeLinks(vmess);
assert.equal(nodes.length, 1);
assert.equal(nodes[0].type, 'vmess');
assert.equal(nodes[0].server, 'edge.example.com');

const { endpoints } = parsePreferredEndpoints('104.16.1.2#HK\n104.17.2.3:2053#US');
assert.equal(endpoints.length, 2);

const expanded = expandNodes(nodes, endpoints, { keepOriginalHost: true, namePrefix: 'CF' });
assert.equal(expanded.nodes.length, 2);
assert.equal(expanded.nodes[0].server, '104.16.1.2');
assert.equal(expanded.nodes[0].hostHeader, 'edge.example.com');
assert.equal(expanded.nodes[1].port, 2053);

const raw = renderRawSubscription(expanded.nodes);
assert.ok(raw.length > 10);

const clash = renderClashSubscription(expanded.nodes);
assert.match(clash, /proxies:/);
assert.match(clash, /edge\.example\.com/);

const surge = renderSurgeSubscription(expanded.nodes, 'https://sub.example.com/sub/demo?target=surge');
assert.match(surge, /\[Proxy]/);
assert.match(surge, /vmess/);

const secret = 'this-is-a-very-secret-key';
const token = await encryptPayload({ nodes: expanded.nodes }, secret);
const payload = await decryptPayload(token, secret);
assert.equal(payload.nodes.length, 2);

function createTestKv() {
  const values = new Map();
  const puts = [];
  return {
    puts,
    async get(key) {
      return values.get(key) || null;
    },
    async put(key, value, options = {}) {
      values.set(key, value);
      puts.push({ key, value, options });
    },
    async delete(key) {
      values.delete(key);
    },
  };
}

const kv = createTestKv();
const env = {
  SUB_ACCESS_TOKEN: 'secret-token',
  SUB_STORE: kv,
  ASSETS: {
    fetch() {
      return new Response('asset fallback');
    },
  },
};

const generateBody = {
  nodeLinks: vmess,
  preferredIps: '104.16.7.118:443',
  clientName: 'My Sub',
  tokenTtlDays: 2,
  namePrefix: 'CF',
  keepOriginalHost: true,
};

const blocked = await worker.fetch(
  new Request('https://example.com/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(generateBody),
  }),
  env,
);
assert.equal(blocked.status, 401);

const login = await worker.fetch(
  new Request('https://example.com/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'admin' }),
  }),
  env,
);
assert.equal(login.status, 200);
const cookie = login.headers.get('set-cookie').split(';')[0];

const generated = await worker.fetch(
  new Request('https://example.com/api/generate', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
    },
    body: JSON.stringify(generateBody),
  }),
  env,
);
assert.equal(generated.status, 200);
const generatedJson = await generated.json();
assert.equal(generatedJson.ok, true);
assert.equal(generatedJson.clientName, 'My Sub');
assert.equal(generatedJson.tokenTtlSeconds, 172800);
assert.equal(generatedJson.counts.outputNodes, 1);
assert.equal(generatedJson.preview[0].name, 'My Sub | CF | 1');
assert.equal(generatedJson.preview[0].server, '104.16.7.118');
assert.equal(generatedJson.preview[0].port, 443);

const subPut = kv.puts.find((item) => item.key === `sub:${generatedJson.shortId}`);
assert.equal(subPut.options.expirationTtl, 172800);

const rawSub = await worker.fetch(new Request(generatedJson.urls.raw), env);
assert.equal(rawSub.status, 200);
assert.equal(rawSub.headers.get('profile-title'), `base64:${btoa('My Sub')}`);
assert.match(rawSub.headers.get('content-disposition'), /My%20Sub\.txt/);

console.log('smoke test passed');
