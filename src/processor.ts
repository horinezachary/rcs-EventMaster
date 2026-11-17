// Reads one Event Master processor and sends the operator's commands to it.
//
// Reading: what every destination shows on program and preview, once a second; the presets, sources,
// destination list, and every frame of the system with its cards and power supplies every few seconds. Everything read is kept in memory.
//
// The API cannot say which preset is on preview or program, so the module remembers the presets it
// recalled and took itself. That marker holds while the destinations' content stays as the recall
// left it, and goes away as soon as someone changes it from elsewhere (the E2's own console, Event
// Master Toolset, another controller).

import { EventEmitter } from 'node:events';
import {
  applyAuxContent,
  applyContent,
  E2Error,
  parseDestinations,
  frameWarnings,
  parseFrames,
  parsePower,
  parsePresets,
  parseSources,
  rpc,
  type AuxDest,
  type FrameInfo,
  type Preset,
  type ScreenDest,
  type Source
} from './e2.js';

export type Connection = 'connected' | 'connecting' | 'disconnected';

export interface Auth {
  /** Multi-operator mode: the operator this unit acts as (0-2); -1 when the processor has none. */
  operatorId: number;
  /** Super-operator password; empty when not used. */
  password: string;
}

export interface ProcessorOptions {
  pollMs?: number;
  /** Slow reads (presets, sources, destinations, frame) every this many polls. */
  slowEvery?: number;
  timeoutMs?: number;
  /** Polls in a row that fail before the processor shows as offline. */
  offlineAfter?: number;
  auth?: () => Auth;
}

export interface Marker {
  preset: number;
  name: string;
}

interface Tracked {
  marker: Marker;
  sig: string;
  /** Until then the content may still be moving (a transition), so the signature is re-taken. */
  settleUntil: number;
}

export class Processor extends EventEmitter {
  connection: Connection = 'connecting';
  statusText = 'Connecting…';
  frame: FrameInfo | null = null;
  /** Problems across the frames of the system: lost frames, mixed software, power, cards. */
  warnings: string[] = [];
  /** Every frame seen since the module started, so one that drops out of the system is noticed. */
  private seenFrames = new Map<string, string>();
  sources: Source[] = [];
  presets: Preset[] = [];
  screens: ScreenDest[] = [];
  auxes: AuxDest[] = [];
  /** True once destinations and their content have been read at least once. */
  ready = false;
  busy = false;
  private pvw: Tracked | null = null;
  private pgm: Tracked | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private polls = 0;
  private failures = 0;
  private polling: Promise<void> | null = null;
  private readonly o: Required<Omit<ProcessorOptions, 'auth'>> & { auth: () => Auth };

  constructor(
    readonly host: string,
    readonly port: number,
    opts: ProcessorOptions = {}
  ) {
    super();
    this.o = {
      pollMs: opts.pollMs ?? 1000,
      slowEvery: opts.slowEvery ?? 5,
      timeoutMs: opts.timeoutMs ?? 2500,
      offlineAfter: opts.offlineAfter ?? 3,
      auth: opts.auth ?? (() => ({ operatorId: -1, password: '' }))
    };
  }

  get previewPreset(): Marker | null {
    return this.pvw?.marker ?? null;
  }
  get programPreset(): Marker | null {
    return this.pgm?.marker ?? null;
  }

  start(): void {
    this.stopped = false;
    void this.poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private call<T = any>(method: string, params: object = {}): Promise<T> {
    return rpc<T>(this.host, this.port, method, params, { timeoutMs: this.o.timeoutMs });
  }

  /** Reads now (after a command), or waits for the read already running. */
  async refresh(): Promise<void> {
    if (this.polling) await this.polling;
    await this.poll();
  }

  private poll(): Promise<void> {
    if (this.polling) return this.polling;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.polling = this.read()
      .catch(() => {})
      .finally(() => {
        this.polling = null;
        if (!this.stopped) this.timer = setTimeout(() => void this.poll(), this.o.pollMs);
      });
    return this.polling;
  }

  private async read(): Promise<void> {
    const slow = this.polls % this.o.slowEvery === 0 || !this.ready;
    this.polls++;
    try {
      if (slow) await this.readSlow();
      await Promise.all([
        ...this.screens.map(async (d) => applyContent(d, await this.call('listContent', { id: d.id }))),
        ...this.auxes.map(async (d) => applyAuxContent(d, await this.call('listAuxContent', { id: d.id })))
      ]);
      if (this.stopped) return;
      this.failures = 0;
      this.ready = true;
      this.track();
      const n = this.frame?.frames.length ?? 0;
      const base = `${this.frame?.model ?? 'Event Master'} ${this.frame?.name ?? ''}`.trim() + (n > 1 ? ` · ${n} frames` : '');
      const w = this.warnings.length;
      this.setStatus('connected', w ? `${base} · ${w} warning${w > 1 ? 's' : ''}` : base);
    } catch (e) {
      if (this.stopped) return;
      this.failures++;
      if (this.failures >= this.o.offlineAfter || !this.ready) {
        const msg = (e as Error).message;
        this.setStatus(this.ready ? 'disconnected' : 'connecting', this.ready ? `Lost the processor: ${msg}` : `No answer from ${this.host}:${this.port} (${msg})`);
        if (this.failures >= this.o.offlineAfter) {
          this.ready = false;
          this.pvw = this.pgm = null;
        }
      }
    }
    this.emit('change');
  }

  private async readSlow(): Promise<void> {
    const [frame, sources, presets, dests] = await Promise.all([
      this.call('getFrameSettings'),
      this.call('listSources', { type: 0 }),
      this.call('listPresets', { ScreenDest: -1, AuxDest: -1 }),
      this.call('listDestinations', { type: 0 })
    ]);
    const power = await this.call('powerStatus').then(parsePower, () => []);
    this.frame = parseFrames(frame, power, this.host);
    for (const f of this.frame.frames) this.seenFrames.set(f.id, f.name);
    const lost = [...this.seenFrames].filter(([id]) => !this.frame!.frames.some((f) => f.id === id)).map(([, name]) => name);
    this.warnings = frameWarnings(this.frame, lost);
    this.sources = parseSources(sources);
    this.presets = parsePresets(presets);
    const { screens, auxes } = parseDestinations(dests);
    // Keep what was read of a destination's content until it is read again.
    this.screens = screens.map((d) => {
      const old = this.screens.find((x) => x.id === d.id);
      return old ? { ...old, name: d.name, width: d.width, height: d.height, outputs: d.outputs } : d;
    });
    this.auxes = auxes.map((d) => this.auxes.find((x) => x.id === d.id) ?? d);
    for (const t of [this.pvw, this.pgm]) {
      const p = t && this.presets.find((x) => x.id === t.marker.preset);
      if (t && p) t.marker.name = p.name;
    }
  }

  private sig(which: 'preview' | 'program'): string {
    return JSON.stringify([...this.screens, ...this.auxes].map((d) => [d.kind, d.id, d[which].map((l) => [l.layer, l.source])]));
  }

  /** Drops a preset marker once the content it describes has been changed from elsewhere. */
  private track(): void {
    const now = Date.now();
    for (const which of ['preview', 'program'] as const) {
      const t = which === 'preview' ? this.pvw : this.pgm;
      if (!t) continue;
      const sig = this.sig(which);
      if (now < t.settleUntil) t.sig = sig;
      else if (sig !== t.sig) {
        if (which === 'preview') this.pvw = null;
        else this.pgm = null;
      }
    }
  }

  private settleMs(): number {
    const frames = Math.max(0, ...this.screens.map((d) => d.transitionFrames ?? 0));
    return Math.ceil((frames / 24) * 1000) + this.o.pollMs * 2;
  }

  private authParams(): object {
    const a = this.o.auth();
    if (a.password) return { password: a.password };
    if (a.operatorId >= 0) return { operatorId: a.operatorId };
    return {};
  }

  private async command(method: string, params: object): Promise<void> {
    if (!this.ready) throw new E2Error('not connected');
    this.busy = true;
    this.emit('change');
    try {
      await this.call(method, { ...params, ...this.authParams() });
    } finally {
      this.busy = false;
    }
  }

  /** Recalls a preset to preview (type 0). */
  async recallPreset(id: number): Promise<void> {
    const p = this.presets.find((x) => x.id === id);
    if (!p) throw new E2Error('no such preset');
    await this.command('activatePreset', { id, type: 0 });
    this.pvw = { marker: { preset: p.id, name: p.name }, sig: '', settleUntil: Date.now() + this.o.pollMs * 2 };
    await this.refresh();
  }

  /** Transitions every armed destination from preview to program, with its own transition time. */
  async take(cut = false): Promise<void> {
    await this.command(cut ? 'cut' : 'allTrans', {});
    const until = Date.now() + (cut ? this.o.pollMs * 2 : this.settleMs());
    this.pgm = this.pvw ? { marker: { ...this.pvw.marker }, sig: '', settleUntil: until } : null;
    if (this.pvw) this.pvw.settleUntil = until;
    await this.refresh();
  }

  private setStatus(c: Connection, text: string): void {
    if (c === this.connection && text === this.statusText) return;
    this.connection = c;
    this.statusText = text;
    this.emit('status', c, text);
  }
}
