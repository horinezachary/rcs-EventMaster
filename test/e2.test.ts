// The JSON-RPC client and parsers against the simulator and against the manual's shapes.
import { afterEach, describe, expect, it } from 'vitest';
import { applyContent, frameWarnings, parseDestinations, parseFrame, parseFrames, parsePower, parsePresets, rpc, type ScreenDest } from '../src/e2.js';
import { Processor } from '../src/processor.js';
import { SimE2 } from '../src/sim/e2.js';

let e2: SimE2 | null = null;
let proc: Processor | null = null;
afterEach(async () => {
  proc?.stop();
  await e2?.close();
  e2 = null;
  proc = null;
});

async function until(check: () => boolean, ms = 4000): Promise<void> {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function start(opts: { bare?: boolean } = {}) {
  e2 = new SimE2();
  e2.bare = !!opts.bare;
  const port = await e2.listen(0);
  proc = new Processor('127.0.0.1', port, { pollMs: 50, timeoutMs: 400 });
  proc.start();
  await until(() => proc!.ready);
  return port;
}

describe('parsers', () => {
  it('reads layers on program and preview, background last, by z order', () => {
    const d = parseDestinations({ ScreenDestination: [{ id: 0, Name: 'Wall', HSize: 3840, VSize: 1080 }], AuxDestination: [{ id: 0, AuxStreamMode: 0 }] });
    expect(d.auxes[0]!.name).toBe('Aux 1');
    const s = d.screens[0] as ScreenDest;
    applyContent(s, {
      BGLyr: [{ id: 0, LastBGSourceIndex: 12 }, { id: 1, LastBGSourceIndex: -1 }],
      Layers: [
        { id: 0, Name: 'Layer1-A', LastSrcIdx: 3, PgmMode: 1, PvwMode: 0, PgmZOrder: 1 },
        { id: 1, Name: 'Layer1-B', LastSrcIdx: 5, PgmMode: 0, PvwMode: 1, PvwZOrder: 0 },
        { id: 2, Name: 'Layer2-A', LastSrcIdx: 7, PgmMode: 1, PvwMode: 1, PgmZOrder: 0, PvwZOrder: 1 }
      ],
      Transition: [{ id: 0, TransTime: 30 }]
    });
    expect(s.program.map((l) => [l.layer, l.source])).toEqual([[null, 12], ['Layer2-A', 7], ['Layer1-A', 3]]);
    expect(s.preview.map((l) => [l.layer, l.source])).toEqual([['Layer1-B', 5], ['Layer2-A', 7]]);
    expect(s.transitionFrames).toBe(30);
  });

  it('sorts presets by preset number and reads frame and power', () => {
    expect(parsePresets([{ id: 4, Name: 'B', presetSno: 2.01 }, { id: 1, Name: 'A', presetSno: 1, LockMode: 1 }]).map((p) => [p.name, p.locked])).toEqual([['A', true], ['B', false]]);
    expect(parseFrame({ System: { Name: 'Main', FrameCollection: { Frame: { FrameType: 5, Version: '9.2' } } } })).toMatchObject({ name: 'Main', model: 'E2 Gen 2', version: '9.2' });
    expect(parsePower({ 'aa:bb': { PwrStatus1: 3, PwrStatus2: 1 } })).toEqual([{ frame: 'aa:bb', supply: 1, status: 3 }, { frame: 'aa:bb', supply: 2, status: 1 }]);
  });
});

describe('multi-frame systems', () => {
  const frame = (n: number, extra: object = {}) => ({
    id: `00:0b:ab:00:00:0${n}`,
    Name: `FRAME ${n}`,
    Version: '9.2.0.12',
    FrameType: 0,
    Enet: { IP: `10.0.0.${n}` },
    SysCard: { CardStatusLabel: 'OK', CardTypeLabel: 'System' },
    Slot: [{ id: 0, Card: { CardStatusLabel: 'OK', CardTypeLabel: 'Input SDI' } }, { id: 1, Card: { CardStatusLabel: 'Empty', CardTypeLabel: 'Empty' } }],
    ...extra
  });

  it('reads every frame from an array, with cards, power and the host', () => {
    const power = parsePower({ '00:0b:ab:00:00:01': { PwrStatus1: 3, PwrStatus2: 3 }, '00:0B:AB:00:00:02': { PwrStatus1: 1, PwrStatus2: 3 } });
    const info = parseFrames({ System: { Name: 'Show', FrameCollection: { Frame: [frame(1), frame(2, { Version: '9.1.0.4' })] } } }, power, '10.0.0.2');
    expect(info.frames.map((f) => [f.name, f.host, f.power.map((p) => p.status)])).toEqual([
      ['FRAME 1', false, [3, 3]],
      ['FRAME 2', true, [1, 3]]
    ]);
    expect(info.frames[0]!.cards.map((c) => `${c.slot} ${c.type}`)).toEqual(['Sys System', '1 Input SDI']);
    expect(info.version).toBe('9.1.0.4');
    expect(frameWarnings(info)).toEqual([
      'Frames run different software: FRAME 1 9.2.0.12, FRAME 2 9.1.0.4',
      'FRAME 2: power supply 1 has no power cable'
    ]);
  });

  it('reads a collection given as an array, and flags a failed card and a lost frame', () => {
    const info = parseFrames({ System: { FrameCollection: [{ Frame: frame(1) }, { Frame: frame(2, { Slot: [{ id: 2, Card: { CardStatusLabel: 'Failed', CardTypeLabel: 'Output HDMI' } }] }) }] } });
    expect(info.frames.length).toBe(2);
    expect(info.frames[0]!.host).toBe(true);
    expect(frameWarnings(info, ['FRAME 3'])).toEqual(['FRAME 3 is no longer in the system', 'FRAME 2: slot 3 Output HDMI: Failed']);
  });

  it('gives a single frame the power supplies even when the ids differ', () => {
    const info = parseFrames({ System: { FrameCollection: { Frame: frame(1) } } }, parsePower({ other: { PwrStatus1: 3 } }));
    expect(info.frames.length).toBe(1);
    expect(info.frames[0]!.power).toEqual([{ supply: 1, status: 3 }]);
  });

  it('notices a frame dropping out of the system and coming back', async () => {
    e2 = new SimE2();
    e2.setFrames(3);
    const port = await e2.listen(0);
    proc = new Processor('127.0.0.1', port, { pollMs: 30, slowEvery: 1 });
    proc.start();
    await until(() => proc!.ready);
    expect(proc.frame!.frames.map((f) => [f.name, f.host])).toEqual([['FRAME 1', true], ['FRAME 2', false], ['FRAME 3', false]]);
    expect(proc.warnings).toEqual([]);
    expect(proc.statusText).toMatch(/3 frames$/);
    e2.frames[2]!.present = false;
    e2.frames[1]!.psu[0] = 2;
    // Warnings are set mid-read, the status at its end: wait for the status.
    await until(() => /2 warnings$/.test(proc!.statusText));
    expect(proc.warnings).toEqual(['FRAME 3 is no longer in the system', 'FRAME 2: power supply 1 has no DC output']);
    e2.frames[2]!.present = true;
    e2.frames[1]!.psu[0] = 3;
    await until(() => proc!.warnings.length === 0);
    expect(e2.commands).toEqual([]);
  });
});

describe('client', () => {
  it('unwraps the answer and reports refusals', async () => {
    e2 = new SimE2();
    const port = await e2.listen(0);
    const presets = await rpc(`127.0.0.1`, port, 'listPresets', {});
    expect(presets.length).toBe(13);
    await expect(rpc('127.0.0.1', port, 'noSuchMethod')).rejects.toThrow(/refused/);
    e2.bare = true;
    expect((await rpc('127.0.0.1', port, 'listPresets', {})).length).toBe(13);
  });

  it('reads everything without sending a command', async () => {
    await start();
    expect(proc!.screens.map((d) => d.name)).toEqual(['LED WALL', 'IMAG L', 'IMAG R']);
    expect(proc!.screens[1]!.program.map((l) => l.source)).toEqual([0]);
    expect(proc!.auxes.map((d) => d.program[0]!.source)).toEqual([0, 0, 6]);
    expect(proc!.frame).toMatchObject({ model: 'E2', name: 'MAIN' });
    expect(e2!.commands).toEqual([]);
  });

  it('works when the processor leaves out the success wrapper', async () => {
    await start({ bare: true });
    expect(proc!.presets.length).toBe(13);
  });

  it('recalls to preview, takes to program, and forgets a marker changed from elsewhere', async () => {
    await start();
    await proc!.recallPreset(3);
    expect(e2!.commands.at(-1)).toMatchObject({ method: 'activatePreset', params: { id: 3, type: 0 } });
    expect(proc!.previewPreset?.name).toBe('PANEL');
    expect(proc!.screens[1]!.preview.map((l) => l.source)).toEqual([2]);
    expect(proc!.screens[1]!.program.map((l) => l.source)).toEqual([0]);
    await proc!.take();
    expect(e2!.commands.at(-1)!.method).toBe('allTrans');
    expect(proc!.programPreset?.name).toBe('PANEL');
    expect(proc!.screens[1]!.program.map((l) => l.source)).toEqual([2]);
    // let the take settle, then someone recalls another preset at the E2's own console
    await new Promise((r) => setTimeout(r, 1700));
    expect(proc!.previewPreset?.name).toBe('PANEL');
    e2!.recall(5, 0);
    await until(() => proc!.previewPreset === null);
    expect(proc!.programPreset?.name).toBe('PANEL');
    e2!.recall(6, 1);
    await until(() => proc!.programPreset === null);
  });

  it('sends the operator or the super-operator password', async () => {
    e2 = new SimE2();
    e2.password = 'secret';
    const port = await e2.listen(0);
    let pw = '';
    proc = new Processor('127.0.0.1', port, { pollMs: 50, auth: () => ({ operatorId: 1, password: pw }) });
    proc.start();
    await until(() => proc!.ready);
    await expect(proc.recallPreset(1)).rejects.toThrow(/refused/);
    expect(e2.commands.at(-1)!.params).toMatchObject({ operatorId: 1 });
    pw = 'secret';
    await proc.recallPreset(1);
    expect(e2.commands.at(-1)!.params).toMatchObject({ password: 'secret' });
  });

  it('goes offline when the processor stops answering and comes back', async () => {
    await start();
    e2!.silent = true;
    await until(() => !proc!.ready);
    expect(proc!.connection).toBe('disconnected');
    e2!.silent = false;
    await until(() => proc!.ready);
  });
});
