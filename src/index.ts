// Event Master (Barco E2, S3-4K, EX): recall presets to preview, take them to program, and see which source each
// destination shows.
//
// The processor is the source of truth. Presets, sources, destinations and what is on program and
// preview are read from it and kept only in memory. Config holds the processor's address, the
// operator this unit acts as and the Allow controls switch; the super-operator password is a module
// secret (in named saves, never sent to a UI). Starting, restoring, resuming and reconnecting only
// read. A preset recall, TAKE or CUT goes out only when someone presses a key or taps the screen, and
// only with Allow controls on.
//
// Stream Deck:
//   keys 1-10   presets, by preset number. Press: recall to preview. Green on preview, red on program
//   key 11      next page of presets (with more than 10)
//   key 12      what is on preview          key 13  what is on program
//   key 14      CUT (hold)                  key 15  TAKE
//
// On a larger deck (controller 0.21.0+) presets fill every row but the bottom one, and the bottom row
// keeps the page key first and PREVIEW, PROGRAM, CUT and TAKE last, with more presets in between.

import { defineModule, type Ctx, type KeySetParams } from '@rcs/module-sdk';
import { DEFAULT_PORT, VIDEO_STATUS, type Dest, type LayerUse } from './e2.js';
import { Processor, type Auth } from './processor.js';

export interface State {
  presetPage: number;
}

export interface Config {
  address: string;
  port: number;
  /** Multi-operator mode: 0-2, or -1 when the processor does not use operators. */
  operatorId: number;
  allowControls: boolean;
}

type C = Ctx<State, Config>;
export type View = 'presets' | 'screens' | 'outputs' | 'sources' | 'setup';
const VIEWS: View[] = ['presets', 'screens', 'outputs', 'sources', 'setup'];

export const KEY = { PAGE: 10, PVW: 11, PGM: 12, CUT: 13, TAKE: 14 } as const;
export const PER_PAGE = 10;

export interface Grid {
  columns: number;
  rows: number;
}

/** The deck as the controller describes it. Older controllers send no size: 5 × 3. */
export function grid(ctx: { host: { deck: { columns?: number; rows?: number } } }): Grid {
  return { columns: ctx.host.deck.columns ?? 5, rows: ctx.host.deck.rows ?? 3 };
}

export interface Layout {
  keys: number;
  /** Preset keys, in order. */
  presets: number[];
  page: number;
  pvw: number;
  pgm: number;
  cut: number;
  take: number;
}

/** Where everything goes on a deck of this size. On 5 × 3 it is KEY and PER_PAGE. */
export function layout(g: Grid): Layout {
  const keys = g.columns * g.rows;
  const bottom = (g.rows - 1) * g.columns;
  const presets = Array.from({ length: bottom }, (_, i) => i);
  for (let k = bottom + 1; k < keys - 4; k++) presets.push(k);
  return { keys, presets, page: bottom, pvw: keys - 4, pgm: keys - 3, cut: keys - 2, take: keys - 1 };
}
const HOLD_MS = 700;

// Key colours: keys have no CSS. Tally colours as on the E2 controller: green preview, red program.
const PVW_BG = '#1E6B34';
const PGM_BG = '#A3231F';
const TAKE_BG = '#F5A524';
const ON_ACCENT = '#16181C';
const DIM_BG = '#24272D';
const DANGER = '#3A1E1C';

interface Runtime {
  proc: Processor | null;
  view: View;
  ctx: C;
}
let rt: Runtime | null = null;

const ADDRESS_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
export function validAddress(a: unknown): a is string {
  return typeof a === 'string' && (a === '' || ADDRESS_RE.test(a));
}

function cfg(ctx: C): Config {
  const c = ctx.config ?? ({} as Config);
  return {
    address: c.address ?? '',
    port: c.port ?? DEFAULT_PORT,
    operatorId: Number.isInteger(c.operatorId) ? c.operatorId : -1,
    allowControls: c.allowControls ?? false
  };
}

function password(ctx: C): string {
  const p = ctx.secrets?.value?.password;
  return typeof p === 'string' ? p : '';
}

function auth(ctx: C): Auth {
  return { operatorId: cfg(ctx).operatorId, password: password(ctx) };
}

function proc(): Processor | null {
  return rt?.proc ?? null;
}

function ready(): boolean {
  return !!proc()?.ready;
}

function short(s: string | undefined, n: number): string {
  const chars = [...(s ?? '')];
  return chars.length > n ? chars.slice(0, n).join('') : chars.join('');
}

function perPage(ctx: C): number {
  return layout(grid(ctx)).presets.length;
}

function pages(ctx: C): number {
  return Math.max(1, Math.ceil((proc()?.presets.length ?? 0) / perPage(ctx)));
}

function sourceName(id: number): string {
  return proc()?.sources.find((s) => s.id === id)?.name ?? `Source ${id + 1}`;
}

/**
 * A layer's source. A screen background (layer null) counts among the background sources only
 * (listSources SrcType 1), so its index is a position in that list.
 */
function useName(d: Dest, l: LayerUse): string {
  if (d.kind === 'screen' && l.layer === null) return proc()?.sources.filter((s) => s.type === 1)[l.source]?.name ?? `Background ${l.source + 1}`;
  return sourceName(l.source);
}

/** "CAM 1 + GFX 1": the sources a destination shows, background last. */
function shows(d: Dest, which: 'program' | 'preview'): string {
  const list = d[which];
  if (!list.length) return '—';
  const layers = list.filter((l) => l.layer !== null);
  const bg = list.filter((l) => l.layer === null);
  return [...layers.reverse(), ...bg].map((l) => useName(d, l)).join(' + ');
}

// ---- connection --------------------------------------------------------------------------------

/** (Re)connects to the configured processor. Reads only. */
function connect(ctx: C, force = false): void {
  if (!rt) return;
  const { address, port } = cfg(ctx);
  const old = rt.proc;
  if (old && !force && old.host === address && old.port === port) return;
  old?.removeAllListeners();
  old?.stop();
  rt.proc = null;
  if (!address) {
    ctx.status('disconnected', 'Set the processor address in Setup').catch(() => {});
    draw(ctx).catch(() => {});
    return;
  }
  const pollMs = Number(process.env.RCS_E2_POLL_MS) || undefined; // faster polls for development
  const p = new Processor(address, port, { auth: () => auth(ctx), ...(pollMs ? { pollMs } : {}) });
  rt.proc = p;
  p.on('status', (connection, text) => {
    if (rt?.proc !== p) return;
    ctx.status(connection, text).catch(() => {});
  });
  p.on('change', () => {
    if (rt?.proc !== p) return;
    clampPage(ctx).then(() => draw(ctx)).catch(() => {}); // the controller may be gone
  });
  ctx.status('connecting', `Connecting to ${address}…`).catch(() => {});
  p.start();
}

async function clampPage(ctx: C): Promise<void> {
  if (ctx.state.value.presetPage >= pages(ctx)) await ctx.state.patch({ presetPage: 0 });
}

// ---- drawing -----------------------------------------------------------------------------------

export function snapshot(ctx: C) {
  const p = proc();
  const c = cfg(ctx);
  const dests = p ? [...p.screens, ...p.auxes] : [];
  return {
    type: 'snapshot',
    connection: p?.connection ?? 'disconnected',
    statusText: p?.statusText ?? (c.address ? '' : 'Set the processor address in Setup'),
    ready: ready(),
    busy: !!p?.busy,
    frame: p?.frame ?? null,
    warnings: p?.warnings ?? [],
    presets: p?.presets ?? [],
    sources: (p?.sources ?? []).map((s) => ({ ...s, status: s.video === null ? '' : (VIDEO_STATUS[s.video] ?? `Status ${s.video}`) })),
    dests: dests.map((d) => ({
      kind: d.kind,
      id: d.id,
      name: d.name,
      size: d.kind === 'screen' && d.width ? `${d.width}×${d.height}` : '',
      transitionFrames: d.kind === 'screen' ? d.transitionFrames : null,
      width: d.kind === 'screen' ? d.width : 0,
      height: d.kind === 'screen' ? d.height : 0,
      outputs: d.kind === 'screen' ? d.outputs : [],
      read: d.read,
      program: d.program.map((l) => ({ layer: l.layer, source: l.source, name: useName(d, l), frozen: l.frozen, window: l.window ?? null })),
      preview: d.preview.map((l) => ({ layer: l.layer, source: l.source, name: useName(d, l), frozen: l.frozen, window: l.window ?? null })),
      programText: shows(d, 'program'),
      previewText: shows(d, 'preview')
    })),
    previewPreset: p?.previewPreset ?? null,
    programPreset: p?.programPreset ?? null,
    config: c,
    passwordSet: password(ctx) !== '',
    presetPage: ctx.state.value.presetPage,
    perPage: perPage(ctx),
    view: rt?.view ?? 'presets'
  };
}

/** The controller refuses a whole keys.setMany over these limits, so every face is cut to fit. */
export const LABEL_MAX = 10;
export const SUBLABEL_MAX = 12;

function fit(f: KeySetParams): KeySetParams {
  return { ...f, ...(f.label !== undefined ? { label: short(f.label, LABEL_MAX) } : {}), ...(f.sublabel !== undefined ? { sublabel: short(f.sublabel, SUBLABEL_MAX) } : {}) };
}

function keyFaces(ctx: C): KeySetParams[] {
  return rawKeyFaces(ctx).map(fit);
}

function rawKeyFaces(ctx: C): KeySetParams[] {
  const p = proc();
  const live = ready() && !!p;
  const c = cfg(ctx);
  const L = layout(grid(ctx));
  const faces: KeySetParams[] = [];
  const page = ctx.state.value.presetPage;
  const presets = p?.presets ?? [];
  const pvw = p?.previewPreset?.preset ?? null;
  const pgm = p?.programPreset?.preset ?? null;

  for (const [i, k] of L.presets.entries()) {
    const preset = presets[page * L.presets.length + i];
    if (!live || !preset) {
      faces.push({ index: k });
      continue;
    }
    const onPgm = preset.id === pgm;
    const onPvw = preset.id === pvw;
    const num = Number.isInteger(preset.number) ? String(preset.number) : preset.number.toFixed(2);
    faces.push({
      index: k,
      label: short(preset.name, 10),
      sublabel: onPgm && onPvw ? 'PGM · PVW' : onPgm ? 'PROGRAM' : onPvw ? 'PREVIEW' : `PRESET ${num}`,
      ...(onPgm ? { background: PGM_BG } : onPvw ? { background: PVW_BG } : {})
    });
  }

  if (live && pages(ctx) > 1) faces.push({ index: L.page, label: 'MORE ▶', sublabel: `page ${page + 1}/${pages(ctx)}` });
  else faces.push({ index: L.page });

  if (!live) {
    faces.push({ index: L.pvw }, { index: L.pgm, label: 'OFFLINE', sublabel: short(c.address || 'no address', 12), background: DANGER }, { index: L.cut }, { index: L.take });
    return faces;
  }
  faces.push({ index: L.pvw, label: 'PREVIEW', sublabel: short(p!.previewPreset?.name ?? '—', 12), background: PVW_BG });
  faces.push({ index: L.pgm, label: 'PROGRAM', sublabel: short(p!.programPreset?.name ?? '—', 12), background: PGM_BG });
  if (!c.allowControls) {
    faces.push({ index: L.cut, label: 'CUT', sublabel: 'controls off', background: DIM_BG }, { index: L.take, label: 'TAKE', sublabel: 'controls off', background: DIM_BG });
  } else {
    faces.push({ index: L.cut, label: 'CUT', sublabel: 'hold', background: DIM_BG });
    faces.push(p!.busy ? { index: L.take, label: 'TAKE', sublabel: 'sending…', background: DIM_BG } : { index: L.take, label: 'TAKE', sublabel: short(p!.previewPreset?.name ?? 'preview', 12), background: TAKE_BG, color: ON_ACCENT });
  }
  return faces;
}

export async function draw(ctx: C, clientId?: string): Promise<void> {
  // The screens are drawn even if the keys are refused.
  const keys = clientId ? Promise.resolve() : ctx.keys.setMany(keyFaces(ctx));
  await ctx.ui.send(snapshot(ctx), clientId);
  await keys;
}

// ---- operator actions: the only things that send commands -----------------------------------------

function mayControl(ctx: C): boolean {
  if (!ready()) {
    ctx.notify('Not connected to the processor', 'warning').catch(() => {});
    return false;
  }
  if (!cfg(ctx).allowControls) {
    ctx.notify('Controls are off. Turn on Allow controls in Setup.', 'warning').catch(() => {});
    return false;
  }
  if (proc()!.busy) return false;
  return true;
}

async function recall(ctx: C, id: number): Promise<void> {
  if (!mayControl(ctx)) return;
  const preset = proc()!.presets.find((x) => x.id === id);
  if (!preset) return;
  try {
    await proc()!.recallPreset(id);
    await ctx.log('info', `Recalled preset ${preset.number} "${preset.name}" to preview`);
  } catch (e) {
    await ctx.notify(`Preset not recalled: ${(e as Error).message}`, 'error');
  }
  await draw(ctx);
}

async function take(ctx: C, cut: boolean): Promise<void> {
  if (!mayControl(ctx)) return;
  const what = proc()!.previewPreset?.name;
  try {
    await proc()!.take(cut);
    await ctx.log('info', `${cut ? 'Cut' : 'Take'}${what ? ` (${what})` : ''}`);
  } catch (e) {
    await ctx.notify(`${cut ? 'Cut' : 'Take'} not sent: ${(e as Error).message}`, 'error');
  }
  await draw(ctx);
}

// ---- the module's own settings -----------------------------------------------------------------

async function setConfig(ctx: C, changes: Partial<Config>): Promise<void> {
  const next = { ...cfg(ctx) };
  if (changes.address !== undefined) {
    const a = String(changes.address).trim();
    if (!validAddress(a)) {
      await ctx.notify('That is not an IP address or host name', 'warning');
      return draw(ctx);
    }
    next.address = a;
  }
  if (changes.port !== undefined) {
    const p = Number(changes.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      await ctx.notify('Port must be 1 to 65535', 'warning');
      return draw(ctx);
    }
    next.port = p;
  }
  if (changes.operatorId !== undefined) {
    const o = Number(changes.operatorId);
    if (!Number.isInteger(o) || o < -1 || o > 2) return draw(ctx);
    next.operatorId = o;
  }
  if (changes.allowControls !== undefined) next.allowControls = !!changes.allowControls;
  await ctx.setConfig(next);
  connect(ctx);
  await draw(ctx);
}

async function setPassword(ctx: C, pw: unknown): Promise<void> {
  const value = typeof pw === 'string' ? pw.slice(0, 64) : '';
  try {
    await ctx.secrets.set(value ? { password: value } : {});
    await ctx.notify(value ? 'Super-operator password saved' : 'Password removed');
  } catch (e) {
    await ctx.notify(`Password not saved: ${(e as Error).message}. This needs controller 0.15.0 or later.`, 'error');
  }
  await draw(ctx);
}

/** Moves the strip highlight when the UI changed page itself; older hosts lack strip.select. */
function highlight(ctx: C, view: View): void {
  const strip = ctx.strip as typeof ctx.strip & { select?(id: string): Promise<void> };
  void strip.select?.(view).catch(() => {});
}

export default defineModule<State, Config>({
  // The panel UI fills a taller screen too (1824×1080 on a 16:9 one). Controllers before 0.22.0 ignore it.
  fullPanel: true,
  holdMs: HOLD_MS,
  // Every key of a larger deck: more presets per page. Older controllers ignore this and send 15 keys.
  fullDeck: true,

  // The deck changed size: presets per page changed, so the page may be past the end now.
  async deck(ctx) {
    await clampPage(ctx);
    await ctx.keys.clear();
    await draw(ctx);
  },

  async start(ctx) {
    rt?.proc?.stop();
    rt = { proc: null, view: 'presets', ctx };
    await ctx.state.init({ presetPage: 0 });
    await ctx.strip.set([
      { id: 'presets', label: 'Presets', icon: 'assets/presets.svg' },
      { id: 'screens', label: 'Screens', icon: 'assets/screens.svg' },
      { id: 'outputs', label: 'Outputs', icon: 'assets/outputs.svg' },
      { id: 'sources', label: 'Sources', icon: 'assets/sources.svg' },
      { id: 'setup', label: 'Setup', icon: 'assets/setup.svg' }
    ]);
    connect(ctx); // reads only: no commands on start, whatever the reason
    await draw(ctx);
  },

  stop() {
    rt?.proc?.removeAllListeners();
    rt?.proc?.stop();
    rt = null;
  },

  async key(ctx, { index, action }) {
    if (action !== 'down' || !rt) return;
    const p = proc();
    const L = layout(grid(ctx));
    const slot = L.presets.indexOf(index);
    if (slot >= 0) {
      const preset = p?.presets[ctx.state.value.presetPage * L.presets.length + slot];
      if (preset) await recall(ctx, preset.id);
      return;
    }
    if (index === L.page && pages(ctx) > 1) {
      await ctx.state.patch({ presetPage: (ctx.state.value.presetPage + 1) % pages(ctx) });
      return draw(ctx);
    }
    if (index === L.take) return take(ctx, false);
    if (index === L.pvw || index === L.pgm) {
      rt.view = 'outputs';
      highlight(ctx, 'outputs');
      return draw(ctx);
    }
  },

  async hold(ctx, index) {
    if (index === layout(grid(ctx)).cut) await take(ctx, true);
  },

  async strip(ctx, id) {
    if (!rt || !VIEWS.includes(id as View)) return;
    rt.view = id as View;
    await draw(ctx);
  },

  async client(ctx, { clientId, action }) {
    if (action === 'connect') await draw(ctx, clientId);
  },

  async ui(ctx, { clientId, message: m }) {
    if (!rt || typeof m !== 'object' || m === null) return;
    switch (m.type) {
      case 'hello':
        return draw(ctx, clientId);
      case 'recall':
        return recall(ctx, Number(m.id));
      case 'take':
        return take(ctx, false);
      case 'cut':
        return take(ctx, true);
      case 'page': {
        const page = Number(m.page);
        if (Number.isInteger(page) && page >= 0 && page < pages(ctx)) await ctx.state.patch({ presetPage: page });
        return draw(ctx);
      }
      case 'view':
        if (VIEWS.includes(m.view)) {
          rt.view = m.view;
          highlight(ctx, m.view);
        }
        return draw(ctx);
      case 'config':
        return setConfig(ctx, m.config ?? {});
      case 'password':
        return setPassword(ctx, m.password);
      case 'reconnect':
        connect(ctx, true);
        return draw(ctx);
    }
  }
});
