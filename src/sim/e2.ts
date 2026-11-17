// A simulated Event Master processor that answers the JSON-RPC methods the module uses, the way the
// Barco manual (v9.2) describes them. For development and tests: nothing here talks to real equipment.
//
// Each screen destination has mixing layers in A/B pairs, like the real processor: the layer showing
// a source on program has PgmMode 1, its partner carries the preview. A preset recall to preview sets
// the preview of the destinations in that preset; allTrans and cut move preview to program.
//
// Development hooks (plain GET, not part of the Event Master API):
//   /sim/recall?preset=<id>&type=0|1   another operator recalls a preset
//   /sim/source?id=<n>&video=4          change an input's video status (4 = no sync, 1 = OK)
//   /sim/silent?on=1                    stop answering (a cable pulled)
//   /sim/password?set=<pw>              require this super-operator password for show changes
//   /sim/frames?n=3                     a system of 3 linked frames (the first is the host)
//   /sim/frame?n=2&present=0            frame 2 drops out of the system (present=1 brings it back)
//   /sim/frame?n=2&psu=1&status=1       frame 2's power supply 1 loses its cable (3 = OK)
//   /sim/frame?n=2&slot=3&card=Failed   frame 2's card in slot 3 reports Failed
//   /sim/frame?n=2&version=9.1.0.4      frame 2 runs other software

import http from 'node:http';
import type { AddressInfo } from 'node:net';

interface Win {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface SimLayer {
  pgm: number;
  pvw: number;
  pgmWin?: Win;
  pvwWin?: Win;
}
interface SimScreen {
  id: number;
  name: string;
  w: number;
  h: number;
  layers: SimLayer[];
  bgPgm: number;
  bgPvw: number;
  transTime: number;
  /** Output map: how the canvas is cut into the processor's outputs. */
  outputs?: (Win & { name: string })[];
  /** Where each layer sits when a preset gives no window. */
  defaultWins?: Win[];
}
interface SimFrame {
  id: string;
  name: string;
  ip: string;
  version: string;
  psu: [number, number];
  /** Slot cards: type and status label. */
  cards: { type: string; status: string }[];
  present: boolean;
}

function makeFrame(i: number): SimFrame {
  return {
    id: `00:0b:ab:00:00:0${i + 1}`,
    name: `FRAME ${i + 1}`,
    ip: `127.0.0.${i + 1}`,
    version: '9.2.0.12',
    psu: [3, 3],
    cards: [
      { type: 'Input 4K DP/HDMI', status: 'OK' },
      { type: 'Input 4K DP/HDMI', status: 'OK' },
      { type: 'Input SDI', status: 'OK' },
      { type: 'Output HDMI', status: 'OK' },
      { type: 'Output HDMI', status: 'OK' },
      { type: 'MVR', status: 'OK' }
    ],
    present: true
  };
}

interface SimAux {
  id: number;
  name: string;
  pgm: number;
  pvw: number;
}
interface SimPreset {
  id: number;
  name: string;
  sno: number;
  locked: boolean;
  /** per screen id: layer sources (-1 = layer off) and background */
  screens: Record<number, { layers: number[]; bg: number; wins?: Win[] }>;
  auxes: Record<number, number>;
}

export interface SimCall {
  method: string;
  params: any;
}

const INPUTS = ['CAM 1', 'CAM 2', 'CAM 3', 'CAM 4', 'PTZ WIDE', 'PTZ TIGHT', 'GFX 1', 'GFX 2', 'PLAYBACK', 'PPT', 'ZOOM', 'BARS'];

export class SimE2 {
  readonly calls: SimCall[] = [];
  silent = false;
  password = '';
  /** Answer without the {success, response} wrapper, as some examples in the manual show. */
  bare = false;
  name = 'MAIN';
  /** The linked frames of the system; the first is the host. setFrames(n) builds a multi-frame system. */
  frames: SimFrame[] = [makeFrame(0)];
  sources = INPUTS.map((name, id) => ({ id, name, video: 1, frozen: false }));
  stills = [{ id: 0, name: 'LOGO' }, { id: 1, name: 'WALK-IN' }];
  screens: SimScreen[] = [
    {
      id: 0,
      name: 'LED WALL',
      w: 3840,
      h: 1080,
      layers: [{ pgm: 6, pvw: 6 }, { pgm: 0, pvw: 0 }, { pgm: -1, pvw: -1 }],
      bgPgm: 0,
      bgPvw: 0,
      transTime: 30,
      outputs: [
        { name: 'WALL L', x: 0, y: 0, w: 1920, h: 1080 },
        { name: 'WALL R', x: 1920, y: 0, w: 1920, h: 1080 }
      ],
      defaultWins: [
        { x: 0, y: 0, w: 3840, h: 1080 },
        { x: 1200, y: 120, w: 1440, h: 810 },
        { x: 2640, y: 200, w: 1080, h: 608 }
      ]
    },
    { id: 1, name: 'IMAG L', w: 1920, h: 1080, layers: [{ pgm: 0, pvw: 0 }, { pgm: -1, pvw: -1 }], bgPgm: -1, bgPvw: -1, transTime: 20 },
    { id: 2, name: 'IMAG R', w: 1920, h: 1080, layers: [{ pgm: 1, pvw: 1 }, { pgm: -1, pvw: -1 }], bgPgm: -1, bgPvw: -1, transTime: 20 }
  ];
  auxes: SimAux[] = [
    { id: 0, name: 'RECORD', pgm: 0, pvw: 0 },
    { id: 1, name: 'STREAM', pgm: 0, pvw: 0 },
    { id: 2, name: 'CONF MON', pgm: 6, pvw: 6 }
  ];
  presets: SimPreset[] = [];
  private server: http.Server | null = null;

  constructor() {
    const P = (id: number, name: string, wall: number[], l: number, r: number, aux: number[], bg = 0): SimPreset => ({
      id,
      name,
      sno: id + 1,
      locked: false,
      screens: { 0: { layers: wall, bg }, 1: { layers: [l, -1], bg: -1 }, 2: { layers: [r, -1], bg: -1 } },
      auxes: { 0: aux[0]!, 1: aux[1]!, 2: aux[2]! }
    });
    this.presets = [
      P(0, 'WALK IN', [-1, -1, -1], 6, 6, [6, 6, 6], 1),
      P(1, 'OPEN', [6, 0, -1], 0, 1, [0, 0, 6]),
      P(2, 'KEYNOTE', [9, 0, -1], 0, 0, [0, 0, 9]),
      P(3, 'PANEL', [7, 2, 3], 2, 3, [2, 2, 7]),
      P(4, 'Q&A', [7, 4, -1], 4, 5, [4, 4, 7]),
      P(5, 'VIDEO', [8, -1, -1], 8, 8, [8, 8, 8]),
      P(6, 'REMOTE', [10, 0, -1], 10, 0, [10, 10, 10]),
      P(7, 'AWARDS', [7, 1, 2], 1, 2, [1, 1, 7]),
      P(8, 'BREAK', [-1, -1, -1], 7, 7, [7, 7, 7], 1),
      P(9, 'LUNCH', [-1, -1, -1], 7, 7, [7, 7, 7], 1),
      P(10, 'SPONSORS', [7, -1, -1], 7, 7, [7, 7, 7]),
      P(11, 'CLOSE', [6, 0, -1], 0, 1, [0, 0, 6]),
      P(12, 'BARS', [11, -1, -1], 11, 11, [11, 11, 11])
    ];
    this.presets[2]!.sno = 3.01;
    // Two speakers side by side over graphics on the wall.
    const sideBySide = [
      { x: 0, y: 0, w: 3840, h: 1080 },
      { x: 160, y: 90, w: 1680, h: 945 },
      { x: 2000, y: 90, w: 1680, h: 945 }
    ];
    this.presets[3]!.screens[0]!.wins = sideBySide;
    this.presets[7]!.screens[0]!.wins = sideBySide;
    // Remote guest: Zoom large, camera in a corner box.
    this.presets[6]!.screens[0]!.wins = [{ x: 0, y: 0, w: 3840, h: 1080 }, { x: 2720, y: 600, w: 800, h: 450 }, { x: 0, y: 0, w: 0, h: 0 }];
    for (const s of this.screens) for (const [i, l] of s.layers.entries()) l.pgmWin = l.pvwWin = this.win(s, i);
    this.presets[12]!.locked = true;
  }

  /** A system of n linked frames, the first the host. */
  setFrames(n: number): void {
    this.frames = Array.from({ length: Math.max(1, Math.min(4, n)) }, (_, i) => makeFrame(i));
  }

  async listen(port = 0, host = '127.0.0.1'): Promise<number> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(port, host, r));
    return (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server!.close(() => r()));
    this.server = null;
  }

  /** Method names received that change the show. */
  get commands(): SimCall[] {
    return this.calls.filter((c) => ['activatePreset', 'allTrans', 'cut', 'changeContent', 'changeAuxContent', 'savePreset', 'deletePreset', 'freezeDestSource'].includes(c.method));
  }

  /** Where layer i of a screen sits when nothing says otherwise. */
  win(s: SimScreen, i: number, preset?: Win[]): Win {
    const p = preset?.[i];
    if (p && p.w > 0) return { ...p };
    if (s.defaultWins?.[i]) return { ...s.defaultWins[i]! };
    if (i === 0) return { x: 0, y: 0, w: s.w, h: s.h };
    // a lower-right box for upper layers of a plain screen
    return { x: Math.round(s.w * 0.62), y: Math.round(s.h * 0.62), w: Math.round(s.w * 0.33), h: Math.round(s.h * 0.33) };
  }

  /** Another operator (or the E2's own console) recalls a preset. */
  recall(id: number, type: 0 | 1): void {
    const p = this.presets.find((x) => x.id === id);
    if (!p) return;
    for (const s of this.screens) {
      const c = p.screens[s.id];
      if (!c) continue;
      s.layers.forEach((l, i) => {
        l.pvw = c.layers[i] ?? -1;
        l.pvwWin = this.win(s, i, c.wins);
      });
      s.bgPvw = c.bg;
      if (type === 1) this.cutScreen(s);
    }
    for (const a of this.auxes) {
      const v = p.auxes[a.id];
      if (v === undefined) continue;
      a.pvw = v;
      if (type === 1) a.pgm = v;
    }
  }

  take(): void {
    for (const s of this.screens) this.cutScreen(s);
    for (const a of this.auxes) a.pgm = a.pvw;
  }

  private cutScreen(s: SimScreen): void {
    for (const l of s.layers) {
      l.pgm = l.pvw;
      l.pgmWin = l.pvwWin;
    }
    s.bgPgm = s.bgPvw;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'GET' && url.pathname.startsWith('/sim/')) return this.hook(url, res);
    if (this.silent) return; // never answers: the client times out
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let j: any;
      try {
        j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400).end();
        return;
      }
      const params = j?.params ?? {};
      this.calls.push({ method: String(j?.method), params });
      let success = 0;
      let response: unknown = null;
      try {
        response = this.method(String(j?.method), params);
      } catch (e) {
        success = typeof (e as any).code === 'number' ? (e as any).code : -1;
      }
      const result = this.bare && success === 0 ? response : { success, response };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', result, id: j?.id ?? null }));
    });
  }

  private refuse(code: number): never {
    throw Object.assign(new Error('refused'), { code });
  }

  private checkPassword(p: any): void {
    if (this.password && p.password !== this.password) this.refuse(-25);
  }

  private frameList(): object[] {
    return this.frames
      .filter((f) => f.present)
      .map((f) => ({
        id: f.id,
        Name: f.name,
        Contact: '',
        Version: f.version,
        OSVersion: '4.19',
        FrameType: 0,
        FrameTypeName: 'E2',
        Enet: { DhcpMode: 0, IP: f.ip, StaticIP: f.ip, MacAddress: f.id },
        SysCard: { SlotState: 1, CardStatusID: 1, CardStatusLabel: 'OK', CardTypeID: 1, CardTypeLabel: 'System', CardID: 0 },
        Slot: f.cards.map((c, i) => ({ id: i, Card: { CardStatusID: c.status === 'OK' ? 1 : 2, CardStatusLabel: c.status, CardTypeID: 2, CardTypeLabel: c.type, CardID: i } }))
      }));
  }

  private method(m: string, p: any): unknown {
    switch (m) {
      case 'getFrameSettings':
        return {
          System: {
            id: 0,
            Name: this.name,
            Simulator: 1,
            // One frame as an object, as in the manual; several as an array.
            FrameCollection: { id: 0, Frame: this.frameList().length === 1 ? this.frameList()[0] : this.frameList() },
            AutoTake: 0
          }
        };
      case 'powerStatus':
        return Object.fromEntries(this.frames.filter((f) => f.present).map((f) => [f.id, { PwrStatus1: f.psu[0], PwrStatus2: f.psu[1] }]));
      case 'listSources':
        return [
          ...this.sources.map((s, i) => ({ id: s.id, Name: s.name, HSize: 1920, VSize: 1080, SrcType: 0, InputCfgIndex: i, StillIndex: -1, DestIndex: -1, UserKeyIndex: -1, Freeze: s.frozen ? 1 : 0, Capacity: 1, InputCfgVideoStatus: s.video })),
          ...this.stills.map((s) => ({ id: this.sources.length + s.id, Name: s.name, HSize: 1920, VSize: 1080, SrcType: 1, InputCfgIndex: -1, StillIndex: s.id, DestIndex: -1, UserKeyIndex: -1, Freeze: 0, Capacity: 1 }))
        ].filter((s) => (Number(p.type) === 1 ? s.SrcType === 1 : true));
      case 'listPresets':
        return this.presets.map((x) => ({ id: x.id, Name: x.name, LockMode: x.locked ? 1 : 0, presetSno: x.sno }));
      case 'listDestinations': {
        const t = Number(p.type ?? 0);
        return {
          ScreenDestination: t === 2 ? [] : this.screens.map((s) => ({ id: s.id, Name: s.name, HSize: s.w, VSize: s.h, Layers: s.layers.length * 2,
            DestOutMapColl: [{ id: 0, DestOutMap: (s.outputs ?? [{ name: s.name, x: 0, y: 0, w: s.w, h: s.h }]).map((o, i) => ({ id: i, Name: o.name, HPos: o.x, VPos: o.y, HSize: o.w, VSize: o.h, Freeze: 0 })) }] })),
          AuxDestination: t === 1 ? [] : this.auxes.map((a) => ({ id: a.id, Name: a.name, AuxStreamMode: 0 }))
        };
      }
      case 'listContent': {
        const s = this.screens.find((x) => x.id === Number(p.id));
        if (!s) this.refuse(-1);
        const layers: any[] = [];
        // Window, Source and Mask hold two entries: id 0 for program and id 1 for preview (as BGLyr).
        const W = (id: number, w?: Win) => ({ id, HPos: w?.x ?? 0, VPos: w?.y ?? 0, HSize: w?.w ?? 0, VSize: w?.h ?? 0 });
        const M = (id: number) => ({ id, Top: 0, Left: 0, Right: 0, Bottom: 0 });
        s.layers.forEach((l, i) => {
          const same = l.pgm === l.pvw && JSON.stringify(l.pgmWin) === JSON.stringify(l.pvwWin);
          const a = { id: i * 2, Name: `Layer${i + 1}-A`, LastSrcIdx: l.pgm, PgmMode: l.pgm >= 0 ? 1 : 0, PvwMode: same && l.pvw >= 0 ? 1 : 0, PgmZOrder: i, PvwZOrder: i, Freeze: 0,
            Window: [W(0, l.pgmWin), W(1, same ? l.pvwWin : l.pgmWin)], Mask: [M(0), M(1)] };
          const b = { id: i * 2 + 1, Name: `Layer${i + 1}-B`, LastSrcIdx: same ? -1 : l.pvw, PgmMode: 0, PvwMode: !same && l.pvw >= 0 ? 1 : 0, PgmZOrder: i, PvwZOrder: i, Freeze: 0,
            Window: [W(0, l.pvwWin), W(1, l.pvwWin)], Mask: [M(0), M(1)] };
          layers.push(a, b);
        });
        return {
          id: s.id,
          Name: s.name,
          IsActive: 1,
          BGLyr: [
            { id: 0, LastBGSourceIndex: s.bgPgm, BGShowMatte: 0, BGColor: [{ id: 0, Red: 0, Green: 0, Blue: 0 }] },
            { id: 1, LastBGSourceIndex: s.bgPvw, BGShowMatte: 0, BGColor: [{ id: 0, Red: 0, Green: 0, Blue: 0 }] }
          ],
          Layers: layers,
          Transition: [{ id: 0, TransTime: s.transTime, TransPos: 0, ArmMode: 1 }],
          OutputCfg: []
        };
      }
      case 'listAuxContent': {
        const a = this.auxes.find((x) => x.id === Number(p.id));
        if (!a) this.refuse(-1);
        return { id: a.id, Name: a.name, PvwLastSrcIndex: a.pvw, PgmLastSrcIndex: a.pgm };
      }
      case 'activatePreset': {
        this.checkPassword(p);
        const x =
          p.id !== undefined ? this.presets.find((q) => q.id === Number(p.id)) : p.presetSno !== undefined ? this.presets.find((q) => q.sno === Number(p.presetSno)) : this.presets.find((q) => q.name === p.presetName);
        if (!x) this.refuse(-1);
        this.recall(x.id, Number(p.type) === 1 ? 1 : 0);
        return null;
      }
      case 'allTrans':
      case 'cut':
        this.checkPassword(p);
        this.take();
        return null;
      default:
        this.refuse(-32601);
    }
  }

  private hook(url: URL, res: http.ServerResponse): void {
    const q = (k: string) => url.searchParams.get(k);
    switch (url.pathname) {
      case '/sim/recall':
        this.recall(Number(q('preset')), q('type') === '1' ? 1 : 0);
        break;
      case '/sim/source': {
        const s = this.sources.find((x) => x.id === Number(q('id')));
        if (s) s.video = Number(q('video') ?? 1);
        break;
      }
      case '/sim/silent':
        this.silent = q('on') === '1';
        break;
      case '/sim/frames':
        this.setFrames(Number(q('n') ?? 1));
        break;
      case '/sim/frame': {
        const f = this.frames[Number(q('n') ?? 1) - 1];
        if (!f) break;
        if (q('present') !== null) f.present = q('present') === '1';
        if (q('psu') !== null) f.psu[Number(q('psu')) - 1] = Number(q('status') ?? 3);
        if (q('slot') !== null && f.cards[Number(q('slot')) - 1]) f.cards[Number(q('slot')) - 1]!.status = q('card') ?? 'OK';
        if (q('version') !== null) f.version = q('version')!;
        break;
      }
      case '/sim/password':
        this.password = q('set') ?? '';
        break;
      default:
        res.writeHead(404).end();
        return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n');
  }
}
