#!/usr/bin/env node
/**
 * Agent Bullpen orchestrator.
 *
 * Owns a fixed set of desks. Each desk holds one persistent Claude Code
 * conversation, driven headlessly with `claude -p`. Worker output arrives as
 * newline-delimited JSON on stdout and is folded into the same event vocabulary
 * the bullpen UI already speaks, then pushed to the browser over SSE.
 *
 * Nothing here talks to the Anthropic API directly. It shells out to the
 * `claude` binary, which uses the subscription already logged in on this
 * machine. (`--bare` would bypass that and demand an API key, so it is
 * deliberately NOT used.)
 *
 *   node server/orchestrator.mjs --repo /path/to/project
 *
 * Then open http://localhost:4477
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/* ─────────────────────── config ─────────────────────── */
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT           = Number(flag('port', process.env.BULLPEN_PORT || 4477));
const REPO           = resolve(flag('repo', process.env.BULLPEN_REPO || process.cwd()));
const MODEL          = flag('model', 'sonnet');
const MANAGER_MODEL  = flag('manager-model', 'opus');
const DESK_COUNT     = Math.max(1, Math.min(6, Number(flag('desks', 6))));
const ASK_TIMEOUT_MS = Number(flag('ask-timeout', 15 * 60 * 1000));
const CLAUDE_BIN     = flag('claude-bin', process.env.CLAUDE_BIN || 'claude');

const NAMES = ['Ada', 'Byte', 'Cog', 'Dot', 'Echo', 'Flint'];

if (!existsSync(REPO)) {
  console.error(`No such directory: ${REPO}\nPass --repo /path/to/your/project`);
  process.exit(1);
}

/* The hook is handed to every worker through --settings, so nothing is written
   to the user's own ~/.claude/settings.json. */
const CONF_DIR = join(ROOT, '.bullpen');
const SETTINGS_PATH = join(CONF_DIR, 'settings.json');
const HOOK_PATH = join(ROOT, 'hooks', 'permission-hook.mjs');
mkdirSync(CONF_DIR, { recursive: true });
writeFileSync(SETTINGS_PATH, JSON.stringify({
  hooks: {
    PermissionRequest: [
      { hooks: [{ type: 'command', command: `"${process.execPath}" "${HOOK_PATH}" --port ${PORT}` }] }
    ]
  }
}, null, 2));

/* ─────────────────────── state ─────────────────────── */
const desks = Array.from({ length: DESK_COUNT }, (_, i) => ({
  i,
  name: NAMES[i],
  sessionId: null,
  status: 'empty',          // empty | working | waiting | done | error
  task: null,
  act: 'idle',
  actLabel: '',
  proc: null,
  ask: null,                // {id, tool, detail, input, decided, decision, reason}
  queue: [],
  done: 0,
  cost: 0,
  startedAt: null,
}));

const asks = new Map();      // askId -> ask record (shared with the hook endpoints)
const clients = new Set();   // SSE responses
let lastPlan = null;

const publicDesk = d => ({
  i: d.i, name: d.name, status: d.status, task: d.task, act: d.act,
  actLabel: d.actLabel, sessionId: d.sessionId, done: d.done,
  queued: d.queue.length, cost: Number(d.cost.toFixed(4)),
  ask: d.ask && !d.ask.decided ? { id: d.ask.id, tool: d.ask.tool, detail: d.ask.detail } : null,
});

function send(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const c of clients) { try { c.write(line); } catch { /* client went away */ } }
}
function emit(desk, type, detail = '', extra = {}) {
  send({ kind: 'event', desk: desk.i, name: desk.name, type, detail, ...extra, ts: Date.now() });
}
function pushState() {
  send({ kind: 'state', desks: desks.map(publicDesk) });
}

/* ─────────────────── stream-json → bullpen events ────────────────── */
const trunc = (s, n) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
const shortPath = p => (p ? String(p).split('/').slice(-2).join('/') : '');

function summarize(name, input = {}) {
  switch (name) {
    case 'Read': case 'NotebookRead':
      return shortPath(input.file_path);
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit':
      return shortPath(input.file_path);
    case 'Grep':
      return `"${trunc(input.pattern, 28)}"` + (input.path ? ` in ${shortPath(input.path)}` : '');
    case 'Glob':
      return trunc(input.pattern, 36);
    case 'Bash': case 'BashOutput':
      return trunc(input.command, 56);
    case 'WebSearch':
      return trunc(input.query, 44);
    case 'WebFetch':
      return trunc(input.url, 44);
    case 'Agent': case 'Task':
      return trunc(input.description || input.prompt, 44);
    default:
      return trunc(JSON.stringify(input), 44);
  }
}

function handleMessage(desk, msg) {
  if (msg.type === 'system' && msg.subtype === 'init') {
    if (msg.session_id) desk.sessionId = msg.session_id;
    emit(desk, 'SessionStart', desk.task || '');
    pushState();
    return;
  }

  if (msg.type === 'system' && msg.subtype === 'api_retry') {
    emit(desk, 'Notification', `retrying (${msg.error})`);
    return;
  }

  if (msg.type === 'system' && msg.subtype === 'permission_denied') {
    emit(desk, 'Notification', `denied: ${trunc(msg.tool_name || 'tool call', 40)}`);
    return;
  }

  if (msg.type === 'assistant') {
    const isSub = !!msg.parent_tool_use_id;
    for (const block of msg.message?.content ?? []) {
      if (block.type !== 'tool_use') continue;
      if (block.name === 'Agent' || block.name === 'Task') {
        emit(desk, 'SubagentStart', summarize(block.name, block.input));
      } else {
        desk.act = block.name;
        desk.actLabel = summarize(block.name, block.input);
        emit(desk, 'PreToolUse', desk.actLabel, { tool: block.name, sub: isSub });
      }
    }
    return;
  }

  if (msg.type === 'user') {
    // A tool_result coming back. One unit of progress.
    const blocks = msg.message?.content ?? [];
    if (Array.isArray(blocks) && blocks.some(b => b.type === 'tool_result')) {
      desk.done++;
      emit(desk, 'PostToolUse', '');
    }
    return;
  }

  if (msg.type === 'result') {
    desk.cost += Number(msg.total_cost_usd || 0);
    if (msg.is_error || msg.subtype === 'error_during_execution') {
      desk.status = 'error';
      emit(desk, 'Notification', trunc(msg.result || 'run failed', 60));
    } else {
      desk.status = 'done';
      emit(desk, 'Stop', trunc(msg.result || desk.task || 'done', 120), {
        cost: Number(msg.total_cost_usd || 0),
      });
    }
    pushState();
  }
}

/* ─────────────────────── running a desk ─────────────────────── */
function runTask(desk, task) {
  desk.task = task;
  desk.status = 'working';
  desk.act = 'thinking';
  desk.actLabel = 'starting up';
  desk.done = 0;
  desk.ask = null;
  desk.startedAt = Date.now();

  const args = [
    '-p', task,
    '--output-format', 'stream-json',
    '--verbose',
    '--settings', SETTINGS_PATH,
    '--permission-mode', 'default',
    '--model', MODEL,
  ];

  // First task on this desk opens a session we name ourselves; later tasks
  // resume it, so the desk keeps its memory of what it already did.
  if (desk.sessionId) args.push('--resume', desk.sessionId);
  else { desk.sessionId = randomUUID(); args.push('--session-id', desk.sessionId); }

  let proc;
  try {
    proc = spawn(CLAUDE_BIN, args, {
      cwd: REPO,
      env: { ...process.env, BULLPEN_PORT: String(PORT), BULLPEN_DESK: String(desk.i) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    desk.status = 'error';
    emit(desk, 'Notification', `could not start claude: ${err.message}`);
    pushState();
    return;
  }

  desk.proc = proc;
  pushState();
  console.log(`[${desk.name}] ${desk.sessionId.slice(0, 8)} :: ${trunc(task, 70)}`);

  proc.on('error', err => {
    desk.status = 'error';
    emit(desk, 'Notification',
      err.code === 'ENOENT'
        ? `\`${CLAUDE_BIN}\` not found on PATH`
        : `spawn failed: ${err.message}`);
    desk.proc = null;
    pushState();
  });

  const rl = createInterface({ input: proc.stdout });
  rl.on('line', line => {
    line = line.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }   // non-JSON noise
    try { handleMessage(desk, msg); }
    catch (err) { console.error(`[${desk.name}] handler:`, err.message); }
  });

  let stderr = '';
  proc.stderr.on('data', chunk => { stderr += chunk; });

  proc.on('close', code => {
    desk.proc = null;
    if (code !== 0 && desk.status !== 'error') {
      desk.status = 'error';
      emit(desk, 'Notification', trunc(stderr || `claude exited ${code}`, 80));
    }
    if (stderr.trim()) console.error(`[${desk.name}] stderr: ${trunc(stderr, 300)}`);

    const next = desk.queue.shift();
    if (next) runTask(desk, next);
    else pushState();
  });
}

function assign(deskIndex, task) {
  const desk = desks[deskIndex];
  if (!desk) return { error: 'no such desk' };
  if (!task || !task.trim()) return { error: 'empty task' };
  if (desk.proc) {
    desk.queue.push(task);
    emit(desk, 'Queued', trunc(task, 60));
    pushState();
    return { queued: true, position: desk.queue.length };
  }
  runTask(desk, task);
  return { started: true };
}

/* ─────────────────────── the manager ─────────────────────── */
const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    subtasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          brief: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'brief'],
      },
    },
  },
  required: ['summary', 'subtasks'],
};

function managerPrompt(goal, seats) {
  return [
    `You are the floor manager for ${seats} independent coding agents.`,
    ``,
    `The goal is:`,
    goal,
    ``,
    `Explore this repository read-only, then split the goal into at most ${seats}`,
    `subtasks and return them in the required schema. Constraints that matter:`,
    ``,
    `1. Each agent is a SEPARATE Claude Code session with an empty context. It`,
    `   cannot see this plan, the other subtasks, or anything you learned. So`,
    `   every "brief" must stand alone: name the exact files and symbols, state`,
    `   the expected end result, and include any convention you discovered that`,
    `   the agent would otherwise have to rediscover.`,
    `2. Subtasks run AT THE SAME TIME in the same working tree. Two agents must`,
    `   never be told to edit the same file. If the work cannot be partitioned`,
    `   that way, return fewer subtasks rather than overlapping ones.`,
    `3. Order-dependent work cannot be parallelised. If step B needs step A's`,
    `   output, put both in one subtask and say so in the brief.`,
    `4. Prefer ${seats} well-separated subtasks, but returning 2 good ones beats`,
    `   ${seats} that collide.`,
    ``,
    `Do not edit anything. Planning only.`,
  ].join('\n');
}

function runManager(goal) {
  return new Promise(resolve => {
    const args = [
      '-p', managerPrompt(goal, DESK_COUNT),
      '--output-format', 'json',
      '--json-schema', JSON.stringify(PLAN_SCHEMA),
      '--allowedTools', 'Read,Glob,Grep',
      '--permission-mode', 'dontAsk',
      '--model', MANAGER_MODEL,
    ];
    const proc = spawn(CLAUDE_BIN, args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '', err = '';
    proc.stdout.on('data', c => { out += c; });
    proc.stderr.on('data', c => { err += c; });
    proc.on('error', e => resolve({ error: `could not start claude: ${e.message}` }));
    proc.on('close', code => {
      if (code !== 0) return resolve({ error: trunc(err || `manager exited ${code}`, 200) });
      try {
        const payload = JSON.parse(out);
        const plan = payload.structured_output;
        if (!plan?.subtasks?.length) {
          return resolve({ error: 'manager returned no subtasks', raw: trunc(payload.result, 300) });
        }
        plan.cost = payload.total_cost_usd;
        resolve({ plan });
      } catch (e) {
        resolve({ error: `could not parse manager output: ${e.message}`, raw: trunc(out, 300) });
      }
    });
  });
}

/* ─────────────────────── http ─────────────────────── */
const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const readBody = req => new Promise((resolve, reject) => {
  let b = '';
  req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    /* ---- the page, with the live layer injected ---- */
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      let html = readFileSync(join(ROOT, 'index.html'), 'utf8');
      html = html.replace('</body>', '<script src="/live.js"></script>\n</body>');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (req.method === 'GET' && path === '/live.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      return res.end(readFileSync(join(HERE, 'live.js'), 'utf8'));
    }

    /* ---- the event stream ---- */
    if (req.method === 'GET' && path === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      res.write(`data: ${JSON.stringify({
        kind: 'hello', repo: REPO, model: MODEL, managerModel: MANAGER_MODEL,
        desks: desks.map(publicDesk),
      })}\n\n`);
      clients.add(res);
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 20000);
      req.on('close', () => { clearInterval(ka); clients.delete(res); });
      return;
    }

    if (req.method === 'GET' && path === '/api/state') {
      return json(res, 200, { repo: REPO, model: MODEL, desks: desks.map(publicDesk) });
    }

    /* ---- assigning work ---- */
    if (req.method === 'POST' && path === '/api/assign') {
      const { desk, task } = await readBody(req);
      const result = assign(Number(desk), String(task || ''));
      return json(res, result.error ? 400 : 200, result);
    }

    if (req.method === 'POST' && path === '/api/plan') {
      const { goal } = await readBody(req);
      if (!goal?.trim()) return json(res, 400, { error: 'empty goal' });
      send({ kind: 'manager', status: 'planning', goal });
      const result = await runManager(goal);
      lastPlan = result.plan ?? null;
      send({ kind: 'manager', status: result.error ? 'failed' : 'planned', ...result });
      return json(res, 200, result);
    }

    if (req.method === 'POST' && path === '/api/dispatch') {
      const { assignments } = await readBody(req);
      if (!Array.isArray(assignments)) return json(res, 400, { error: 'assignments must be an array' });
      const out = assignments.map(a => ({ desk: a.desk, ...assign(Number(a.desk), String(a.task || '')) }));
      send({ kind: 'manager', status: 'dispatched', count: out.length });
      return json(res, 200, { dispatched: out });
    }

    /* ---- permission: the browser side ---- */
    if (req.method === 'POST' && path === '/api/permission') {
      const { askId, decision, reason } = await readBody(req);
      const ask = asks.get(askId);
      if (!ask) return json(res, 404, { error: 'unknown or expired request' });
      if (ask.decided) return json(res, 200, { already: ask.decision });
      ask.decided = true;
      ask.decision = decision === 'allow' ? 'allow' : 'deny';
      ask.reason = reason || (ask.decision === 'deny' ? 'Denied from the bullpen' : '');
      const desk = desks[ask.desk];
      desk.status = 'working';
      emit(desk, 'PermissionAnswered', ask.decision, { tool: ask.tool, detail: ask.detail });
      pushState();
      return json(res, 200, { ok: true, decision: ask.decision });
    }

    /* ---- permission: the hook side ---- */
    if (req.method === 'POST' && path === '/hook/permission') {
      const body = await readBody(req);
      const desk = desks.find(d => d.sessionId && d.sessionId === body.session_id);
      if (!desk) return json(res, 200, { decision: 'deny', reason: 'no desk owns this session' });

      const ask = {
        id: randomUUID(),
        desk: desk.i,
        tool: body.tool_name,
        input: body.tool_input,
        detail: summarize(body.tool_name, body.tool_input),
        decided: false,
        decision: null,
        reason: '',
        at: Date.now(),
      };
      asks.set(ask.id, ask);
      desk.ask = ask;
      desk.status = 'waiting';
      emit(desk, 'PermissionRequest', ask.detail, { tool: ask.tool, askId: ask.id });
      pushState();
      console.log(`[${desk.name}] raised a hand: ${ask.tool} ${ask.detail}`);

      setTimeout(() => {
        if (ask.decided) return;
        ask.decided = true;
        ask.decision = 'deny';
        ask.reason = 'Nobody answered in the bullpen before the timeout';
        if (desks[ask.desk].ask === ask) desks[ask.desk].status = 'working';
        emit(desks[ask.desk], 'PermissionAnswered', 'deny', { detail: 'timed out' });
        pushState();
      }, ASK_TIMEOUT_MS);

      return json(res, 200, { askId: ask.id });
    }

    if (req.method === 'GET' && path.startsWith('/hook/permission/')) {
      const ask = asks.get(path.slice('/hook/permission/'.length));
      if (!ask) return json(res, 404, { error: 'unknown request' });
      return json(res, 200, ask.decided
        ? { decided: true, decision: ask.decision, reason: ask.reason }
        : { decided: false });
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  } catch (err) {
    console.error('request failed:', err);
    if (!res.headersSent) json(res, 500, { error: String(err.message || err) });
  }
});

/* Bound to loopback on purpose, and no CORS headers: the only page allowed to
   drive this is the one this server hands out itself. */
server.listen(PORT, '127.0.0.1', () => {
  console.log(`
  Agent Bullpen
  ─────────────────────────────────────────────
  floor    http://localhost:${PORT}
  repo     ${REPO}
  desks    ${DESK_COUNT} (${desks.map(d => d.name).join(', ')})
  workers  ${MODEL}   manager  ${MANAGER_MODEL}

  Workers run through the \`${CLAUDE_BIN}\` CLI, so they use the
  subscription already logged in on this machine.
  Ctrl-C to close the floor.
`);
});

function shutdown() {
  console.log('\nsending everyone home...');
  for (const d of desks) if (d.proc) d.proc.kill('SIGINT');
  setTimeout(() => process.exit(0), 600);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
