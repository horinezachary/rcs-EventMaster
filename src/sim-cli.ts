#!/usr/bin/env node
// npm run sim -- [--port 9999] [--host 127.0.0.1] [--password <pw>] [--bare]
// Starts a simulated Event Master processor. Point the module at 127.0.0.1 (and the port).

import { parseArgs } from 'node:util';
import { SimE2 } from './sim/e2.js';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '9999' },
    host: { type: 'string', default: '127.0.0.1' },
    password: { type: 'string', default: '' },
    bare: { type: 'boolean', default: false }
  }
});

const sim = new SimE2();
sim.password = values.password ?? '';
sim.bare = !!values.bare;
const port = await sim.listen(Number(values.port), values.host);
const base = `http://${values.host}:${port}`;
console.log(`Simulated Event Master E2 on ${base}: ${sim.presets.length} presets, ${sim.screens.length} screens, ${sim.auxes.length} aux.`);
console.log(`Another operator recalls a preset: curl '${base}/sim/recall?preset=3'   (type=1 straight to program)`);
console.log(`Input loses sync: curl '${base}/sim/source?id=2&video=4'   Stop answering: curl '${base}/sim/silent?on=1'`);
let last = 0;
setInterval(() => {
  const n = sim.commands.length;
  if (n !== last) console.log(`${n} command(s) received; last: ${JSON.stringify(sim.commands.at(-1))}`);
  last = n;
}, 500);
