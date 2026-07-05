// Cloudflare Worker: KV short link subscription + access token protection
// Requires:
// - KV namespace binding: SUB_STORE
// - Secret/Variable: SUB_ACCESS_TOKEN
// Optional:
// - Secret/Variable: SUB_LINK_SECRET (legacy long-token compatibility)

const DEFAULT_ADMIN_PASSWORD = 'admin';
const AUTH_COOKIE_NAME = 'cloudflaresub_admin';
const AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;
const DEFAULT_TOKEN_TTL_DAYS = 7;
const MAX_TOKEN_TTL_DAYS = 3650;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type,x-admin-password',
      ...extraHeaders,
    },
  });
}

function text(body, status = 200, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      'content-type': contentType,
      'access-control-allow-origin': '*',
      ...extraHeaders,
    },
  });
}

function b64EncodeUtf8(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function b64DecodeUtf8(str) {
  return decodeURIComponent(escape(atob(str)));
}

function escapeYaml(str = '') {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, ' ');
}

function sanitizeHeaderValue(value = '') {
  return String(value).replace(/[\r\n]/g, ' ').trim();
}

function sanitizeFilename(value = 'subscription') {
  const clean = sanitizeHeaderValue(value)
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return clean || 'subscription';
}

function getAdminPassword(env) {
  return String(env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD);
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get('cookie') || '';
  const cookies = cookieHeader.split(';').map((item) => item.trim());
  const prefix = `${name}=`;
  const found = cookies.find((item) => item.startsWith(prefix));
  return found ? decodeURIComponent(found.slice(prefix.length)) : '';
}

function safeEqual(left = '', right = '') {
  const a = String(left);
  const b = String(right);
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function isLoggedIn(request, env) {
  const passwordHeader = request.headers.get('x-admin-password') || '';
  if (passwordHeader && safeEqual(passwordHeader, getAdminPassword(env))) {
    return true;
  }

  const sessionId = getCookie(request, AUTH_COOKIE_NAME);
  if (!sessionId || !env.SUB_STORE) return false;
  const sessionHash = await sha256Hex(sessionId);
  const stored = await env.SUB_STORE.get(`session:${sessionHash}`);
  return Boolean(stored);
}

async function buildAuthCookie(env, url) {
  if (!env.SUB_STORE) {
    throw new Error('未配置 SUB_STORE，无法创建登录会话');
  }
  const value = createShortId(32);
  const sessionHash = await sha256Hex(value);
  await env.SUB_STORE.put(`session:${sessionHash}`, '1', {
    expirationTtl: AUTH_COOKIE_MAX_AGE,
  });
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${AUTH_COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; Max-Age=${AUTH_COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax${secure}`;
}

function buildExpiredAuthCookie() {
  return `${AUTH_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

async function deleteAuthSession(request, env) {
  const sessionId = getCookie(request, AUTH_COOKIE_NAME);
  if (!sessionId || !env.SUB_STORE?.delete) return;
  const sessionHash = await sha256Hex(sessionId);
  await env.SUB_STORE.delete(`session:${sessionHash}`);
}

async function handleLogin(request, env, url) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: '请求体不是合法 JSON' }, 400);
  }

  const password = String(body.password || '');
  if (!safeEqual(password, getAdminPassword(env))) {
    return json({ ok: false, error: '登录密码错误' }, 401);
  }

  return json(
    { ok: true },
    200,
    {
      'set-cookie': await buildAuthCookie(env, url),
    },
  );
}

function parseTokenTtlDays(value) {
  const raw = String(value ?? '').trim();
  const days = raw ? Number(raw) : DEFAULT_TOKEN_TTL_DAYS;
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error('Token 过期时间必须是大于 0 的天数');
  }
  if (days > MAX_TOKEN_TTL_DAYS) {
    throw new Error(`Token 过期时间不能超过 ${MAX_TOKEN_TTL_DAYS} 天`);
  }
  return days;
}

function tokenTtlSecondsFromDays(days) {
  return Math.max(60, Math.round(days * 24 * 60 * 60));
}

function buildSubscriptionHeaders(record, extension = 'txt') {
  const clientName = sanitizeHeaderValue(record?.options?.clientName || '');
  if (!clientName) return {};
  const filename = `${sanitizeFilename(clientName)}.${extension}`;
  return {
    'profile-title': `base64:${b64EncodeUtf8(clientName)}`,
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  };
}

function parsePreferredEndpoints(input) {
  return String(input || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [raw, remark = ''] = line.split('#');
      const value = raw.trim();
      const hashRemark = remark.trim();
      const { server, port } = splitEndpointHostAndPort(value);
      return {
        server,
        port,
        remark: hashRemark,
      };
    });
}

function splitEndpointHostAndPort(value) {
  const input = String(value || '').trim();
  if (!input) return { server: '', port: undefined };

  if (input.startsWith('[')) {
    const match = input.match(/^\[([^\]]+)](?::(\d+))?$/);
    if (!match) return { server: input, port: undefined };
    return {
      server: match[1],
      port: match[2] ? Number(match[2]) : undefined,
    };
  }

  const colonCount = (input.match(/:/g) || []).length;
  if (colonCount === 1) {
    const [server, portText] = input.split(':');
    if (/^\d+$/.test(portText)) {
      return { server, port: Number(portText) };
    }
  }

  return { server: input, port: undefined };
}

function parseVmess(link) {
  const raw = link.slice('vmess://'.length).trim();
  const obj = JSON.parse(b64DecodeUtf8(raw));
  return {
    type: 'vmess',
    name: obj.ps || 'vmess',
    server: obj.add,
    port: Number(obj.port || 443),
    uuid: obj.id,
    cipher: obj.scy || 'auto',
    network: obj.net || 'ws',
    tls: obj.tls === 'tls',
    host: obj.host || '',
    path: obj.path || '/',
    sni: obj.sni || obj.host || '',
    alpn: obj.alpn || '',
    fp: obj.fp || '',
  };
}

function parseUrlLike(link, type) {
  const u = new URL(link);
  return {
    type,
    name: decodeURIComponent(u.hash.replace(/^#/, '')) || type,
    server: u.hostname,
    port: Number(u.port || 443),
    password: type === 'trojan' ? decodeURIComponent(u.username) : undefined,
    uuid: type === 'vless' ? decodeURIComponent(u.username) : undefined,
    network: u.searchParams.get('type') || 'tcp',
    tls: (u.searchParams.get('security') || '').toLowerCase() === 'tls',
    host: u.searchParams.get('host') || u.searchParams.get('sni') || '',
    path: u.searchParams.get('path') || '/',
    sni: u.searchParams.get('sni') || u.searchParams.get('host') || '',
    fp: u.searchParams.get('fp') || '',
    alpn: u.searchParams.get('alpn') || '',
    flow: u.searchParams.get('flow') || '',
  };
}

function parseRawLinks(input) {
  const lines = String(input || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const result = [];
  for (const line of lines) {
    if (line.startsWith('vmess://')) {
      result.push(parseVmess(line));
      continue;
    }
    if (line.startsWith('vless://')) {
      result.push(parseUrlLike(line, 'vless'));
      continue;
    }
    if (line.startsWith('trojan://')) {
      result.push(parseUrlLike(line, 'trojan'));
      continue;
    }
    try {
      const decoded = b64DecodeUtf8(line);
      if (/^(vmess|vless|trojan):\/\//m.test(decoded)) {
        result.push(...parseRawLinks(decoded));
      }
    } catch {}
  }
  return result;
}

function buildNodes(baseNodes, preferredEndpoints, options = {}) {
  const output = [];
  const prefix = (options.namePrefix || '').trim();
  const clientName = (options.clientName || '').trim();
  let counter = 0;
  for (const node of baseNodes) {
    for (const ep of preferredEndpoints) {
      counter += 1;
      const nameParts = [];
      nameParts.push(clientName || node.name || 'node');
      if (prefix) nameParts.push(prefix);
      if (ep.remark) nameParts.push(ep.remark);
      else nameParts.push(String(counter));
      output.push({
        ...node,
        name: nameParts.join(' | '),
        server: ep.server,
        port: ep.port || node.port,
        host: options.keepOriginalHost ? node.host : '',
        sni: options.keepOriginalHost ? node.sni : '',
      });
    }
  }
  return output;
}

function encodeVmess(node) {
  const obj = {
    v: '2',
    ps: node.name,
    add: node.server,
    port: String(node.port),
    id: node.uuid,
    aid: '0',
    scy: node.cipher || 'auto',
    net: node.network || 'ws',
    type: 'none',
    host: node.host || '',
    path: node.path || '/',
    tls: node.tls ? 'tls' : '',
    sni: node.sni || '',
    alpn: node.alpn || '',
    fp: node.fp || '',
  };
  return 'vmess://' + b64EncodeUtf8(JSON.stringify(obj));
}

function encodeVless(node) {
  const url = new URL(`vless://${encodeURIComponent(node.uuid)}@${node.server}:${node.port}`);
  url.searchParams.set('type', node.network || 'ws');
  if (node.tls) url.searchParams.set('security', 'tls');
  if (node.host) url.searchParams.set('host', node.host);
  if (node.sni) url.searchParams.set('sni', node.sni);
  if (node.path) url.searchParams.set('path', node.path);
  if (node.alpn) url.searchParams.set('alpn', node.alpn);
  if (node.fp) url.searchParams.set('fp', node.fp);
  if (node.flow) url.searchParams.set('flow', node.flow);
  url.hash = node.name;
  return url.toString();
}

function encodeTrojan(node) {
  const url = new URL(`trojan://${encodeURIComponent(node.password)}@${node.server}:${node.port}`);
  if (node.network) url.searchParams.set('type', node.network);
  if (node.tls) url.searchParams.set('security', 'tls');
  if (node.host) url.searchParams.set('host', node.host);
  if (node.sni) url.searchParams.set('sni', node.sni);
  if (node.path) url.searchParams.set('path', node.path);
  if (node.alpn) url.searchParams.set('alpn', node.alpn);
  if (node.fp) url.searchParams.set('fp', node.fp);
  url.hash = node.name;
  return url.toString();
}

function renderRaw(nodes) {
  const lines = nodes
    .map((node) => {
      if (node.type === 'vmess') return encodeVmess(node);
      if (node.type === 'vless') return encodeVless(node);
      if (node.type === 'trojan') return encodeTrojan(node);
      return '';
    })
    .filter(Boolean);
  return b64EncodeUtf8(lines.join('\n'));
}

function renderClash(nodes) {
  const proxies = nodes
    .map((node) => {
      if (node.type === 'vmess') {
        return [
          `  - name: "${escapeYaml(node.name)}"`,
          `    type: vmess`,
          `    server: ${node.server}`,
          `    port: ${node.port}`,
          `    uuid: ${node.uuid}`,
          `    alterId: 0`,
          `    cipher: ${node.cipher || 'auto'}`,
          `    tls: ${node.tls ? 'true' : 'false'}`,
          `    network: ${node.network || 'ws'}`,
          `    servername: "${escapeYaml(node.sni || '')}"`,
          `    ws-opts:`,
          `      path: "${escapeYaml(node.path || '/')}"`,
          `      headers:`,
          `        Host: "${escapeYaml(node.host || '')}"`,
        ].join('\n');
      }
      if (node.type === 'vless') {
        return [
          `  - name: "${escapeYaml(node.name)}"`,
          `    type: vless`,
          `    server: ${node.server}`,
          `    port: ${node.port}`,
          `    uuid: ${node.uuid}`,
          `    tls: ${node.tls ? 'true' : 'false'}`,
          `    network: ${node.network || 'ws'}`,
          `    servername: "${escapeYaml(node.sni || '')}"`,
          `    ws-opts:`,
          `      path: "${escapeYaml(node.path || '/')}"`,
          `      headers:`,
          `        Host: "${escapeYaml(node.host || '')}"`,
        ].join('\n');
      }
      if (node.type === 'trojan') {
        return [
          `  - name: "${escapeYaml(node.name)}"`,
          `    type: trojan`,
          `    server: ${node.server}`,
          `    port: ${node.port}`,
          `    password: "${escapeYaml(node.password || '')}"`,
          `    sni: "${escapeYaml(node.sni || '')}"`,
          `    network: ${node.network || 'ws'}`,
          `    ws-opts:`,
          `      path: "${escapeYaml(node.path || '/')}"`,
          `      headers:`,
          `        Host: "${escapeYaml(node.host || '')}"`,
        ].join('\n');
      }
      return '';
    })
    .filter(Boolean);

  return ['proxies:', ...proxies].join('\n');
}

function renderSurge(nodes, baseUrl, accessToken) {
  const proxies = nodes
    .filter((node) => node.type === 'vmess' || node.type === 'trojan')
    .map((node) => {
      if (node.type === 'vmess') {
        return `${node.name} = vmess, ${node.server}, ${node.port}, username=${node.uuid}, ws=true, ws-path=${node.path || '/'}, ws-headers=Host:${node.host || ''}, tls=${node.tls ? 'true' : 'false'}, sni=${node.sni || ''}`;
      }
      return `${node.name} = trojan, ${node.server}, ${node.port}, password=${node.password || ''}, sni=${node.sni || ''}`;
    });

  return [
    '[General]',
    'skip-proxy = 127.0.0.1, localhost',
    '',
    '[Proxy]',
    ...proxies,
    '',
    '[Proxy Group]',
    'Proxy = select, ' +
      nodes
        .filter((n) => n.type === 'vmess' || n.type === 'trojan')
        .map((n) => n.name)
        .join(', '),
    '',
    '[Rule]',
    'FINAL,Proxy',
    '',
    '; token-protected subscription',
    `; ${baseUrl}?token=${accessToken}`,
  ].join('\n');
}

function createShortId(length = 10) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[bytes[i] % chars.length];
  }
  return out;
}

async function createUniqueShortId(env, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const id = createShortId(10);
    const exists = await env.SUB_STORE.get(`sub:${id}`);
    if (!exists) return id;
  }
  throw new Error('无法生成唯一短链接，请稍后再试');
}

function normalizeLines(value = '') {
  return String(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort()
    .join('\n');
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function buildDedupHash(body, normalizedOptions = {}) {
  const normalized = {
    nodeLinks: normalizeLines(body.nodeLinks || ''),
    preferredIps: normalizeLines(body.preferredIps || ''),
    namePrefix: String(body.namePrefix || '').trim(),
    clientName: String(normalizedOptions.clientName || '').trim(),
    keepOriginalHost: body.keepOriginalHost !== false,
    tokenTtlSeconds: normalizedOptions.tokenTtlSeconds,
  };
  return sha256Hex(JSON.stringify(normalized));
}

async function handleGenerate(request, env, url) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: '请求体不是合法 JSON' }, 400);
  }

  const baseNodes = parseRawLinks(body.nodeLinks || '');
  const preferredEndpoints = parsePreferredEndpoints(body.preferredIps || '');

  if (!baseNodes.length) return json({ ok: false, error: '没有识别到可用节点' }, 400);
  if (!preferredEndpoints.length) return json({ ok: false, error: '没有识别到可用优选地址' }, 400);

  let tokenTtlDays;
  try {
    tokenTtlDays = parseTokenTtlDays(body.tokenTtlDays);
  } catch (error) {
    return json({ ok: false, error: error.message }, 400);
  }
  const tokenTtlSeconds = tokenTtlSecondsFromDays(tokenTtlDays);
  const clientName = sanitizeHeaderValue(body.clientName || '');

  const options = {
    namePrefix: body.namePrefix || '',
    clientName,
    keepOriginalHost: body.keepOriginalHost !== false,
    tokenTtlDays,
    tokenTtlSeconds,
  };

  const nodes = buildNodes(baseNodes, preferredEndpoints, options);

  const payload = {
    version: 1,
    createdAt: new Date().toISOString(),
    options,
    nodes,
  };

  const dedupHash = await buildDedupHash(body, options);
  const dedupKey = `dedup:${dedupHash}`;

  let id = await env.SUB_STORE.get(dedupKey);
  const deduplicated = Boolean(id);

  if (!id) {
    id = await createUniqueShortId(env);
  }

  await env.SUB_STORE.put(`sub:${id}`, JSON.stringify(payload), {
    expirationTtl: tokenTtlSeconds,
  });

  await env.SUB_STORE.put(dedupKey, id, {
    expirationTtl: tokenTtlSeconds,
  });

  const origin = url.origin;
  const accessToken = env.SUB_ACCESS_TOKEN || '';
  const withToken = (target) =>
    `${origin}/sub/${id}${
      target
        ? `?target=${target}&token=${encodeURIComponent(accessToken)}`
        : `?token=${encodeURIComponent(accessToken)}`
    }`;

  return json({
    ok: true,
    storage: 'kv',
    deduplicated,
    shortId: id,
    clientName,
    tokenTtlDays,
    tokenTtlSeconds,
    expiresAt: new Date(Date.now() + tokenTtlSeconds * 1000).toISOString(),
    urls: {
      auto: withToken(''),
      raw: withToken('raw'),
      clash: withToken('clash'),
      surge: withToken('surge'),
    },
    counts: {
      inputNodes: baseNodes.length,
      preferredEndpoints: preferredEndpoints.length,
      outputNodes: nodes.length,
    },
    preview: nodes.slice(0, 20).map((node) => ({
      name: node.name,
      type: node.type,
      server: node.server,
      port: node.port,
      host: node.host || '',
      sni: node.sni || '',
    })),
    warnings: accessToken ? [] : ['未检测到 SUB_ACCESS_TOKEN，订阅链接将没有第二层访问保护。'],
  });
}

function validateAccessToken(url, env) {
  const expected = env.SUB_ACCESS_TOKEN;
  if (!expected) return { ok: true };
  const provided = url.searchParams.get('token') || '';
  if (!provided || provided !== expected) {
    return { ok: false, response: text('Forbidden: invalid token', 403) };
  }
  return { ok: true };
}

async function handleSub(url, env) {
  const tokenCheck = validateAccessToken(url, env);
  if (!tokenCheck.ok) return tokenCheck.response;

  const id = url.pathname.split('/').pop();
  if (!id) return text('missing id', 400);

  const raw = await env.SUB_STORE.get(`sub:${id}`);
  if (!raw) return text('not found', 404);

  const record = JSON.parse(raw);
  const nodes = record.nodes || [];
  const target = (url.searchParams.get('target') || 'raw').toLowerCase();

  if (target === 'clash') {
    return text(
      renderClash(nodes),
      200,
      'text/yaml; charset=utf-8',
      buildSubscriptionHeaders(record, 'yaml'),
    );
  }
  if (target === 'surge') {
    return text(
      renderSurge(nodes, url.origin + url.pathname, env.SUB_ACCESS_TOKEN || ''),
      200,
      'text/plain; charset=utf-8',
      buildSubscriptionHeaders(record, 'conf'),
    );
  }
  return text(
    renderRaw(nodes),
    200,
    'text/plain; charset=utf-8',
    buildSubscriptionHeaders(record, 'txt'),
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'content-type,x-admin-password',
        },
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/login') {
      return handleLogin(request, env, url);
    }

    if (request.method === 'POST' && url.pathname === '/api/logout') {
      await deleteAuthSession(request, env);
      return json(
        { ok: true },
        200,
        {
          'set-cookie': buildExpiredAuthCookie(),
        },
      );
    }

    if (request.method === 'GET' && url.pathname === '/api/session') {
      return json({ ok: true, authenticated: await isLoggedIn(request, env) });
    }

    if (request.method === 'POST' && url.pathname === '/api/generate') {
      if (!(await isLoggedIn(request, env))) {
        return json({ ok: false, error: '请先登录' }, 401);
      }
      return handleGenerate(request, env, url);
    }

    if (request.method === 'GET' && url.pathname.startsWith('/sub/')) {
      return handleSub(url, env);
    }

    return env.ASSETS.fetch(request);
  },
};
