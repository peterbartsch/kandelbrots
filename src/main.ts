import './style.css';

// Kandelbrot — Step 2 + focus & Arrange mode.
//
// New since the recursive render:
//  - FOCUS follows your zoom — the deepest card whose board fills the screen is
//    "the focus", and gets a highlight ring so you always know where you are.
//  - A NAVIGATE / ARRANGE mode toggle. Navigate is free pan+zoom. Arrange locks
//    the focus, dims everything else, disables zoom (so you can't fly off by
//    accident), and lets you drag the focused board's cards between columns and
//    reorder them. This is a first taste of step 7's drag-and-drop, scoped to
//    rearranging within the one board you're focused on.

type Status = 'todo' | 'doing' | 'done';
const COLUMNS: Status[] = ['todo', 'doing', 'done'];
const COLUMN_LABEL: Record<Status, string> = { todo: 'To-do', doing: 'Doing', done: 'Done' };
// Tron palette: electric blue (idle) → amber (energized) → teal (resolved),
// all glowing cyan on a black grid.
const STATUS_COLOR: Record<Status, string> = {
  todo: 'rgb(58,150,255)',
  doing: 'rgb(255,174,52)',
  done: 'rgb(47,240,200)',
};
const CYAN_RGB: [number, number, number] = [44, 224, 255]; // primary neon
const CYAN_CORE = 'rgba(154,246,255,1)'; // bright filament
const GRID_RGB: [number, number, number] = [44, 224, 255];

interface Node {
  title: string;
  status: Status; // manual status — authoritative for leaves and pinned cards
  children: Node[];
  pinned?: boolean; // a parent overridden away from its derived status
}
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Placed {
  node: Node;
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Column {
  status: Status;
  colX: number;
  colW: number;
  top: number;
  height: number;
  headerH: number;
  innerX: number;
  innerY: number;
  innerW: number;
  innerH: number;
}
type Mode = 'navigate' | 'arrange';

// --- Derived status ---------------------------------------------------------
// A card's *effective* status rolls up from its leaves: all children done → done,
// all to-do → to-do, anything mixed/in-progress → doing. Leaves and pinned cards
// use their own manual status instead. Memoised per frame (cleared in frame())
// because otherwise the root would re-walk the entire tree on every draw.
const effCache = new Map<Node, Status>();
function effectiveStatus(n: Node): Status {
  const hit = effCache.get(n);
  if (hit) return hit;
  let s: Status;
  if (n.children.length === 0 || n.pinned) {
    s = n.status;
  } else {
    let allDone = true;
    let allTodo = true;
    for (const k of n.children) {
      const cs = effectiveStatus(k);
      if (cs !== 'done') allDone = false;
      if (cs !== 'todo') allTodo = false;
    }
    s = allDone ? 'done' : allTodo ? 'todo' : 'doing';
  }
  effCache.set(n, s);
  return s;
}

// --- Seed tree (placeholder content) ---------------------------------------
const TITLES = [
  'Landing page', 'Auth flow', 'Billing', 'Onboarding', 'Search', 'Settings',
  'Dashboard', 'Notifications', 'Mobile layout', 'Dark mode', 'Analytics',
  'Export', 'Import', 'Webhooks', 'Rate limiting', 'Caching', 'Migrations',
  'Docs', 'Changelog', 'Pricing', 'Support inbox', 'Bug triage', 'Refactor',
  'Test coverage', 'CI pipeline', 'Deploy', 'Backups', 'Monitoring', 'Theming',
];
let titleCursor = 0;
const nextTitle = (): string => TITLES[titleCursor++ % TITLES.length];
const randStatus = (): Status => {
  const r = Math.random();
  return r < 0.45 ? 'todo' : r < 0.75 ? 'doing' : 'done';
};
function makeTree(depth: number, fanout: number): Node[] {
  if (depth <= 0) return [];
  const n = 1 + Math.floor(Math.random() * fanout);
  const out: Node[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      title: nextTitle(),
      status: randStatus(),
      children: Math.random() < 0.85 ? makeTree(depth - 1, Math.max(2, fanout - 1)) : [],
    });
  }
  return out;
}
// --- Persistence ------------------------------------------------------------
// The board lives in localStorage: seeded once, reloaded on startup, re-saved
// after every change. (To start fresh: localStorage.removeItem the key below.)
const STORAGE_KEY = 'kandelbrot.v1';

function freshTree(): Node {
  return { title: 'Kandelbrot', status: 'doing', children: makeTree(4, 6) };
}

function loadTree(): Node | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as Node;
    if (data && typeof data.title === 'string' && Array.isArray(data.children)) return data;
  } catch {
    /* corrupt or unavailable — fall through to a fresh tree */
  }
  return null;
}

function saveTree(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(root));
  } catch {
    /* ignore quota / private-mode write errors */
  }
}

let root: Node = loadTree() ?? freshTree();
saveTree(); // persist the initial seed so the board is stable across reloads

// --- Canvas + camera --------------------------------------------------------
const canvas = document.getElementById('stage') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const hud = document.getElementById('hud')!;
const btn = document.getElementById('mode-toggle') as HTMLButtonElement;
const treeEl = document.getElementById('tree')!;
const piTitle = document.getElementById('pi-title')!;
const piStatus = document.getElementById('pi-status')!;
const segTodo = document.querySelector('#pi-bar .seg.todo') as HTMLElement;
const segDoing = document.querySelector('#pi-bar .seg.doing') as HTMLElement;
const segDone = document.querySelector('#pi-bar .seg.done') as HTMLElement;
const piMeta = document.getElementById('pi-meta')!;
const piPin = document.getElementById('pi-pin') as HTMLButtonElement;
const hint = document.getElementById('hint')!;
const openDirBtn = document.getElementById('open-dir-btn') as HTMLButtonElement;
const importBtn = document.getElementById('import-btn') as HTMLButtonElement;
const exportBtn = document.getElementById('export-btn') as HTMLButtonElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const renameInput = document.getElementById('rename-input') as HTMLInputElement;
const addCardBtn = document.getElementById('add-card') as HTMLButtonElement;

const cam = { x: 0, y: 0, zoom: 0.5 };
const MIN_ZOOM = 0.01;
const MAX_ZOOM = 1500;

let viewW = 0;
let viewH = 0;
let dpr = 1;
let framed = false;

const ROOT: Rect = { x: -1200, y: -750, w: 2400, h: 1500 };

function resize(): void {
  dpr = window.devicePixelRatio || 1;
  viewW = canvas.clientWidth;
  viewH = canvas.clientHeight;
  canvas.width = Math.round(viewW * dpr);
  canvas.height = Math.round(viewH * dpr);
  if (!framed && viewW > 0) {
    cam.zoom = Math.min(viewW / ROOT.w, viewH / ROOT.h) * 0.92;
    framed = true;
  }
}
window.addEventListener('resize', resize);

const toScreenX = (wx: number): number => (wx - cam.x) * cam.zoom + viewW / 2;
const toScreenY = (wy: number): number => (wy - cam.y) * cam.zoom + viewH / 2;
const toWorldX = (sx: number): number => (sx - viewW / 2) / cam.zoom + cam.x;
const toWorldY = (sy: number): number => (sy - viewH / 2) / cam.zoom + cam.y;

// --- Geometry (pure, in world coords) --------------------------------------
const BOARD_MIN = 128; // a card shows its inner board once it's this wide on screen
const FOCUS_FILL = 0.6; // a child must fill this fraction of the viewport width to take focus

const interior = (r: Rect): Rect => ({
  x: r.x + r.w * 0.05,
  y: r.y + r.h * 0.17,
  w: r.w * 0.9,
  h: r.h * 0.78,
});

function columns(b: Rect): Column[] {
  const gap = b.w * 0.04;
  const colW = (b.w - gap * 2) / 3;
  const headerH = b.h * 0.08;
  const padTop = b.h * 0.025;
  const padBottom = b.h * 0.025;
  return COLUMNS.map((status, c) => {
    const colX = b.x + c * (colW + gap);
    return {
      status,
      colX,
      colW,
      top: b.y,
      height: b.h,
      headerH,
      innerX: colX + colW * 0.1,
      innerY: b.y + headerH + padTop,
      innerW: colW * 0.8,
      innerH: b.h - headerH - padTop - padBottom,
    };
  });
}

function stack(kids: Node[], col: Column): Placed[] {
  if (kids.length === 0) return [];
  const cgap = col.innerH * 0.05;
  const idealH = col.innerW * 0.58;
  const fitH = (col.innerH - cgap * (kids.length - 1)) / kids.length;
  const h = Math.max(0, Math.min(idealH, fitH));
  return kids.map((node, i) => ({ node, x: col.innerX, y: col.innerY + i * (h + cgap), w: col.innerW, h }));
}

function layout(children: Node[], b: Rect): Placed[] {
  const out: Placed[] = [];
  for (const col of columns(b))
    out.push(...stack(children.filter((k) => effectiveStatus(k) === col.status), col));
  return out;
}

// --- Focus: the deepest open board under the screen centre ------------------
interface Focus extends Rect {
  node: Node;
}
// The chain of cards from the root down to wherever you're settled — used for
// both the focus (the last one) and the breadcrumb (all of them).
function focusPath(): Focus[] {
  const cx = toWorldX(viewW / 2);
  const cy = toWorldY(viewH / 2);
  const path: Focus[] = [{ node: root, x: ROOT.x, y: ROOT.y, w: ROOT.w, h: ROOT.h }];
  let f = path[0];
  while (f.node.children.length > 0) {
    const placed = layout(f.node.children, interior(f));
    const hit = placed.find((p) => cx >= p.x && cx <= p.x + p.w && cy >= p.y && cy <= p.y + p.h);
    if (!hit || hit.w * cam.zoom < viewW * FOCUS_FILL) break;
    f = { node: hit.node, x: hit.x, y: hit.y, w: hit.w, h: hit.h };
    path.push(f);
  }
  return path;
}

// --- Mode + drag state ------------------------------------------------------
let mode: Mode = 'navigate';
let frozenFocus: Focus | null = null;
let frozenPath: Focus[] | null = null;
let dirMode = false; // true once a live folder is connected

interface Drag {
  node: Node;
  w: number;
  h: number;
  px: number; // current pointer, world coords
  py: number;
}
let drag: Drag | null = null;
let panning = false;
let dragMoved = false;
let lastX = 0;
let lastY = 0;
// Multi-touch: track active pointers so two fingers can pinch-zoom.
const pointers = new Map<number, { x: number; y: number }>();
let pinchDist = 0;
let pinchMidX = 0;
let pinchMidY = 0;

// Snap-on-settle: zoom stays smooth, then eases to frame the nearest level at rest.
const SETTLE_MS = 150; // quiet time after the last wheel event before we snap
const SNAP_MS = 300; // snap animation length
let lastWheelAt = -1;
let wheelWX = 0;
let wheelWY = 0;
let pendingSnap = false;
let snap: { fx: number; fy: number; fz: number; tx: number; ty: number; tz: number; start: number } | null = null;

function setMode(m: Mode): void {
  mode = m;
  drag = null;
  snap = null;
  pendingSnap = false;
  if (m === 'arrange') {
    frozenPath = focusPath();
    frozenFocus = frozenPath[frozenPath.length - 1];
    canvas.style.cursor = 'default';
  } else {
    frozenPath = null;
    frozenFocus = null;
    canvas.style.cursor = 'grab';
  }
  btn.textContent = m === 'arrange' ? 'Arrange' : 'Navigate';
  btn.classList.toggle('on', m === 'arrange');
  hint.textContent =
    m === 'arrange'
      ? 'drag cards between columns · drag the background to pan · Tab or Esc to exit'
      : 'drag to pan · scroll/pinch zoom · double-click to rename · Tab to arrange';
}

// --- Pan / drag input -------------------------------------------------------
canvas.addEventListener('pointerdown', (e: PointerEvent) => {
  const rect = canvas.getBoundingClientRect();
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    /* synthetic pointer (testing) — capture not available */
  }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  snap = null;
  pendingSnap = false;

  if (pointers.size === 2) {
    // second finger down → start a pinch; abandon any pan / card-drag
    drag = null;
    panning = false;
    const [a, b] = [...pointers.values()];
    pinchDist = Math.hypot(b.x - a.x, b.y - a.y);
    pinchMidX = (a.x + b.x) / 2;
    pinchMidY = (a.y + b.y) / 2;
    return;
  }
  if (pointers.size > 2) return;

  lastX = e.clientX;
  lastY = e.clientY;
  if (mode === 'arrange' && frozenFocus) {
    const pwx = toWorldX(e.clientX - rect.left);
    const pwy = toWorldY(e.clientY - rect.top);
    const placed = layout(frozenFocus.node.children, interior(frozenFocus));
    const hit = placed.find((p) => pwx >= p.x && pwx <= p.x + p.w && pwy >= p.y && pwy <= p.y + p.h);
    if (hit) {
      drag = { node: hit.node, w: hit.w, h: hit.h, px: pwx, py: pwy };
      dragMoved = false;
      canvas.style.cursor = 'grabbing';
      return;
    }
  }
  panning = true;
  canvas.style.cursor = 'grabbing';
});

canvas.addEventListener('pointermove', (e: PointerEvent) => {
  const rect = canvas.getBoundingClientRect();
  const tracked = pointers.get(e.pointerId);
  if (tracked) {
    tracked.x = e.clientX;
    tracked.y = e.clientY;
  }

  if (pointers.size === 2) {
    // pinch: zoom by the change in finger distance, anchored at the midpoint,
    // and pan as the midpoint moves — the touch analogue of wheel-zoom + drag.
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    if (pinchDist > 0) {
      const wx = toWorldX(pinchMidX - rect.left);
      const wy = toWorldY(pinchMidY - rect.top);
      cam.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.zoom * (dist / pinchDist)));
      cam.x = wx - (midX - rect.left - viewW / 2) / cam.zoom;
      cam.y = wy - (midY - rect.top - viewH / 2) / cam.zoom;
      wheelWX = wx; // so settle-snap frames the level you pinched to
      wheelWY = wy;
      lastWheelAt = e.timeStamp;
      pendingSnap = true;
    }
    pinchDist = dist;
    pinchMidX = midX;
    pinchMidY = midY;
    return;
  }

  if (drag) {
    drag.px = toWorldX(e.clientX - rect.left);
    drag.py = toWorldY(e.clientY - rect.top);
    dragMoved = true;
    return;
  }
  if (panning) {
    cam.x -= (e.clientX - lastX) / cam.zoom;
    cam.y -= (e.clientY - lastY) / cam.zoom;
    lastX = e.clientX;
    lastY = e.clientY;
  }
});

function endPointer(e: PointerEvent): void {
  pointers.delete(e.pointerId);
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);

  if (pointers.size === 1) {
    // pinch → one finger left: resume panning from it, no jump
    pinchDist = 0;
    drag = null;
    const [only] = [...pointers.values()];
    lastX = only.x;
    lastY = only.y;
    panning = true;
    return;
  }
  if (pointers.size >= 2) return;

  if (drag) {
    if (dragMoved) commitDrag(); // a no-move "drag" is just a tap — don't pin/reorder
    drag = null;
  }
  panning = false;
  pinchDist = 0;
  canvas.style.cursor = mode === 'arrange' ? 'default' : 'grab';
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

// Drop target = which column + insertion index under the pointer.
function dropTarget(f: Focus, wx: number, wy: number): { status: Status; index: number } {
  const cols = columns(interior(f));
  let col = cols[0];
  let bestDist = Infinity;
  for (const c of cols) {
    if (wx >= c.colX && wx <= c.colX + c.colW) {
      col = c;
      break;
    }
    const d = Math.abs(wx - (c.colX + c.colW / 2));
    if (d < bestDist) {
      bestDist = d;
      col = c;
    }
  }
  const kids = f.node.children.filter((k) => effectiveStatus(k) === col.status && k !== drag?.node);
  const placed = stack(kids, col);
  let index = placed.length;
  for (let i = 0; i < placed.length; i++) {
    if (wy < placed[i].y + placed[i].h / 2) {
      index = i;
      break;
    }
  }
  return { status: col.status, index };
}

function commitDrag(): void {
  if (!drag || !frozenFocus) return;
  const f = frozenFocus;
  const b = interior(f);
  // Dropped outside the board → cancel, leave everything as it was.
  if (drag.px < b.x || drag.px > b.x + b.w || drag.py < b.y || drag.py > b.y + b.h) return;

  const { status, index } = dropTarget(f, drag.px, drag.py);
  const arr = f.node.children;
  const cur = arr.indexOf(drag.node);
  if (cur >= 0) arr.splice(cur, 1);
  drag.node.status = status;
  if (drag.node.children.length > 0) drag.node.pinned = true; // overriding a parent pins it

  const targetIdxs: number[] = [];
  arr.forEach((k, i) => {
    if (effectiveStatus(k) === status) targetIdxs.push(i);
  });
  const insertAt =
    index < targetIdxs.length
      ? targetIdxs[index]
      : targetIdxs.length > 0
        ? targetIdxs[targetIdxs.length - 1] + 1
        : arr.length;
  arr.splice(insertAt, 0, drag.node);
  persist();
  refreshPanel();
}

// --- Zoom (disabled in Arrange) --------------------------------------------
canvas.addEventListener(
  'wheel',
  (e: WheelEvent) => {
    e.preventDefault();
    if (mode === 'arrange') return; // no accidental zoom-off while rearranging
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const wx = toWorldX(mx);
    const wy = toWorldY(my);
    const factor = Math.exp(-e.deltaY * 0.0015);
    cam.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.zoom * factor));
    cam.x = wx - (mx - viewW / 2) / cam.zoom;
    cam.y = wy - (my - viewH / 2) / cam.zoom;
    // remember where we were zooming so we can ease to that level once you stop
    wheelWX = wx;
    wheelWY = wy;
    lastWheelAt = e.timeStamp;
    pendingSnap = true;
    snap = null;
  },
  { passive: false },
);

// --- Toggle wiring ----------------------------------------------------------
btn.addEventListener('click', () => setMode(mode === 'arrange' ? 'navigate' : 'arrange'));
window.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    setMode(mode === 'arrange' ? 'navigate' : 'arrange');
  } else if (e.key === 'Escape') {
    if (drag) drag = null;
    else if (mode === 'arrange') setMode('navigate');
  }
});

// --- Markdown import / export -----------------------------------------------
// A board is a nested task list: indentation = nesting, checkbox = column
// ([ ] To-do, [/] Doing, [x] Done). The same file is a live outline in Obsidian.
const STATUS_BOX: Record<Status, string> = { todo: '[ ]', doing: '[/]', done: '[x]' };

function boardToMarkdown(node: Node): string {
  const lines = [`# ${node.title}`, ''];
  const walk = (kids: Node[], depth: number): void => {
    for (const k of kids) {
      const tag = k.children.length > 0 && k.pinned ? ' #pinned' : '';
      lines.push('  '.repeat(depth) + `- ${STATUS_BOX[effectiveStatus(k)]} ${k.title}${tag}`);
      if (k.children.length > 0) walk(k.children, depth + 1);
    }
  };
  walk(node.children, 0);
  return lines.join('\n') + '\n';
}

function markdownToBoard(md: string): Node {
  const out: Node = { title: 'Kandelbrot', status: 'doing', children: [] };
  const stack: { node: Node; indent: number }[] = [{ node: out, indent: -1 }];
  for (const line of md.split('\n')) {
    const h1 = /^#\s+(.+)$/.exec(line);
    if (h1) {
      out.title = h1[1].trim();
      continue;
    }
    const m = /^(\s*)[-*]\s+\[([ xX/])\]\s+(.+)$/.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    const box = m[2].toLowerCase();
    const status: Status = box === 'x' ? 'done' : box === '/' ? 'doing' : 'todo';
    let title = m[3].trim();
    let pinned = false;
    if (/\s*#pinned$/.test(title)) {
      pinned = true;
      title = title.replace(/\s*#pinned$/, '').trim();
    }
    const node: Node = { title, status, children: [] };
    if (pinned) node.pinned = true;
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    stack[stack.length - 1].node.children.push(node);
    stack.push({ node, indent });
  }
  return out;
}

exportBtn.addEventListener('click', () => {
  const blob = new Blob([boardToMarkdown(root)], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${root.title.toLowerCase().replace(/\s+/g, '-') || 'board'}.md`;
  a.click();
  URL.revokeObjectURL(url);
});

importBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = ''; // let the same filename be re-imported later
  if (!file) return;
  dirMode = false; // importing a single file leaves folder mode
  root = markdownToBoard(await file.text());
  saveTree();
  flyTo({ x: ROOT.x, y: ROOT.y, w: ROOT.w, h: ROOT.h });
});

// --- Live folder (File System Access API) -----------------------------------
// Point Kandelbrot at a directory; each .md becomes a top-level board-card, and
// edits write straight back to the files. Chromium-only; elsewhere use Import/Export.
const fileHandles = new Map<Node, any>();

async function writeAllFiles(): Promise<void> {
  for (const [proj, handle] of fileHandles) {
    try {
      const w = await handle.createWritable();
      await w.write(boardToMarkdown(proj));
      await w.close();
    } catch {
      /* a file became unwritable — skip it */
    }
  }
}

function persist(): void {
  effCache.clear(); // the just-committed change must re-derive before serialising
  if (dirMode) void writeAllFiles();
  else saveTree();
}

const pickDir = (window as any).showDirectoryPicker as undefined | ((o?: any) => Promise<any>);
if (!pickDir) openDirBtn.style.display = 'none';

openDirBtn.addEventListener('click', async () => {
  if (!pickDir) return;
  let dh: any;
  try {
    dh = await pickDir({ mode: 'readwrite' });
  } catch {
    return; // user cancelled the picker
  }
  const projects: Node[] = [];
  fileHandles.clear();
  for await (const entry of dh.values()) {
    if (entry.kind === 'file' && /\.md$/i.test(entry.name)) {
      const proj = markdownToBoard(await (await entry.getFile()).text());
      if (proj.title === 'Kandelbrot') proj.title = entry.name.replace(/\.md$/i, ''); // no H1 → filename
      projects.push(proj);
      fileHandles.set(proj, entry);
    }
  }
  if (projects.length === 0) return;
  dirMode = true;
  root = { title: dh.name, status: 'doing', children: projects };
  flyTo({ x: ROOT.x, y: ROOT.y, w: ROOT.w, h: ROOT.h });
});

// --- In-app editing: rename (double-click), add, delete ---------------------
let renaming: Node | null = null;

// The deepest visible card under a screen point.
function hitTest(sx: number, sy: number): Focus | null {
  const wx = toWorldX(sx);
  const wy = toWorldY(sy);
  let cur: Focus = { node: root, x: ROOT.x, y: ROOT.y, w: ROOT.w, h: ROOT.h };
  if (wx < cur.x || wx > cur.x + cur.w || wy < cur.y || wy > cur.y + cur.h) return null;
  while (cur.node.children.length > 0 && cur.w * cam.zoom >= BOARD_MIN) {
    const placed = layout(cur.node.children, interior(cur));
    const hit = placed.find((p) => wx >= p.x && wx <= p.x + p.w && wy >= p.y && wy <= p.y + p.h);
    if (!hit) break;
    cur = { node: hit.node, x: hit.x, y: hit.y, w: hit.w, h: hit.h };
  }
  return cur;
}

// Locate a node's current rect by walking the layout from the root.
function findRect(target: Node): Focus | null {
  const walk = (node: Node, x: number, y: number, w: number, h: number): Focus | null => {
    if (node === target) return { node, x, y, w, h };
    for (const p of layout(node.children, interior({ x, y, w, h }))) {
      const found = walk(p.node, p.x, p.y, p.w, p.h);
      if (found) return found;
    }
    return null;
  };
  return walk(root, ROOT.x, ROOT.y, ROOT.w, ROOT.h);
}

// Float a DOM <input> over the card's title (the Figma/Excalidraw editing trick).
function openRename(target: Focus): void {
  renaming = target.node;
  const crect = canvas.getBoundingClientRect();
  const sw = target.w * cam.zoom;
  const sh = target.h * cam.zoom;
  const pad = sw * 0.06;
  renameInput.style.display = 'block';
  renameInput.style.left = `${crect.left + toScreenX(target.x) + pad}px`;
  renameInput.style.top = `${crect.top + toScreenY(target.y) + sh * 0.03}px`;
  renameInput.style.width = `${Math.max(60, sw - pad * 2)}px`;
  renameInput.style.fontSize = `${Math.max(11, Math.min(sh * 0.087, 24))}px`;
  renameInput.value = target.node.title;
  renameInput.focus();
  renameInput.select();
}

function commitRename(): void {
  if (!renaming) return;
  const v = renameInput.value.trim();
  if (v) renaming.title = v;
  renaming = null;
  renameInput.style.display = 'none';
  persist();
  refreshPanel();
}

renameInput.addEventListener('keydown', (e) => {
  e.stopPropagation(); // keep typing away from the global Tab/Esc shortcuts
  if (e.key === 'Enter') {
    e.preventDefault();
    commitRename();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    renaming = null;
    renameInput.style.display = 'none';
  }
});
renameInput.addEventListener('blur', commitRename);

canvas.addEventListener('dblclick', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const target = hitTest(e.clientX - rect.left, e.clientY - rect.top);
  if (target) openRename(target);
});

addCardBtn.addEventListener('click', () => {
  const f = panelFocusNode;
  if (!f) return;
  const node: Node = { title: 'New card', status: 'todo', children: [] };
  f.children.push(node);
  persist();
  refreshPanel();
  const path = focusPath();
  const fr = path[path.length - 1];
  if (fr.node === f) {
    const p = layout(f.children, interior(fr)).find((pp) => pp.node === node);
    if (p) openRename({ node, x: p.x, y: p.y, w: p.w, h: p.h });
  }
});

// --- Navigate: ease the camera to frame any node ----------------------------
function flyTo(r: Rect): void {
  if (mode === 'arrange') setMode('navigate');
  const fz = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(viewW / r.w, viewH / r.h) * 0.9));
  snap = {
    fx: cam.x,
    fy: cam.y,
    fz: cam.zoom,
    tx: r.x + r.w / 2,
    ty: r.y + r.h / 2,
    tz: fz,
    start: performance.now(),
  };
  pendingSnap = false;
}

// --- Inspector panel: contextual info about wherever you're focused --------
function descendants(n: Node): number {
  let c = n.children.length;
  for (const k of n.children) c += descendants(k);
  return c;
}
let panelSig = '';
let panelFocusNode: Node | null = null;

// --- Expanding board tree (the right panel's hierarchy view) ----------------
// The whole structure as an indented, collapsible outline. The focus path is
// always revealed + highlighted; click a row to fly there, ▸/▾ to expand.
const expanded = new Set<Node>();
const STATUS_RANK: Record<Status, number> = { todo: 0, doing: 1, done: 2 };
let treeVersion = 0; // bumped on any structural / expand change
let lastTreeFocus: Node | null = null;
let lastTreeVersion = -1;

function refreshPanel(): void {
  panelSig = '';
  treeVersion++;
}

function buildTree(): void {
  treeEl.replaceChildren();
  const onPath = new Set<Node>();
  for (const p of focusPath()) onPath.add(p.node);
  const focus = panelFocusNode;
  const isOpen = (n: Node): boolean => expanded.has(n) || onPath.has(n);

  const addRow = (n: Node, depth: number, parent: Node | null): void => {
    const open = isOpen(n);
    const hasKids = n.children.length > 0;
    const row = document.createElement('div');
    row.className = n === focus ? 'tree-row current' : 'tree-row';
    row.style.paddingLeft = `${6 + depth * 15}px`;

    const tog = document.createElement('span');
    tog.className = 'tree-tog';
    tog.textContent = hasKids ? (open ? '▾' : '▸') : '';
    if (hasKids) {
      tog.addEventListener('click', (e) => {
        e.stopPropagation();
        if (expanded.has(n)) expanded.delete(n);
        else expanded.add(n);
        refreshPanel();
      });
    }

    const dot = document.createElement('span');
    dot.className = `tree-dot ${effectiveStatus(n)}`;
    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = n.title;
    row.append(tog, dot, label);

    if (parent) {
      const del = document.createElement('button');
      del.className = 'tree-del';
      del.textContent = '×';
      del.title = 'Delete card';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (n.children.length > 0 && !confirm(`Delete “${n.title}” and its ${descendants(n)} cards?`)) return;
        const i = parent.children.indexOf(n);
        if (i >= 0) parent.children.splice(i, 1);
        persist();
        refreshPanel();
      });
      row.append(del);
    }

    row.addEventListener('click', () => {
      expanded.add(n);
      const r = findRect(n);
      if (r) flyTo(r);
      refreshPanel();
    });
    treeEl.appendChild(row);

    if (open && hasKids) {
      const kids = [...n.children].sort(
        (a, b) => STATUS_RANK[effectiveStatus(a)] - STATUS_RANK[effectiveStatus(b)],
      );
      for (const c of kids) addRow(c, depth + 1, n);
    }
  };

  addRow(root, 0, null);
  treeEl.querySelector('.tree-row.current')?.scrollIntoView({ block: 'nearest' }); // keep focus visible
}

function updatePanel(path: Focus[]): void {
  const f = path[path.length - 1].node;
  panelFocusNode = f;
  let todo = 0;
  let doing = 0;
  let done = 0;
  for (const k of f.children) {
    const s = effectiveStatus(k);
    if (s === 'todo') todo++;
    else if (s === 'doing') doing++;
    else done++;
  }
  const eff = effectiveStatus(f);
  const total = f.children.length;
  const desc = descendants(f);
  const sig = `${f.title}|${eff}|${f.pinned ? 'P' : 'A'}|${todo},${doing},${done}|${desc}|${path.length}`;
  if (sig !== panelSig) {
    panelSig = sig;
    piTitle.textContent = f.title;
    piStatus.textContent = eff;
    piStatus.className = `status-chip ${eff}`;
    segTodo.style.flexGrow = String(todo);
    segDoing.style.flexGrow = String(doing);
    segDone.style.flexGrow = String(done);
    piMeta.textContent =
      total === 0
        ? 'leaf · no children'
        : `${total} cards · ${todo}/${doing}/${done} · ${desc} in subtree · depth ${path.length - 1}`;
    if (total === 0) {
      piPin.style.display = 'none';
    } else if (f.pinned) {
      piPin.style.display = '';
      piPin.className = 'pi-pin pinned';
      piPin.textContent = '📌 pinned · tap to resync';
    } else {
      piPin.style.display = '';
      piPin.className = 'pi-pin';
      piPin.textContent = '⟲ auto · status from children';
    }
  }

  // Rebuild the tree on edits/expands immediately, and on a focus change only
  // once the camera settles — never every frame of a fly-in (DOM thrash).
  if (treeVersion !== lastTreeVersion || (f !== lastTreeFocus && !snap)) {
    lastTreeFocus = f;
    lastTreeVersion = treeVersion;
    buildTree();
  }
}

// Resync a pinned card back to deriving its status from its children.
piPin.addEventListener('click', () => {
  if (panelFocusNode && panelFocusNode.children.length > 0 && panelFocusNode.pinned) {
    const node = panelFocusNode;
    node.pinned = false;
    persist();
    refreshPanel(); // re-derive + re-render the panel/tree
    const r = findRect(node); // it just relocated to its derived column — follow it there
    if (r) flyTo(r);
  }
});

// --- Drawing ----------------------------------------------------------------

// Stroke the current path as a neon tube: a wide dim halo under a bright core.
// Cheap (no shadowBlur) — that's what makes the glow affordable everywhere.
function glow(rgb: [number, number, number], core = 0.9, scale = 1): void {
  const [r, g, b] = rgb;
  ctx.lineWidth = 4 * scale; // one dim halo...
  ctx.strokeStyle = `rgba(${r},${g},${b},0.14)`;
  ctx.stroke();
  ctx.lineWidth = 1 * scale; // ...under one bright core (2 strokes, not 3)
  ctx.strokeStyle = `rgba(${r},${g},${b},${core})`;
  ctx.stroke();
}

// The Grid: a faint glowing lattice the whole board sits on. Adaptive so lines
// stay ~64px apart at any zoom, with a brighter line every fourth step.
function drawGrid(): void {
  const step = Math.pow(2, Math.round(Math.log2(64 / cam.zoom)));
  const left = toWorldX(0);
  const right = toWorldX(viewW);
  const top = toWorldY(0);
  const bottom = toWorldY(viewH);
  const [r, g, b] = GRID_RGB;
  for (const [mult, alpha] of [[1, 0.05] as const, [4, 0.11] as const]) {
    const s = step * mult;
    ctx.beginPath();
    for (let x = Math.floor(left / s) * s; x < right; x += s) {
      const sx = Math.round(toScreenX(x)) + 0.5;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, viewH);
    }
    for (let y = Math.floor(top / s) * s; y < bottom; y += s) {
      const sy = Math.round(toScreenY(y)) + 0.5;
      ctx.moveTo(0, sy);
      ctx.lineTo(viewW, sy);
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
    ctx.stroke();
  }
}

// A glowing wireframe card: translucent fill so the Grid shows through, a neon
// cyan border, and a bright status-coloured edge.
function cardShell(sx: number, sy: number, sw: number, sh: number, status: Status): void {
  const radius = Math.min(10, sw * 0.06);
  ctx.beginPath();
  ctx.roundRect(sx, sy, sw, sh, radius);
  ctx.fillStyle = 'rgba(8,18,30,0.55)';
  ctx.fill();
  glow(CYAN_RGB, 0.5, sw < 90 ? 0.7 : 1);
  // status stripe, inset within the rounded corners so it needs no clip
  ctx.fillStyle = STATUS_COLOR[status];
  ctx.fillRect(sx + 1, sy + radius, Math.max(2, Math.min(sw * 0.02, 7)), sh - radius * 2);
}

function cardTitle(sx: number, sy: number, sw: number, sh: number, title: string): void {
  const pad = sw * 0.08;
  const titleH = sh * 0.14;
  const fontPx = Math.max(7, Math.min(titleH * 0.62, 24));
  ctx.fillStyle = 'rgba(196,246,255,0.96)';
  ctx.font = `${fontPx}px ui-monospace, "SF Mono", Menlo, monospace`;
  ctx.textBaseline = 'middle';
  ctx.save();
  ctx.beginPath();
  ctx.rect(sx + pad, sy, sw - pad * 2, titleH * 1.5);
  ctx.clip();
  ctx.fillText(title, sx + pad, sy + titleH * 0.62);
  ctx.restore();
}

function drawNode(node: Node, x: number, y: number, w: number, h: number): void {
  const sx = toScreenX(x);
  const sy = toScreenY(y);
  const sw = w * cam.zoom;
  const sh = h * cam.zoom;

  if (sx + sw < 0 || sy + sh < 0 || sx > viewW || sy > viewH) return;
  drawn++;

  // The card currently being dragged leaves a dashed gap where it came from.
  if (drag && node === drag.node) {
    const radius = Math.min(10, sw * 0.06);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255,174,52,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(sx, sy, sw, sh, radius);
    ctx.stroke();
    ctx.restore();
    return;
  }

  const eff = effectiveStatus(node);
  if (sw < 5) {
    ctx.fillStyle = STATUS_COLOR[eff];
    ctx.fillRect(sx, sy, Math.max(1, sw), Math.max(1, sh));
    return;
  }

  cardShell(sx, sy, sw, sh, eff);
  if (sw < 34) return;
  cardTitle(sx, sy, sw, sh, node.title);

  if (sw >= BOARD_MIN && node.children.length > 0) {
    const b = interior({ x, y, w, h });
    drawBoard(node, b);
    drawTraces(node, b);
  }
}

function drawBoard(node: Node, b: Rect): void {
  for (const col of columns(b)) {
    const scx = toScreenX(col.colX);
    const scy = toScreenY(col.top);
    const scw = col.colW * cam.zoom;
    const sch = col.height * cam.zoom;
    if (scx + scw < 0 || scx > viewW || scy + sch < 0 || scy > viewH) continue;

    ctx.fillStyle = 'rgba(44,224,255,0.03)';
    ctx.beginPath();
    ctx.roundRect(scx, scy, scw, sch, Math.min(6, scw * 0.04));
    ctx.fill();

    const headFont = Math.max(6, Math.min(col.headerH * cam.zoom * 0.62, 13));
    ctx.fillStyle = STATUS_COLOR[col.status];
    ctx.font = `${headFont}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.textBaseline = 'middle';
    ctx.fillText(COLUMN_LABEL[col.status].toUpperCase(), scx + scw * 0.08, scy + col.headerH * cam.zoom * 0.55);

    for (const p of stack(node.children.filter((k) => effectiveStatus(k) === col.status), col)) {
      drawNode(p.node, p.x, p.y, p.w, p.h);
    }
  }
}

// Circuit-board traces: each column's cards tapped off a glowing bus rail with
// solder-node dots — the kanban board read as a literal circuit board. Only the
// prominent boards get wired, to keep it sparse and cheap.
function drawTraces(node: Node, b: Rect): void {
  if (b.w * cam.zoom < 280) return;
  const nodes: [number, number][] = [];
  const rails: { x: number; top: number; bottom: number }[] = [];
  ctx.beginPath();
  for (const col of columns(b)) {
    const placed = stack(
      node.children.filter((k) => effectiveStatus(k) === col.status),
      col,
    );
    if (placed.length === 0) continue;
    const railSX = toScreenX(col.colX + col.colW * 0.045);
    const top = toScreenY(col.innerY);
    const last = placed[placed.length - 1];
    const bottom = toScreenY(last.y + last.h / 2);
    rails.push({ x: railSX, top, bottom });
    ctx.moveTo(railSX, top);
    ctx.lineTo(railSX, bottom);
    for (const p of placed) {
      const cy = toScreenY(p.y + p.h / 2);
      ctx.moveTo(railSX, cy);
      ctx.lineTo(toScreenX(p.x), cy);
      nodes.push([toScreenX(p.x), cy]);
    }
  }
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(44,224,255,0.06)';
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(44,224,255,0.3)';
  ctx.stroke();
  ctx.fillStyle = 'rgba(154,246,255,0.85)';
  for (const [nx, ny] of nodes) {
    ctx.beginPath();
    ctx.arc(nx, ny, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  // energy pulses travelling down each rail — the circuit reading as "live"
  rails.forEach((r, i) => {
    const t = (nowMs / 2200 + i * 0.21) % 1;
    const py = r.top + t * (r.bottom - r.top);
    ctx.fillStyle = 'rgba(44,224,255,0.16)';
    ctx.beginPath();
    ctx.arc(r.x, py, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(190,248,255,0.95)';
    ctx.beginPath();
    ctx.arc(r.x, py, 2.4, 0, Math.PI * 2);
    ctx.fill();
  });
}

// Dim everything outside the focused board (Arrange mode).
function dimOutside(f: Focus): void {
  const L = Math.max(0, Math.min(viewW, toScreenX(f.x)));
  const R = Math.max(0, Math.min(viewW, toScreenX(f.x + f.w)));
  const T = Math.max(0, Math.min(viewH, toScreenY(f.y)));
  const B = Math.max(0, Math.min(viewH, toScreenY(f.y + f.h)));
  ctx.fillStyle = 'rgba(2,6,13,0.72)';
  ctx.fillRect(0, 0, viewW, T);
  ctx.fillRect(0, B, viewW, viewH - B);
  ctx.fillRect(0, T, L, B - T);
  ctx.fillRect(R, T, viewW - R, B - T);
}

function focusRing(f: Focus, strong: boolean): void {
  const sx = toScreenX(f.x);
  const sy = toScreenY(f.y);
  const sw = f.w * cam.zoom;
  const sh = f.h * cam.zoom;
  // Navigate = cyan, Arrange = energized amber (the Tron duality).
  const [r, g, b] = strong ? [255, 174, 52] : CYAN_RGB;
  const core = strong ? 'rgba(255,221,150,1)' : CYAN_CORE;
  ctx.beginPath();
  ctx.roundRect(sx, sy, sw, sh, Math.min(16, sw * 0.05));
  ctx.lineWidth = (strong ? 12 : 8) * pulse;
  ctx.strokeStyle = `rgba(${r},${g},${b},${0.1 * pulse})`;
  ctx.stroke();
  ctx.lineWidth = strong ? 4 : 3;
  ctx.strokeStyle = `rgba(${r},${g},${b},${strong ? 0.45 : 0.34})`;
  ctx.stroke();
  ctx.lineWidth = strong ? 2 : 1.5;
  ctx.strokeStyle = core;
  ctx.stroke();
}

function drawDropIndicator(f: Focus): void {
  if (!drag) return;
  const d = drag;
  const { status, index } = dropTarget(f, d.px, d.py);
  const col = columns(interior(f)).find((c) => c.status === status)!;
  const kids = f.node.children.filter((k) => effectiveStatus(k) === status && k !== d.node);
  const placed = stack(kids, col);
  let wy: number;
  if (placed.length === 0) wy = col.innerY;
  else if (index < placed.length) wy = placed[index].y - col.innerH * 0.025;
  else wy = placed[placed.length - 1].y + placed[placed.length - 1].h + col.innerH * 0.025;
  const sy = toScreenY(wy);
  ctx.beginPath();
  ctx.moveTo(toScreenX(col.innerX), sy);
  ctx.lineTo(toScreenX(col.innerX + col.innerW), sy);
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(255,174,52,0.3)';
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,221,150,1)';
  ctx.stroke();
}

function drawLifted(): void {
  if (!drag) return;
  const sw = drag.w * cam.zoom;
  const sh = drag.h * cam.zoom;
  const sx = toScreenX(drag.px) - sw / 2;
  const sy = toScreenY(drag.py) - sh / 2;
  ctx.save();
  ctx.globalAlpha = 0.95;
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 6;
  cardShell(sx, sy, sw, sh, drag.node.status);
  ctx.shadowColor = 'transparent';
  cardTitle(sx, sy, sw, sh, drag.node.title);
  ctx.restore();
}

// Once the wheel gesture settles, ease the camera to frame the nearest level.
// "Nearest" is measured in log-zoom along the chain of cards under the cursor,
// so the geometric steps between levels are weighted evenly.
function startSnap(now: number): void {
  const path: Focus[] = [{ node: root, x: ROOT.x, y: ROOT.y, w: ROOT.w, h: ROOT.h }];
  let cur = path[0];
  while (cur.node.children.length > 0) {
    const placed = layout(cur.node.children, interior(cur));
    const hit = placed.find(
      (p) => wheelWX >= p.x && wheelWX <= p.x + p.w && wheelWY >= p.y && wheelWY <= p.y + p.h,
    );
    if (!hit) break;
    cur = { node: hit.node, x: hit.x, y: hit.y, w: hit.w, h: hit.h };
    path.push(cur);
  }
  const zln = Math.log(cam.zoom);
  let target: Focus | null = null;
  let targetZoom = cam.zoom;
  let bestDist = Infinity;
  for (const c of path) {
    const fz = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(viewW / c.w, viewH / c.h) * 0.9));
    const d = Math.abs(Math.log(fz) - zln);
    if (d < bestDist) {
      bestDist = d;
      target = c;
      targetZoom = fz;
    }
  }
  if (!target) return;
  snap = {
    fx: cam.x,
    fy: cam.y,
    fz: cam.zoom,
    tx: target.x + target.w / 2,
    ty: target.y + target.h / 2,
    tz: targetZoom,
    start: now,
  };
}

// --- Render loop ------------------------------------------------------------
let lastFrame = performance.now();
let fps = 60;
let drawn = 0;
let pulse = 1;
let nowMs = 0;

function frame(now: number): void {
  const dt = now - lastFrame;
  lastFrame = now;
  if (dt > 0) fps = fps * 0.9 + (1000 / dt) * 0.1;
  effCache.clear();

  if (snap) {
    const t = (now - snap.start) / SNAP_MS;
    if (t >= 1) {
      cam.x = snap.tx;
      cam.y = snap.ty;
      cam.zoom = snap.tz;
      snap = null;
    } else {
      const ease = 1 - Math.pow(1 - t, 3); // ease-out cubic
      cam.x = snap.fx + (snap.tx - snap.fx) * ease;
      cam.y = snap.fy + (snap.ty - snap.fy) * ease;
      cam.zoom = snap.fz * Math.pow(snap.tz / snap.fz, ease); // geometric, so it feels even
    }
  } else if (pendingSnap && !drag && !panning && mode === 'navigate' && now - lastWheelAt > SETTLE_MS) {
    pendingSnap = false;
    startSnap(now);
  }

  pulse = 0.82 + 0.18 * Math.sin(now / 460);
  nowMs = now;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, viewW, viewH);

  drawGrid();

  drawn = 0;
  drawNode(root, ROOT.x, ROOT.y, ROOT.w, ROOT.h);

  const path = mode === 'arrange' && frozenPath ? frozenPath : focusPath();
  const focus = path[path.length - 1];
  if (mode === 'arrange') {
    dimOutside(focus);
    drawDropIndicator(focus);
    focusRing(focus, true);
    drawLifted();
  } else {
    focusRing(focus, false);
  }

  updatePanel(path);
  hud.textContent = `${cam.zoom.toFixed(2)}×  ·  ${drawn} cards  ·  ${fps.toFixed(0)} fps`;
  requestAnimationFrame(frame);
}

resize();
setMode('navigate');
requestAnimationFrame(frame);
