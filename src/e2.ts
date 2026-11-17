// Barco Event Master (E2, S3-4K, EX) JSON-RPC client and the shapes the module reads.
//
// The processor answers JSON-RPC 2.0 over HTTP POST on port 9999 (Barco "JSON RPC for Event Master
// processors", v9.2). Every answer is {result: {success: 0, response: ...}}; success other than 0 is
// an error. Some firmware and the manual's own examples leave the wrapper out, so both are accepted.
// The API has no login: in multi-operator mode a call names its operator (operatorId 0-2), and a
// super operator passes the password on the calls that change the show (activatePreset, allTrans,
// cut, savePreset, deletePreset).

import http from 'node:http';

export const DEFAULT_PORT = 9999;

export class E2Error extends Error {
  constructor(
    message: string,
    readonly code?: number
  ) {
    super(message);
  }
}

export interface CallOptions {
  timeoutMs?: number;
}

let nextId = 1;

/** One JSON-RPC call. Resolves with the response payload, rejects with E2Error. */
export function rpc<T = any>(host: string, port: number, method: string, params: object = {}, opts: CallOptions = {}): Promise<T> {
  const body = JSON.stringify({ params, method, id: String(nextId++), jsonrpc: '2.0' });
  return new Promise<T>((resolve, reject) => {
    const req = http.request(
      { host, port, path: '/', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: opts.timeoutMs ?? 3000 },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > 8 * 1024 * 1024) req.destroy(new E2Error('answer too large'));
          else chunks.push(c);
        });
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 400) return reject(new E2Error(`HTTP ${res.statusCode}`));
          let j: any;
          try {
            j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            return reject(new E2Error('not a JSON-RPC answer'));
          }
          if (j?.error) return reject(new E2Error(typeof j.error === 'object' ? String(j.error.message ?? JSON.stringify(j.error)) : String(j.error)));
          const r = j && typeof j === 'object' && 'result' in j ? j.result : j;
          if (r && typeof r === 'object' && 'success' in r) {
            if (r.success !== 0) return reject(new E2Error(`${method} refused (code ${r.success})`, Number(r.success)));
            return resolve(r.response as T);
          }
          resolve(r as T);
        });
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new E2Error('did not answer')));
    req.on('error', (e) => reject(e instanceof E2Error ? e : new E2Error(e.message)));
    req.end(body);
  });
}

// ---- the shapes the module keeps (normalised from the processor's answers) ---------------------

/** listSources InputCfgVideoStatus. */
export const VIDEO_STATUS: Record<number, string> = { 0: 'No lock', 1: 'OK', 2: 'Format mismatch', 3: 'Out of range', 4: 'No sync' };
/** listSources SrcType. */
export const SOURCE_TYPE: Record<number, string> = { 0: 'Input', 1: 'Background', 2: 'Destination', 3: 'Key' };

export interface Source {
  id: number;
  name: string;
  type: number;
  width: number;
  height: number;
  /** InputCfgVideoStatus, or null for sources that are not inputs. */
  video: number | null;
  frozen: boolean;
}

export interface Preset {
  id: number;
  name: string;
  /** presetSno, e.g. 3.01 */
  number: number;
  locked: boolean;
}

export interface LayerUse {
  /** "Layer1-A" from the processor; null for the background. */
  layer: string | null;
  source: number;
  frozen: boolean;
}

export interface ScreenDest {
  kind: 'screen';
  id: number;
  name: string;
  width: number;
  height: number;
  /** The background (layer null, an index among the background sources) if one shows, then layers bottom first. */
  program: LayerUse[];
  preview: LayerUse[];
  transitionFrames: number | null;
  read: boolean;
}

export interface AuxDest {
  kind: 'aux';
  id: number;
  name: string;
  program: LayerUse[];
  preview: LayerUse[];
  read: boolean;
}

export type Dest = ScreenDest | AuxDest;

export interface FrameInfo {
  name: string;
  model: string;
  version: string;
  ip: string;
  /** Per supply, 'OK' or what is wrong, from powerStatus; empty when unknown. */
  power: { frame: string; supply: number; status: number }[];
}

export const POWER_STATUS: Record<number, string> = { 0: 'No supply', 1: 'No power cable', 2: 'No DC output', 3: 'OK' };
const FRAME_TYPE: Record<number, string> = { 0: 'E2', 1: 'S3-4K', 2: 'EX', 3: 'IP-4K', 5: 'E2 Gen 2', 6: 'PDS-4K' };

const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const num = (v: unknown, d = -1): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : d);
/** listStill and some other answers give numbers as {Min, Max, $t}. */
const val = (v: unknown, d = -1): number => (v && typeof v === 'object' && '$t' in (v as any) ? num((v as any).$t, d) : num(v, d));

export function parseSources(r: unknown): Source[] {
  return arr(r).map((s) => {
    const type = num(s.SrcType ?? s['Src-Type'], 0);
    return {
      id: num(s.id),
      name: str(s.Name, `Source ${num(s.id) + 1}`),
      type,
      width: val(s.HSize, 0),
      height: val(s.VSize, 0),
      video: type === 0 && s.InputCfgVideoStatus !== undefined ? num(s.InputCfgVideoStatus) : null,
      frozen: num(s.Freeze, 0) === 1
    };
  }).filter((s) => s.id >= 0);
}

export function parsePresets(r: unknown): Preset[] {
  return arr(r)
    .map((p) => ({ id: num(p.id), name: str(p.Name, `Preset ${num(p.id) + 1}`), number: num(p.presetSno, num(p.id) + 1), locked: num(p.LockMode, 0) !== 0 }))
    .filter((p) => p.id >= 0)
    .sort((a, b) => a.number - b.number || a.id - b.id);
}

export function parseDestinations(r: any): { screens: ScreenDest[]; auxes: AuxDest[] } {
  const screens: ScreenDest[] = arr(r?.ScreenDestination).map((d) => ({
    kind: 'screen',
    id: num(d.id),
    name: str(d.Name, `Screen ${num(d.id) + 1}`),
    width: num(d.HSize, 0),
    height: num(d.VSize, 0),
    program: [],
    preview: [],
    transitionFrames: null,
    read: false
  }));
  const auxes: AuxDest[] = arr(r?.AuxDestination).map((d) => ({ kind: 'aux', id: num(d.id), name: str(d.Name, `Aux ${num(d.id) + 1}`), program: [], preview: [], read: false }));
  return { screens: screens.filter((d) => d.id >= 0), auxes: auxes.filter((d) => d.id >= 0) };
}

/** listContent for one screen destination: which sources its layers show on program and preview. */
export function applyContent(d: ScreenDest, r: any): void {
  if (typeof r?.Name === 'string' && r.Name) d.name = r.Name;
  const layers = arr(r?.Layers);
  const on = (mode: 'PgmMode' | 'PvwMode', z: 'PgmZOrder' | 'PvwZOrder'): LayerUse[] =>
    layers
      .filter((l) => num(l[mode], 0) === 1 && num(l.LastSrcIdx) >= 0)
      .sort((a, b) => num(a[z], 0) - num(b[z], 0) || num(a.id) - num(b.id))
      .map((l) => ({ layer: str(l.Name, `Layer ${num(l.id) + 1}`), source: num(l.LastSrcIdx), frozen: num(l.Freeze, 0) === 1 }));
  // BGLyr id 0 is the background on program, id 1 on preview.
  const bg = (id: number): LayerUse[] => {
    const b = arr(r?.BGLyr).find((x) => num(x.id) === id);
    const src = num(b?.LastBGSourceIndex ?? b?.LastBGSoureIndex);
    return b && src >= 0 ? [{ layer: null, source: src, frozen: false }] : [];
  };
  d.program = [...bg(0), ...on('PgmMode', 'PgmZOrder')];
  d.preview = [...bg(1), ...on('PvwMode', 'PvwZOrder')];
  const t = arr(r?.Transition)[0];
  d.transitionFrames = t ? num(t.TransTime, -1) : null;
  if (d.transitionFrames !== null && d.transitionFrames < 0) d.transitionFrames = null;
  d.read = true;
}

export function applyAuxContent(d: AuxDest, r: any): void {
  if (typeof r?.Name === 'string' && r.Name) d.name = r.Name;
  const one = (v: unknown): LayerUse[] => (num(v) >= 0 ? [{ layer: null, source: num(v), frozen: false }] : []);
  d.program = one(r?.PgmLastSrcIndex ?? r?.PgmLastSrcIdx);
  d.preview = one(r?.PvwLastSrcIndex ?? r?.PvwLastSrcIdx);
  d.read = true;
}

export function parseFrame(r: any): Omit<FrameInfo, 'power'> {
  const sys = r?.System ?? r ?? {};
  let frame = sys?.FrameCollection?.Frame;
  if (Array.isArray(frame)) frame = frame[0];
  frame = frame ?? {};
  const type = num(frame.FrameType);
  return {
    name: str(sys.Name) || str(frame.Name),
    model: str(frame.FrameTypeName) || FRAME_TYPE[type] || 'Event Master',
    version: str(frame.Version),
    ip: str(frame.Enet?.IP)
  };
}

export function parsePower(r: any): FrameInfo['power'] {
  const out: FrameInfo['power'] = [];
  if (!r || typeof r !== 'object') return out;
  for (const [frame, v] of Object.entries(r)) {
    if (!v || typeof v !== 'object') continue;
    for (const [k, s] of Object.entries(v as object)) {
      const m = /^PwrStatus(\d+)$/.exec(k);
      if (m) out.push({ frame, supply: Number(m[1]), status: num(s) });
    }
  }
  return out;
}
