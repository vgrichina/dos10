// Browser front end. Mirrors test/boot_smoke.js but uses fetch() for the
// IMD and pipes BIOSIN/OUT to the DOM.

import { createMemory } from '../tools/core/memory.js';
import { createCPU } from '../tools/core/cpu.js';
import { installBios, patchBiosImpls, makeBiosBus, BIOS_NAMES } from '../tools/core/scp_bios.js';
import { createImdDisk } from '../tools/core/disk_imd.js';

const term   = document.getElementById('term');
const status = document.getElementById('status');

function log(msg) { status.textContent = msg; }

(async function main() {
  log('fetching disk image…');
  const buf = new Uint8Array(await (await fetch('../assets/86dos114-tarbell-dd.imd')).arrayBuffer());
  const disk = createImdDisk(buf);
  const G = disk.geometry;
  log(`${G.cylinders}c × ${G.heads}h × ${G.sectorsPerTrack}s × ${G.sectorSize}B`);

  const mem = createMemory();

  // Load loader+BIOS at 40:0 (sectors 2..26 of cyl 0 + all of cyl 1).
  let addr = 0x0400;
  for (let c = 0; c <= 1; c++) {
    for (let s = (c === 0 ? 2 : 1); s <= G.sectorsPerTrack; s++) {
      const sec = disk.sector(c, 0, s);
      if (!sec) continue;
      for (let i = 0; i < sec.length; i++) mem.buf[(addr + i) & 0xFFFFF] = sec[i];
      addr += sec.length;
    }
  }
  installBios(mem);
  patchBiosImpls(mem, [0x01A1, 0x01A6, 0x01B1, 0x01BC, 0x01C7, 0x01D0, 0x01ED, 0x0200, 0x01DB]);

  const SPT = G.sectorsPerTrack;
  const lrToCHS = (lr) => ({ c: (lr / SPT) | 0, h: 0, s: (lr % SPT) + 1 });

  const inputQ = []; // queue of byte codes from keyboard
  let cpuIdle = false; // set by IN when blocked on empty queue
  let outBuf = '';   // text written by BIOSOUT this frame; flushed in tick()

  const handlers = {
    STAT(r)   { r.ax = (r.ax & 0xFF00) | (inputQ.length ? 0xFF : 0x00); },
    IN  (r)   {
      if (!inputQ.length) {
        // BIOSIN must block. Rewind past the `CD vv` trampoline bytes so the
        // INT re-fires on the next step; meanwhile the JS event loop can run
        // and deliver keystrokes.
        r.ip = (r.ip - 2) & 0xFFFF;
        cpuIdle = true;
        return;
      }
      r.ax = (r.ax & 0xFF00) | inputQ.shift();
    },
    OUT (r)   {
      const b = r.ax & 0xFF;
      const ch = (b === 0x0D) ? '\n'
               : (b === 0x0A) ? ''
               : (b < 0x20 || b > 0x7E) ? ''
               : String.fromCharCode(b);
      outBuf += ch;
    },
    PRINT() {},
    AUXIN(r)  { r.ax = (r.ax & 0xFF00) | 0x1A; },
    AUXOUT() {},
    READ(r)   {
      const drive = r.ax & 0xFF, lr = r.dx & 0xFFFF, n = r.cx & 0xFFFF;
      const lin = ((r.ds << 4) + r.bx) & 0xFFFFF;
      const { c, s } = lrToCHS(lr);
      const ok = disk.read(drive, c, s, n, lin, mem);
      if (ok) r.flags &= ~1; else r.flags |= 1;
    },
    WRITE(r)  {
      const drive = r.ax & 0xFF, lr = r.dx & 0xFFFF, n = r.cx & 0xFFFF;
      const lin = ((r.ds << 4) + r.bx) & 0xFFFFF;
      const { c, s } = lrToCHS(lr);
      const ok = disk.write(drive, c, s, n, lin, mem);
      if (ok) r.flags &= ~1; else r.flags |= 1;
    },
    DSKCHG(r) { r.ax = (r.ax & 0xFF00) | 0; r.flags &= ~1; },
  };
  const bus = makeBiosBus(handlers, mem);

  const cpu = createCPU(mem, bus);
  cpu.r.cs = 0x0040; cpu.r.ip = 0x0000;
  cpu.r.ds = 0; cpu.r.es = 0;
  cpu.r.ss = 0; cpu.r.sp = 0x0400;

  // Keyboard plumbing.
  document.addEventListener('keydown', (e) => {
    let b = null;
    if (e.key === 'Enter')  b = 0x0D;
    else if (e.key === 'Backspace') b = 0x08;
    else if (e.key === 'Tab') b = 0x09;
    else if (e.key === 'Escape') b = 0x1B;
    else if (e.ctrlKey && e.key.length === 1) b = e.key.toUpperCase().charCodeAt(0) & 0x1F;
    else if (e.key.length === 1) b = e.key.charCodeAt(0) & 0xFF;
    if (b !== null) {
      inputQ.push(b);
      if (cpuIdle) { cpuIdle = false; requestAnimationFrame(tick); }
      e.preventDefault();
    }
  });
  term.focus();

  // Run CPU in chunks so the browser stays responsive.
  log('booting…');
  const STEPS_PER_TICK = 200_000;
  let totalSteps = 0;
  function flush() {
    if (outBuf) {
      term.textContent += outBuf;
      outBuf = '';
      term.scrollTop = term.scrollHeight;
    }
  }
  function tick() {
    try {
      let i = 0;
      for (; i < STEPS_PER_TICK; i++) {
        cpu.step();
        if (cpuIdle) break;
      }
      totalSteps += i;
      flush();
      log(`${cpuIdle ? 'idle (waiting for key)' : 'running'} — ${(totalSteps / 1e6).toFixed(1)}M steps cs:ip=${cpu.r.cs.toString(16)}:${cpu.r.ip.toString(16)}`);
    } catch (e) {
      flush();
      log(`stopped: ${e.message}`);
      console.error(e);
      return;
    }
    if (!cpuIdle) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})().catch(e => { log('error: ' + e.message); console.error(e); });
