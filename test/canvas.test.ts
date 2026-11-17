// The Screens view draws with canvas.js, which the panel page (ui/) and the web page (web/) each load
// as a sibling file. Keep the two copies the same.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('canvas.js', () => {
  it('is the same in ui/ and web/', () => {
    expect(readFileSync(new URL('../web/canvas.js', import.meta.url), 'utf8')).toBe(readFileSync(new URL('../ui/canvas.js', import.meta.url), 'utf8'));
  });
});
