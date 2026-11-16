#!/usr/bin/env node
// Owns all Claude Code session state and is Atoll's only client; claude-notch-hook.sh POSTs every
// hook event here. See README.md.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = 9021;
const RPC_URL = 'ws://127.0.0.1:9020';
const BUNDLE_ID = 'com.anthropic.claude-code';
const WORKING_ID = 'claude-code-working';
// Attention and done get their own ids so each new appearance triggers Atoll's sneak peek.
const ATTENTION_ID = 'claude-code-attention';
const DONE_ID = 'claude-code-done';
const TAB_ID = 'claude-code-sessions';
const REVEAL_AFTER_MS = 10_000;
const DONE_VISIBLE_MS = 4000;
const IDLE_EXIT_MS = 10 * 60 * 1000;
const STALE_MS = 2 * 60 * 60 * 1000;
const SUMMARY_MAX_CHARS = 90;
const DONE_SOUND = '/System/Library/Sounds/Glass.aiff';
const ATTENTION_SOUND = '/System/Library/Sounds/Purr.aiff';
// Atoll decodes Date as seconds since 2001-01-01.
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
// Any local web page can reach 127.0.0.1, so the tab's requests must carry this per-run token.
const TOKEN = crypto.randomBytes(16).toString('hex');

const CLAUDE_ORANGE = { red: 0.851, green: 0.467, blue: 0.341, alpha: 1 };
const DONE_GREEN = { red: 0.2, green: 0.78, blue: 0.35, alpha: 1 };
const ALERT_RED = { red: 0.898, green: 0.282, blue: 0.302, alpha: 1 };

const ACTION_FILES = {
  walk: 'claude-working.json',
  edit: 'claude-typing.json',
  read: 'claude-reading.json',
  bash: 'claude-bash.json',
  web: 'claude-web.json',
};
// Answered in the terminal: a PermissionRequest allow for these needs answers we cannot build.
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

const DIR = path.dirname(fileURLToPath(import.meta.url));
const animations = Object.fromEntries(
  [...Object.values(ACTION_FILES), 'claude-attention.json', 'claude-done.json'].map((file) => [
    file,
    fs.readFileSync(path.join(DIR, file)).toString('base64'),
  ]),
);

function actionFor(toolName = '') {
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(toolName)) return 'edit';
  if (/^(Read|Grep|Glob|LS)$/.test(toolName)) return 'read';
  if (toolName === 'Bash') return 'bash';
  if (/^Web(Fetch|Search)$/.test(toolName) || /^mcp__.*(browser|playwright|chrome)/i.test(toolName)) return 'web';
  return 'walk';
}

function summarize(message = '') {
  const line = message
    .split('\n')
    .map((text) =>
      text
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_`#>]/g, '')
        .replace(/^\s*([-+]|\d+\.)\s+/, '')
        .trim(),
    )
    .find(Boolean);
  if (!line) return '';
  return line.length > SUMMARY_MAX_CHARS ? `${line.slice(0, SUMMARY_MAX_CHARS - 1)}…` : line;
}

function describePermission({ tool_name: tool, tool_input: input = {} }) {
  const detail = input.command ?? input.file_path ?? input.url ?? input.pattern ?? '';
  return summarize(detail ? `${tool}: ${detail}` : tool);
}

// The terminal or IDE that owns a session (first .app up the parent-process chain), its tty, and
// the claude pid (hooks run without a tty, so the nearest ancestor with one).
function processInfo(startPid) {
  const found = {};
  try {
    const rows = new Map(
      execFileSync('ps', ['-axo', 'pid=,ppid=,tty=,comm='], { encoding: 'utf8' })
        .split('\n')
        .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/))
        .filter(Boolean)
        .map(([, pid, ppid, tty, comm]) => [pid, { ppid, tty, comm }]),
    );
    for (let pid = String(startPid); rows.has(pid) && !found.owner; pid = rows.get(pid).ppid) {
      const { tty, comm } = rows.get(pid);
      if (!found.tty && tty !== '??') Object.assign(found, { tty: `/dev/${tty}`, pid: Number(pid) });
      found.owner = comm.match(/^(.*?\.app)\//)?.[1];
    }
  } catch {}
  return found;
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function frontmostApp() {
  try {
    const asn = execFileSync('lsappinfo', ['front'], { encoding: 'utf8' }).trim();
    return execFileSync('lsappinfo', ['info', '-only', 'bundlepath', asn], { encoding: 'utf8' }).match(/="(.*)"/)?.[1];
  } catch {
    return undefined;
  }
}

// Sound only when the user is looking at another app; unknown owner (e.g. tmux server) always plays.
function chime(session, sound) {
  if (!session.owner || frontmostApp() !== session.owner) {
    spawn('afplay', [sound], { detached: true, stdio: 'ignore' }).unref();
  }
}

const sessions = new Map();
let nextPermissionID = 0;

function sessionFor(event, ppid) {
  const id = String(event.session_id || 'unknown');
  let session = sessions.get(id);
  if (!session) {
    // A session first seen mid-turn (daemon restarted) is shown right away.
    session = { id, status: 'idle', action: 'walk', tasks: { total: 0, completed: [] }, revealed: true, permissions: [] };
    session.turnStart = Date.now();
    Object.assign(session, processInfo(ppid));
    sessions.set(id, session);
  }
  if (event.cwd) session.cwd = event.cwd;
  session.seenAt = Date.now();
  return session;
}

const project = (session) => path.basename(session.cwd || '') || 'Claude Code';

function needsYou(session, reason) {
  if (session.status !== 'attention') {
    session.attentionAt = Date.now();
    chime(session, ATTENTION_SOUND);
  }
  Object.assign(session, { status: 'attention', revealed: true, reason });
}

// Back to work once nothing waits on the user. The hook of a prompt answered in the terminal keeps
// waiting (Claude Code does not cancel it), so its entry is dropped here and answered with nothing.
function settle(session, finishedInput) {
  if (finishedInput !== undefined) {
    const key = JSON.stringify(finishedInput);
    for (const entry of session.permissions.filter((p) => JSON.stringify(p.input) === key)) resolvePermission(session, entry);
  }
  if (session.permissions.length === 0 && session.status === 'attention') session.status = 'working';
}

function resolvePermission(session, entry, decision) {
  session.permissions = session.permissions.filter((p) => p !== entry);
  if (entry.res.writableEnded) return;
  if (!decision) return entry.res.writeHead(204).end();
  entry.res.writeHead(200, { 'Content-Type': 'application/json' });
  entry.res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }));
}

function clearPermissions(session) {
  for (const entry of session.permissions) resolvePermission(session, entry);
}

function goIdle(session) {
  clearPermissions(session);
  if (session.status !== 'done') session.status = 'idle';
}

function trackTasks(session, toolName, toolInput = {}) {
  const tasks = session.tasks;
  if (toolName === 'TodoWrite' && Array.isArray(toolInput.todos)) {
    tasks.total = toolInput.todos.length;
    tasks.completed = toolInput.todos.flatMap((todo, index) => (todo.status === 'completed' ? [String(index)] : []));
  } else if (toolName === 'TaskCreate') {
    tasks.total += 1;
  } else if (toolName === 'TaskUpdate' && toolInput.taskId !== undefined) {
    const id = String(toolInput.taskId);
    if (toolInput.status === 'completed' && !tasks.completed.includes(id)) tasks.completed.push(id);
    if (toolInput.status === 'deleted') {
      tasks.total = Math.max(tasks.total - 1, 0);
      tasks.completed = tasks.completed.filter((done) => done !== id);
    }
  }
}

// Returns true when the HTTP response is held for later (a PermissionRequest waiting for a click).
function handle(event, ppid, res) {
  const session = sessionFor(event, ppid);
  switch (event.hook_event_name) {
    case 'UserPromptSubmit': {
      // A turn still on screen (interrupted, or waiting on the user) stays visible.
      const shown = session.revealed && (session.status === 'working' || session.status === 'attention');
      if (!isAlive(session.pid)) Object.assign(session, processInfo(ppid));
      clearPermissions(session);
      const turnStart = Date.now();
      Object.assign(session, { status: 'working', action: 'walk', background: 0, turnStart, revealed: shown });
      if (!shown) {
        setTimeout(() => {
          if (session.status === 'working' && session.turnStart === turnStart && !session.revealed) {
            session.revealed = true;
            render();
          }
        }, REVEAL_AFTER_MS);
      }
      break;
    }
    case 'PreToolUse':
      session.background = 0;
      if (QUESTION_TOOLS.has(event.tool_name)) {
        needsYou(session, 'question');
        break;
      }
      session.action = actionFor(event.tool_name);
      if (session.status !== 'attention') session.status = 'working';
      break;
    case 'PermissionRequest': {
      if (QUESTION_TOOLS.has(event.tool_name)) break;
      const entry = { id: ++nextPermissionID, input: event.tool_input, detail: describePermission(event), res };
      session.permissions.push(entry);
      // The hook gave up (timeout) or the daemon answered: either way the entry is done.
      res.on('close', () => {
        if (!session.permissions.includes(entry)) return;
        session.permissions = session.permissions.filter((p) => p !== entry);
        settle(session);
        render();
      });
      needsYou(session, 'permission');
      render();
      return true;
    }
    case 'Notification':
      // Fires about six seconds after a prompt appears; PermissionRequest usually got there first.
      if (/^(permission_prompt|elicitation_dialog)$/.test(event.notification_type ?? '') && session.status !== 'attention') {
        needsYou(session, 'permission');
        session.notice = event.message ?? '';
      }
      // Esc and a "No" in the terminal end the turn without Stop; this arrives a minute later.
      if (event.notification_type === 'idle_prompt') goIdle(session);
      break;
    case 'StopFailure':
      goIdle(session);
      break;
    case 'PostToolUse':
    case 'PostToolUseFailure':
      if (event.hook_event_name === 'PostToolUse') trackTasks(session, event.tool_name, event.tool_input);
      settle(session, event.tool_input);
      break;
    case 'Stop': {
      // Stop fires when the turn ends even if background agents/commands still run; Claude Code
      // re-runs the turn (and Stop) when each one finishes. Monitors are long-lived watchers, not work.
      const background = (event.background_tasks ?? []).filter((task) => !/monitor/i.test(task.type ?? ''));
      clearPermissions(session);
      session.action = 'walk';
      if (background.length > 0) {
        Object.assign(session, { status: 'working', background: background.length });
        break;
      }
      Object.assign(session, { status: 'done', background: 0, summary: summarize(event.last_assistant_message) });
      if (session.tasks.completed.length >= session.tasks.total) session.tasks = { total: 0, completed: [] };
      // Turns shorter than REVEAL_AFTER_MS never appeared, so they finish silently too.
      if (session.revealed) {
        session.doneAt = Date.now();
        chime(session, DONE_SOUND);
        setTimeout(render, DONE_VISIBLE_MS + 50);
      }
      break;
    }
    case 'SessionEnd':
      clearPermissions(session);
      sessions.delete(session.id);
      break;
  }
  render();
  return false;
}

function activity({ id, file, accent, project: subtitle, trailing, progress, sneakPeek }) {
  const base = {
    id,
    bundleIdentifier: BUNDLE_ID,
    priority: id === ATTENTION_ID ? 'high' : 'normal',
    title: 'Claude',
    subtitle,
    leadingIcon: { type: 'lottie', animationData: animations[file], size: [30, 30] },
    accentColor: accent,
    allowsMusicCoexistence: true,
    sneakPeekConfig: sneakPeek
      ? { enabled: true, showOnUpdate: false, duration: 4, style: 'standard' }
      : { enabled: false, showOnUpdate: false },
    ...(sneakPeek && { sneakPeekTitle: sneakPeek.title, sneakPeekSubtitle: sneakPeek.subtitle }),
  };
  // Atoll cannot show a progress ring and trailing content together.
  return progress === undefined
    ? { ...base, trailingContent: trailing }
    : { ...base, progressIndicator: { type: 'ring', diameter: 18, strokeWidth: 3, color: accent }, progress };
}

// Oldest first, so the notch does not hop between sessions as their events interleave.
const first = (list, key) => list.sort((a, b) => a[key] - b[key])[0];

// The one activity the closed notch should show, plus a key that changes when its sneak peek
// should appear again.
function desiredActivity() {
  const all = [...sessions.values()];
  const waiting = first(
    all.filter((s) => s.status === 'attention'),
    'attentionAt',
  );
  if (waiting) {
    const permission = waiting.permissions[0];
    const question = waiting.reason === 'question';
    const title = question ? 'Claude bertanya' : 'Claude butuh izin';
    const subtitle = question
      ? 'Jawab di terminal untuk melanjutkan'
      : (permission?.detail ?? waiting.notice ?? '');
    return {
      peekKey: `${waiting.id}:${waiting.attentionAt}:${permission?.id ?? ''}`,
      descriptor: activity({
        id: ATTENTION_ID,
        file: 'claude-attention.json',
        accent: ALERT_RED,
        project: project(waiting),
        trailing: { type: 'text', text: question ? 'Butuh jawaban' : 'Butuh izin' },
        sneakPeek: { title: `${title} · ${project(waiting)}`, subtitle },
      }),
    };
  }
  const working = first(
    all.filter((s) => s.status === 'working' && s.revealed),
    'turnStart',
  );
  if (working) {
    const { tasks } = working;
    return {
      peekKey: '',
      descriptor: activity({
        id: WORKING_ID,
        file: ACTION_FILES[working.action] ?? ACTION_FILES.walk,
        accent: CLAUDE_ORANGE,
        project: project(working),
        trailing: working.background
          ? { type: 'text', text: `Background (${working.background})` }
          : { type: 'countdownText', targetDate: (working.turnStart - APPLE_EPOCH_MS) / 1000 },
        progress: tasks.total > 0 ? Math.min(tasks.completed.length / tasks.total, 1) : undefined,
      }),
    };
  }
  const done = all
    .filter((s) => s.status === 'done' && Date.now() - (s.doneAt ?? 0) < DONE_VISIBLE_MS)
    .sort((a, b) => b.doneAt - a.doneAt)[0];
  if (done) {
    return {
      peekKey: String(done.doneAt),
      descriptor: activity({
        id: DONE_ID,
        file: 'claude-done.json',
        accent: DONE_GREEN,
        project: project(done),
        trailing: { type: 'text', text: 'Selesai' },
        sneakPeek: { title: `Selesai · ${project(done)}`, subtitle: done.summary },
      }),
    };
  }
  return undefined;
}

// What Atoll currently shows, so only real changes are sent.
let presented = new Map();

async function syncActivities() {
  const desired = desiredActivity();
  if (desired) {
    const { id } = desired.descriptor;
    const json = JSON.stringify(desired.descriptor);
    const previous = presented.get(id);
    if (previous?.json !== json) {
      // Re-presenting the same id does not replay the sneak peek; a fresh present does.
      if (previous && previous.peekKey !== desired.peekKey) {
        await call('atoll.dismissLiveActivity', { bundleIdentifier: BUNDLE_ID, activityID: id });
      }
      await call('atoll.presentLiveActivity', { bundleIdentifier: BUNDLE_ID, descriptor: desired.descriptor });
      presented.set(id, { json, peekKey: desired.peekKey });
    }
  }
  for (const id of presented.keys()) {
    if (id === desired?.descriptor.id) continue;
    await call('atoll.dismissLiveActivity', { bundleIdentifier: BUNDLE_ID, activityID: id });
    presented.delete(id);
  }
}

let syncing = Promise.resolve();
function render() {
  syncing = syncing.then(syncActivities).catch((error) => console.error(error));
}

const STATUS_ORDER = { attention: 0, working: 1, done: 2, idle: 3 };

function tabRows() {
  return [...sessions.values()]
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (b.turnStart ?? 0) - (a.turnStart ?? 0))
    .slice(0, 6)
    .map((s) => ({
      id: s.id,
      project: project(s),
      app: path.basename(s.owner || '', '.app'),
      status: s.status,
      action: s.action,
      turnStart: s.turnStart,
      tasks: s.tasks.total ? `${s.tasks.completed.length}/${s.tasks.total}` : '',
      summary: s.summary || '',
      question: s.reason === 'question',
      permission: s.permissions[0] && {
        id: s.permissions[0].id,
        detail: s.permissions[0].detail,
        more: s.permissions.length - 1,
      },
    }));
}

const TERMINAL_SELECT_TAB = `on run argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is item 1 of argv then
          set selected tab of w to t
          set index of w to 1
        end if
      end repeat
    end repeat
    activate
  end tell
end run`;

function focus(session) {
  const { owner, tty, cwd } = session;
  if (!owner) return;
  if (owner.endsWith('/Terminal.app') && tty) {
    execFile('osascript', ['-e', TERMINAL_SELECT_TAB, tty]);
  } else if (/(Visual Studio Code|Cursor|Windsurf|VSCodium)[^/]*\.app$/.test(owner) && cwd) {
    // VS Code-style editors bring the window that has this folder open to the front.
    execFile('open', ['-a', owner, cwd]);
  } else {
    execFile('open', ['-a', owner]);
  }
}

const PAGE = `<!doctype html><meta charset="utf-8"><style>
:root{color-scheme:dark}
body{margin:0;font:12px -apple-system,system-ui;color:#fff;background:transparent;-webkit-user-select:none;cursor:default}
.row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px}
.row:hover{background:rgba(255,255,255,.08)}
.dot{width:8px;height:8px;border-radius:50%;flex:none}
.working .dot{background:#d97757}.attention .dot{background:#e5484d}.done .dot{background:#33c759}.idle .dot{background:#666}
.main{flex:1;min-width:0}
.name{font-weight:600}
.sub{color:rgba(255,255,255,.55);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.side{color:rgba(255,255,255,.55);font-variant-numeric:tabular-nums;flex:none}
button{font:600 11px -apple-system,system-ui;border:0;border-radius:6px;padding:4px 10px;color:#fff;flex:none}
.allow{background:#33c759}.deny{background:rgba(255,255,255,.15)}
.empty{color:rgba(255,255,255,.45);padding:24px;text-align:center}
</style><div id="list"></div><script>
const BASE='http://127.0.0.1:${PORT}', TOKEN='${TOKEN}';
const ACTION={walk:'Working…',edit:'Editing…',read:'Reading…',bash:'Running…',web:'Browsing…'};
const pad=(n)=>String(n).padStart(2,'0');
function elapsed(ms){const s=Math.max(0,Math.floor((Date.now()-ms)/1000));const h=Math.floor(s/3600);return (h?h+':'+pad(Math.floor(s/60)%60):Math.floor(s/60))+':'+pad(s%60);}
function el(tag,cls,text){const e=document.createElement(tag);e.className=cls;if(text)e.textContent=text;return e;}
const post=(p,q)=>fetch(BASE+p+'?token='+TOKEN+'&'+new URLSearchParams(q),{method:'POST'});
function statusText(s){
  if(s.permission)return s.permission.detail+(s.permission.more?' (+'+s.permission.more+')':'');
  if(s.status==='attention')return s.question?'Claude bertanya, jawab di terminal':'Menunggu kamu';
  if(s.status==='done')return s.summary||'Selesai';
  if(s.status==='idle')return 'Menunggu prompt';
  return (ACTION[s.action]||'Working…')+(s.tasks?' · '+s.tasks:'');
}
function render(sessions){
  const list=document.getElementById('list');list.replaceChildren();
  if(!sessions.length){list.append(el('div','empty','Tidak ada sesi Claude Code'));return;}
  for(const s of sessions){
    const row=el('div','row '+s.status);
    const main=el('div','main');
    main.append(el('div','name',s.project),el('div','sub',statusText(s)));
    row.append(el('div','dot'),main);
    if(s.permission){
      for(const [label,cls,behavior] of [['Tolak','deny','deny'],['Izinkan','allow','allow']]){
        const b=el('button',cls,label);
        b.onclick=(e)=>{e.stopPropagation();post('/decide',{session:s.id,permission:s.permission.id,behavior});};
        row.append(b);
      }
    }else{
      const side=el('div','side',s.status==='working'?'':s.app);
      if(s.status==='working')side.dataset.start=s.turnStart;
      row.append(side);
    }
    row.title=s.app?'Buka di '+s.app:'';
    row.onclick=()=>post('/focus',{session:s.id});
    list.append(row);
  }
}
// Rebuild rows only when sessions change; timers tick in place so hover is not lost every second.
let last='';
async function poll(){
  try{const text=await (await fetch(BASE+'/sessions?token='+TOKEN)).text();if(text!==last){last=text;render(JSON.parse(text));}}catch{}
  for(const e of document.querySelectorAll('[data-start]'))e.textContent=elapsed(Number(e.dataset.start));
  setTimeout(poll,1000);
}
poll();
</script>`;

const tab = {
  id: TAB_ID,
  bundleIdentifier: BUNDLE_ID,
  priority: 'normal',
  accentColor: CLAUDE_ORANGE,
  metadata: {},
  tab: {
    title: 'Claude',
    iconSymbolName: 'sparkle',
    preferredHeight: 190,
    sections: [],
    allowWebInteraction: true,
    webContent: { html: PAGE, preferredHeight: 180, isTransparent: true, allowLocalhostRequests: true },
  },
};

// One persistent connection, calls sent one at a time (authorization must land before present).
// Reconnects when Atoll restarts and presents everything again.
let socket;
let nextCallID = 0;
const pending = new Map();

function call(method, params) {
  return new Promise((resolve) => {
    if (socket?.readyState !== WebSocket.OPEN) return resolve();
    const id = String(++nextCallID);
    pending.set(id, resolve);
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

function connect() {
  socket = new WebSocket(RPC_URL);
  socket.onopen = async () => {
    presented = new Map();
    await call('atoll.requestAuthorization', { bundleIdentifier: BUNDLE_ID });
    await call('atoll.presentNotchExperience', { bundleIdentifier: BUNDLE_ID, descriptor: tab });
    render();
  };
  socket.onmessage = (event) => {
    const reply = JSON.parse(event.data);
    if (reply.error) console.error(`atoll: ${reply.error.message}`);
    // Atoll also pushes notifications without an id, such as atoll.activityDidDismiss.
    pending.get(reply.id)?.();
    pending.delete(reply.id);
  };
  socket.onclose = () => {
    for (const resolve of pending.values()) resolve();
    pending.clear();
    setTimeout(connect, 3000);
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const query = Object.fromEntries(url.searchParams);
  // Hook events come from curl. Requiring a JSON content type makes browsers send a CORS preflight,
  // which is refused, so web pages cannot inject events.
  if (url.pathname === '/hook' && req.method === 'POST') {
    if (!req.headers['content-type']?.startsWith('application/json')) return res.writeHead(415).end();
    try {
      if (handle(JSON.parse(await readBody(req)), Number(query.ppid), res)) return;
    } catch (error) {
      console.error(error);
    }
    if (!res.writableEnded) res.writeHead(204).end();
    return;
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (query.token !== TOKEN) return res.writeHead(403).end();
  const session = sessions.get(query.session ?? '');
  if (url.pathname === '/sessions') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(tabRows()));
  }
  if (url.pathname === '/focus' && req.method === 'POST' && session) {
    focus(session);
    return res.writeHead(204).end();
  }
  if (url.pathname === '/decide' && req.method === 'POST' && session) {
    const entry = session.permissions.find((p) => String(p.id) === query.permission);
    if (!entry) return res.writeHead(409).end();
    resolvePermission(
      session,
      entry,
      query.behavior === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Ditolak dari notch Atoll.' },
    );
    settle(session);
    render();
    return res.writeHead(204).end();
  }
  res.writeHead(404).end();
});
// The port doubles as a single-instance lock: a second daemon fails here and exits.
server.on('error', () => process.exit(0));
server.listen(PORT, '127.0.0.1', connect);

// Sessions that ended without SessionEnd (crash, closed terminal) drop out here; with none left
// for a while the daemon exits, and the next hook event starts it again.
let idleSince = Date.now();
setInterval(async () => {
  for (const session of sessions.values()) {
    // Without a pid (no tty up the process chain) liveness is unknown, so fall back to silence.
    const gone = session.pid ? !isAlive(session.pid) : Date.now() - session.seenAt > STALE_MS;
    if (gone) {
      clearPermissions(session);
      sessions.delete(session.id);
      render();
    }
  }
  if (sessions.size > 0) idleSince = Date.now();
  if (Date.now() - idleSince < IDLE_EXIT_MS) return;
  await syncing;
  await call('atoll.dismissNotchExperience', { bundleIdentifier: BUNDLE_ID, experienceID: TAB_ID });
  process.exit(0);
}, 60_000);
