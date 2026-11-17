// The module against the simulator and the SDK's fake controller: start, restore and reconnect only
// read; commands only on an operator action with Allow controls on; keys; logins as secrets.
import { startTestModule, type TestModule } from '@rcs/module-sdk/testing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import mod, { KEY, type Config, type State } from '../src/index.js';
import { SimE2 } from '../src/sim/e2.js';

let sim: TestModule<State, Config> | null = null;
let e2: SimE2 | null = null;

beforeAll(() => {
  process.env.RCS_E2_POLL_MS = '50';
});
afterEach(async () => {
  await sim?.close();
  await e2?.close();
  sim = null;
  e2 = null;
});

async function until(check: () => boolean, ms = 4000): Promise<void> {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() > end) throw new Error(`timed out ${sim?.errors.map(String)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const last = () => (sim ? [...sim.uiMessages].reverse().find((m) => m.message?.type === 'snapshot')?.message : null);

async function start(extra: { config?: Partial<Config>; state?: State; reason?: 'boot' | 'restore' | 'user'; secrets?: Record<string, unknown> } = {}) {
  e2 = new SimE2();
  const port = await e2.listen(0);
  sim = await startTestModule(mod, {
    config: { address: '127.0.0.1', port, operatorId: -1, allowControls: true, ...extra.config },
    state: extra.state,
    reason: extra.reason,
    secrets: extra.secrets
  });
  await until(() => sim!.status?.connection === 'connected' && last()?.ready);
  await sim.settle();
  return sim;
}

describe('module', () => {
  for (const reason of ['boot', 'restore', 'user'] as const) {
    it(`only reads on a ${reason} start`, async () => {
      await start({ reason, state: { presetPage: 1 } });
      await new Promise((r) => setTimeout(r, 200));
      expect(e2!.commands).toEqual([]);
      expect(sim!.state).toEqual({ presetPage: 1 });
    });
  }

  it('puts presets on keys, recalls to preview and takes', async () => {
    await start();
    expect(sim!.keys[0]).toMatchObject({ label: 'WALK IN' });
    expect(sim!.keys[KEY.PAGE]).toMatchObject({ label: 'MORE ▶', sublabel: 'page 1/2' });
    await sim!.press(3);
    expect(e2!.commands.at(-1)).toMatchObject({ method: 'activatePreset', params: { id: 3, type: 0 } });
    await until(() => sim!.keys[3]?.sublabel === 'PREVIEW');
    expect(sim!.keys[KEY.PVW]).toMatchObject({ sublabel: 'PANEL' });
    expect(sim!.keys[KEY.TAKE]).toMatchObject({ label: 'TAKE', sublabel: 'PANEL' });
    await sim!.press(KEY.TAKE);
    expect(e2!.commands.at(-1)!.method).toBe('allTrans');
    await until(() => sim!.keys[KEY.PGM]?.sublabel === 'PANEL');
    const imag = last().dests.find((d: any) => d.name === 'IMAG L');
    expect(imag.programText).toBe('CAM 3');
    // a screen background is named from the background sources, an aux from all sources
    const wall = last().dests.find((d: any) => d.name === 'LED WALL');
    expect(wall.program.find((l: any) => l.layer === null).name).toBe('LOGO');
    expect(last().dests.find((d: any) => d.name === 'CONF MON').programText).toBe('GFX 2');
  });

  it('cuts only on a hold', async () => {
    await start();
    await sim!.press(KEY.CUT);
    expect(e2!.commands).toEqual([]);
    await sim!.press(KEY.CUT, { holdMs: 800 });
    expect(e2!.commands.at(-1)!.method).toBe('cut');
  });

  it('pages presets', async () => {
    await start();
    await sim!.press(KEY.PAGE);
    expect(sim!.state.presetPage).toBe(1);
    expect(sim!.keys[0]).toMatchObject({ label: 'SPONSORS' });
    await sim!.press(KEY.PAGE);
    expect(sim!.state.presetPage).toBe(0);
  });

  it('sends nothing with Allow controls off', async () => {
    await start({ config: { allowControls: false } });
    await sim!.press(1);
    await sim!.press(KEY.TAKE);
    await sim!.sendUi({ type: 'recall', id: 2 });
    await sim!.sendUi({ type: 'cut' });
    expect(e2!.commands).toEqual([]);
    expect(sim!.notifications.at(-1)!.text).toMatch(/Allow controls/);
    expect(sim!.keys[KEY.TAKE]).toMatchObject({ sublabel: 'controls off' });
  });

  it('keeps the password as a secret, never in the snapshot, and sends it', async () => {
    await start();
    e2!.password = 'pw123';
    await sim!.sendUi({ type: 'password', password: 'pw123' });
    expect(sim!.secrets).toEqual({ password: 'pw123' });
    expect(JSON.stringify(sim!.uiMessages)).not.toContain('pw123');
    expect(last().passwordSet).toBe(true);
    await sim!.sendUi({ type: 'recall', id: 1 });
    expect(e2!.commands.at(-1)!.params).toMatchObject({ password: 'pw123' });
    await sim!.sendUi({ type: 'password', password: '' });
    expect(sim!.secrets).toEqual({});
  });

  it('uses a password restored with a save', async () => {
    await start({ secrets: { password: 'from-save' } });
    await sim!.press(0);
    expect(e2!.commands.at(-1)!.params).toMatchObject({ password: 'from-save' });
  });

  it('checks Setup input and reconnects only by reading', async () => {
    await start();
    await sim!.sendUi({ type: 'config', config: { address: 'bad address!' } });
    expect(sim!.notifications.at(-1)!.level).toBe('warning');
    await sim!.sendUi({ type: 'config', config: { operatorId: 2 } });
    expect(sim!.config.operatorId).toBe(2);
    await sim!.sendUi({ type: 'reconnect' });
    await until(() => last()?.ready);
    expect(e2!.commands).toEqual([]);
  });

  it('shows offline keys when the processor goes away', async () => {
    await start();
    e2!.silent = true;
    await until(() => sim!.keys[KEY.PGM]?.label === 'OFFLINE', 8000);
    await sim!.press(0);
    expect(e2!.commands).toEqual([]);
  });
});
