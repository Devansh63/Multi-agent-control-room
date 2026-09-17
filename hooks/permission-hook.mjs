#!/usr/bin/env node
/**
 * PermissionRequest hook.
 *
 * Claude Code runs this whenever a worker asks to do something that needs a
 * decision. It reads the request on stdin, hands it to the orchestrator (which
 * makes that worker stand up and raise a hand on the floor), waits for the
 * Approve / Deny click, and prints the verdict back.
 *
 * Registered through --settings by the orchestrator, never in your global
 * ~/.claude/settings.json, so it only ever affects bullpen workers.
 */
const portFlag = process.argv.indexOf('--port');
const PORT = portFlag >= 0 ? process.argv[portFlag + 1] : (process.env.BULLPEN_PORT || 4477);
const BASE = `http://127.0.0.1:${PORT}`;
const POLL_MS = 1200;

const verdict = (decision, decisionReason) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision, ...(decisionReason ? { decisionReason } : {}) },
  }));
  process.exit(0);
};

const readStdin = () => new Promise(resolve => {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { raw += c; });
  process.stdin.on('end', () => resolve(raw));
  // If stdin never closes, don't hang the worker forever.
  setTimeout(() => resolve(raw), 10000);
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

try {
  const raw = await readStdin();
  const req = JSON.parse(raw);

  const res = await fetch(`${BASE}/hook/permission`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: req.session_id,
      tool_name: req.tool_name,
      tool_input: req.tool_input,
      tool_use_id: req.tool_use_id,
      cwd: req.cwd,
    }),
  });

  const { askId, decision, reason } = await res.json();

  // The orchestrator can answer immediately (e.g. it doesn't recognise the session).
  if (decision) verdict(decision, reason);
  if (!askId) verdict('deny', 'The bullpen did not accept this request');

  // Park here until somebody clicks. Short polls rather than one long-held
  // request, so no HTTP client timeout can cut the wait short.
  for (;;) {
    await sleep(POLL_MS);
    let state;
    try {
      const r = await fetch(`${BASE}/hook/permission/${askId}`);
      state = await r.json();
    } catch {
      continue;   // orchestrator restarting; keep waiting
    }
    if (state.decided) verdict(state.decision, state.reason);
  }
} catch (err) {
  verdict('deny', `Bullpen permission bridge unreachable (${err.message}). Nobody could approve this.`);
}
