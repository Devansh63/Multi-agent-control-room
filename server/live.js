/**
 * Live layer.
 *
 * index.html on its own is a simulation. The orchestrator injects this file,
 * which shuts the simulator down and drives the same floor from real Claude
 * Code sessions instead. It reaches into the page's top-level bindings
 * (agents, paused, selectedId, paint, note, LOOKS, DESKS, ACT, TOOL_ACT) --
 * classic scripts share one global scope, so they're all in reach.
 */
(async () => {
  'use strict';

  try {
    const probe = await fetch('/api/state');
    if (!probe.ok) return;
  } catch {
    return;   // no orchestrator: stay a demo
  }

  /* -- take the floor off the simulator -- */
  paused = true;
  agents.length = 0;
  selectedId = null;

  const ROLE = ['engineer', 'engineer', 'reviewer', 'engineer', 'researcher', 'engineer'];
  const byDesk = new Map();

  function seat(info) {
    let a = byDesk.get(info.i);
    if (!a) {
      const d = DESKS[info.i];
      a = {
        id: 'desk_' + info.i,
        deskIndex: info.i,
        name: info.name,
        role: ROLE[info.i % ROLE.length],
        look: LOOKS[(info.i * 3) % LOOKS.length],
        desk: info.i,
        task: info.task || '',
        repo: LIVE.repoShort,
        x: DESKS[info.i].x + 22, y: d.y + 9,
        face: 'up', flip: false, frame: 0, walkT: 0,
        path: [], seated: true,
        act: 'thinking', actLabel: '', actT: 0, actDur: 9e9,
        ask: null, askId: null, sub: null, isSub: false, host: null,
        started: new Date(), log: [], screenJitter: 0,
        done: 0, total: 12,
      };
      byDesk.set(info.i, a);
      agents.push(a);
      if (!selectedId) selectedId = a.id;
    }
    return a;
  }

  function unseat(i) {
    const a = byDesk.get(i);
    if (!a) return;
    byDesk.delete(i);
    const at = agents.indexOf(a);
    if (at >= 0) agents.splice(at, 1);
    if (selectedId === a.id) selectedId = agents[0]?.id ?? null;
  }

  /* -- the event stream -- */
  const LIVE = { repo: '', repoShort: '', model: '', managerModel: '', plan: null };

  function applyDeskState(list) {
    const live = new Set();
    for (const info of list) {
      if (info.status === 'empty' && !info.task) continue;
      live.add(info.i);
      const a = seat(info);
      a.task = info.task || a.task;
      a.done = info.done ?? a.done;
      a.total = Math.max(a.done + 2, 12);
      if (info.status === 'waiting' && info.ask) {
        a.act = 'waiting';
        a.actLabel = 'waiting for approval';
        a.askId = info.ask.id;
        a.ask = { why: `${info.ask.tool} needs your approval`, cmd: info.ask.detail };
      } else if (info.status === 'done') {
        a.act = 'done'; a.actLabel = 'task complete'; a.ask = null; a.askId = null;
      } else if (info.status === 'error') {
        a.act = 'error'; a.ask = null; a.askId = null;
      } else if (a.act === 'waiting') {
        a.act = 'thinking'; a.ask = null; a.askId = null;
      }
    }
    for (const i of [...byDesk.keys()]) if (!live.has(i)) unseat(i);
    paint();
    renderDeskPicker();
  }

  /* Backfill a desk's log from the tail the server kept, so a reload doesn't
     land on an empty ACTIVITY panel. */
  function replay(info) {
    if (!info.history?.length) return;
    const a = byDesk.get(info.i);
    if (!a || a.log.length) return;
    for (const e of info.history) {
      const html = describe(e);
      if (html) a.log.push({ t: new Date(e.ts), html });
    }
  }

  function describe(e) {
    switch (e.type) {
      case 'SessionStart':       return `<b>${esc(e.name)}</b> picked up &mdash; ${esc(e.detail || '')}`;
      case 'PreToolUse':         return `<b>${esc(e.tool)}</b> ${esc(e.detail)}`;
      case 'SubagentStart':      return `spawned a sub-agent &mdash; <b>${esc(e.detail)}</b>`;
      case 'Queued':             return `queued &mdash; ${esc(e.detail)}`;
      case 'PermissionRequest':  return `<b style="color:#f3ac3c">needs approval</b> &mdash; ${esc(e.tool)} ${esc(e.detail)}`;
      case 'PermissionAnswered': return `<b style="color:${e.detail === 'allow' ? '#57d39c' : '#e4635e'}">${esc(e.detail)}</b>`;
      case 'Notification':       return `<b style="color:#e4635e">${esc(e.detail)}</b>`;
      case 'Stop':               return `<b style="color:#b382ea">finished</b> &mdash; ${esc(e.detail)}`;
      default:                   return '';
    }
  }

  function onEvent(e) {
    const a = seat({ i: e.desk, name: e.name });
    switch (e.type) {
      case 'SessionStart':
        a.task = e.detail || a.task;
        a.started = new Date();
        a.done = 0;
        a.act = 'thinking';
        a.actLabel = 'reading the brief';
        note(a, `<b>${a.name}</b> picked up &mdash; ${esc(e.detail || '')}`);
        break;
      case 'PreToolUse':
        a.act = TOOL_ACT[e.tool] || 'thinking';
        a.actLabel = e.detail;
        note(a, `<b>${esc(e.tool)}</b> ${esc(e.detail)}${e.sub ? ' <i>(sub-agent)</i>' : ''}`);
        break;
      case 'PostToolUse':
        a.done++;
        if (a.done > a.total - 2) a.total = a.done + 4;
        break;
      case 'SubagentStart':
        note(a, `spawned a sub-agent &mdash; <b>${esc(e.detail)}</b>`);
        break;
      case 'Queued':
        note(a, `queued &mdash; ${esc(e.detail)}`);
        break;
      case 'PermissionRequest':
        a.act = 'waiting';
        a.actLabel = 'waiting for approval';
        a.askId = e.askId;
        a.ask = { why: `${e.tool} needs your approval`, cmd: e.detail };
        note(a, `<b style="color:#f3ac3c">needs approval</b> &mdash; ${esc(e.tool)} ${esc(e.detail)}`);
        break;
      case 'PermissionAnswered':
        a.ask = null; a.askId = null;
        a.act = e.detail === 'timed out' ? 'error' : 'thinking';
        note(a, e.detail === 'timed out'
          ? `<b style="color:#e4635e">timed out</b> waiting for an answer`
          : `<b style="color:${e.detail === 'allow' ? '#57d39c' : '#e4635e'}">${e.detail === 'allow' ? 'approved' : 'denied'}</b>`);
        break;
      case 'Notification':
        a.act = 'error';
        a.actLabel = e.detail;
        note(a, `<b style="color:#e4635e">${esc(e.detail)}</b>`);
        break;
      case 'Stop':
        a.act = 'done';
        a.actLabel = 'task complete';
        note(a, `<b style="color:#b382ea">finished</b> &mdash; ${esc(e.detail)}`);
        break;
    }
    paint();
  }

  const stream = new EventSource('/api/events');
  stream.onmessage = m => {
    let msg; try { msg = JSON.parse(m.data); } catch { return; }
    if (msg.kind === 'hello') {
      LIVE.repo = msg.repo;
      LIVE.repoShort = msg.repo.split('/').slice(-2).join('/');
      LIVE.model = msg.model;
      LIVE.managerModel = msg.managerModel;
      document.querySelector('.ticker .src').innerHTML =
        `<i></i> LIVE &middot; ${esc(LIVE.repoShort)}`;
      document.querySelector('.brand .sub').textContent =
        `${msg.desks.length} desks · ${msg.model} · ${LIVE.repoShort}`;
      applyDeskState(msg.desks);
      for (const info of msg.desks) replay(info);
      paint();
    } else if (msg.kind === 'state') {
      applyDeskState(msg.desks);
    } else if (msg.kind === 'event') {
      onEvent(msg);
    } else if (msg.kind === 'manager') {
      onManager(msg);
    }
  };
  stream.onerror = () => {
    document.querySelector('.ticker .src').innerHTML = '<i style="background:#e4635e"></i> DISCONNECTED';
  };

  /* -- Approve / Deny go to the real session -- */
  document.addEventListener('click', async ev => {
    const btn = ev.target.closest('[data-answer]');
    if (!btn) return;
    const a = agents.find(x => x.id === selectedId);
    if (!a?.askId) return;
    ev.stopPropagation();          // keep the simulator's handler out of it
    ev.preventDefault();
    const askId = a.askId;
    a.ask = null; a.askId = null;
    a.actLabel = 'resuming';
    paint();
    await fetch('/api/permission', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ askId, decision: btn.dataset.answer === 'allow' ? 'allow' : 'deny' }),
    });
  }, true);                        // capture phase

  /* -- the ops bar: assign work, run the manager -- */
  const css = document.createElement('style');
  css.textContent = `
    .ops{display:grid;grid-template-columns:1fr 1.25fr;gap:10px;
      background:var(--cabinet);border:1px solid var(--line-soft);padding:12px 14px}
    .ops h3{margin:0 0 8px;font-family:"Silkscreen",monospace;font-size:9.5px;
      letter-spacing:.09em;color:var(--ink-faint);font-weight:400}
    .ops textarea{width:100%;min-height:58px;resize:vertical;background:var(--panel);
      color:var(--ink);border:1px solid var(--line);padding:8px 9px;
      font-family:"IBM Plex Mono",monospace;font-size:11.5px;line-height:1.45}
    .ops textarea:focus-visible{outline:2px solid var(--marigold);outline-offset:1px}
    .ops .row{display:flex;gap:6px;align-items:center;margin-top:7px;flex-wrap:wrap}
    .ops select{background:var(--panel);color:var(--ink);border:1px solid var(--line);
      padding:6px 8px;font-family:"IBM Plex Mono",monospace;font-size:11px}
    .ops .note{font-family:"IBM Plex Mono",monospace;font-size:10.5px;color:var(--ink-faint)}
    .plan{margin-top:9px;display:flex;flex-direction:column;gap:4px;
      max-height:190px;overflow-y:auto}
    .plan .st{display:grid;grid-template-columns:auto 1fr;gap:8px;align-items:start;
      padding:7px 8px;background:var(--panel);border:1px solid var(--line-soft)}
    .plan .st select{padding:3px 5px;font-size:10px}
    .plan .st b{display:block;font-family:"IBM Plex Mono",monospace;font-size:11.5px;
      font-weight:500;color:var(--ink)}
    .plan .st span{font-family:"IBM Plex Sans",sans-serif;font-size:11px;color:var(--ink-dim)}
    @media (max-width:1000px){.ops{grid-template-columns:1fr}}
  `;
  document.head.appendChild(css);

  const ops = document.createElement('section');
  ops.className = 'ops';
  ops.innerHTML = `
    <div>
      <h3>ASSIGN TO ONE DESK</h3>
      <textarea id="taskText" placeholder="Add retry-with-backoff to the webhook sender in api/src/hooks/send.ts, and a unit test for the backoff schedule."></textarea>
      <div class="row">
        <select id="taskDesk" aria-label="Which desk"></select>
        <button class="btn accent" id="taskGo">Assign</button>
        <span class="note" id="taskNote"></span>
      </div>
    </div>
    <div>
      <h3>GIVE THE MANAGER A PROJECT</h3>
      <textarea id="goalText" placeholder="Get the repo ready for the v3 release: audit deps, fix the failing e2e specs, refresh the README, and tighten error handling in the API."></textarea>
      <div class="row">
        <button class="btn accent" id="planGo">Plan it</button>
        <button class="btn" id="dispatchGo" disabled>Dispatch all</button>
        <span class="note" id="planNote">the manager only reads — nothing runs until you dispatch</span>
      </div>
      <div class="plan" id="planOut"></div>
    </div>`;
  document.querySelector('.app').insertBefore(ops, document.querySelector('.ticker'));

  const $$ = id => document.getElementById(id);

  function deskOptions(selectedIndex) {
    return DESKS.map((_, i) => {
      const a = byDesk.get(i);
      const label = a ? `${a.name} — ${a.act === 'done' || a.act === 'idle' ? 'free' : a.act}` : `desk ${i + 1} — empty`;
      return `<option value="${i}"${i === selectedIndex ? ' selected' : ''}>${esc(label)}</option>`;
    }).join('');
  }
  function renderDeskPicker() {
    const sel = $$('taskDesk');
    if (!sel) return;
    const keep = sel.value;
    sel.innerHTML = deskOptions(Number(keep || 0));
    for (const s of document.querySelectorAll('.plan .st select')) {
      const k = s.value; s.innerHTML = deskOptions(Number(k)); s.value = k;
    }
  }
  renderDeskPicker();

  $$('taskGo').addEventListener('click', async () => {
    const task = $$('taskText').value.trim();
    if (!task) return;
    const desk = Number($$('taskDesk').value);
    $$('taskNote').textContent = 'sending…';
    const r = await fetch('/api/assign', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ desk, task }),
    }).then(r => r.json()).catch(e => ({ error: e.message }));
    $$('taskNote').textContent = r.error ? `✗ ${r.error}`
      : r.queued ? `queued (#${r.position} in line)` : 'on the floor';
    if (!r.error) $$('taskText').value = '';
  });

  $$('planGo').addEventListener('click', async () => {
    const goal = $$('goalText').value.trim();
    if (!goal) return;
    $$('planGo').disabled = true;
    $$('planNote').textContent = `${LIVE.managerModel || 'manager'} is reading the repo…`;
    $$('planOut').innerHTML = '';
    const r = await fetch('/api/plan', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal }),
    }).then(r => r.json()).catch(e => ({ error: e.message }));
    $$('planGo').disabled = false;
    if (r.error) { $$('planNote').textContent = `✗ ${r.error}`; return; }
    showPlan(r.plan);
  });

  function showPlan(plan) {
    LIVE.plan = plan;
    $$('planNote').textContent = plan.summary || '';
    $$('planOut').innerHTML = plan.subtasks.map((s, n) => `
      <div class="st">
        <select data-sub="${n}">${deskOptions(n % DESKS.length)}</select>
        <div>
          <b>${esc(s.title)}</b>
          <span>${esc(s.brief)}</span>
          ${s.files?.length ? `<span style="color:var(--ink-faint)">${esc(s.files.join(', '))}</span>` : ''}
        </div>
      </div>`).join('');
    $$('dispatchGo').disabled = false;
  }

  function onManager(msg) {
    if (!$$('planNote')) return;
    if (msg.status === 'planning') $$('planNote').textContent = 'manager is reading the repo…';
    if (msg.status === 'dispatched') $$('planNote').textContent = `dispatched ${msg.count} subtasks`;
  }

  $$('dispatchGo').addEventListener('click', async () => {
    if (!LIVE.plan) return;
    const assignments = LIVE.plan.subtasks.map((s, n) => ({
      desk: Number(document.querySelector(`.plan .st select[data-sub="${n}"]`).value),
      task: `${s.title}\n\n${s.brief}${s.files?.length ? `\n\nFiles in scope: ${s.files.join(', ')}` : ''}\n\nOther agents are working in this repo at the same time. Stay inside the files listed above.`,
    }));
    $$('dispatchGo').disabled = true;
    await fetch('/api/dispatch', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assignments }),
    });
    $$('planOut').innerHTML = '';
    LIVE.plan = null;
  });

  /* Keep the desk picker honest as statuses change. */
  setInterval(renderDeskPicker, 2500);

  /* The simulator normally advances the monitor flicker inside step(), which is
     switched off here, so keep the screens alive for anyone actually working. */
  setInterval(() => {
    for (const a of agents) {
      if (a.act !== 'idle' && a.act !== 'done' && a.act !== 'waiting') {
        a.screenJitter = (a.screenJitter + 3) % 100;
      }
    }
  }, 120);

  console.log('[bullpen] live mode: simulator off, driving from real sessions');
})();
