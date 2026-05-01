// Boots an on-disk 86-DOS image (IMD) under our 8086 + SCP-BIOS shim.
//
// Strategy: run the real on-disk SCP loader at 40:0 (which loads MSDOS
// proper and jumps to 7B:0). The loader talks to the on-disk hardware
// BIOS at 40:01A1+ via direct `CALL FAR 40:xxxx`; we patch INT trampolines
// over those routine entry points so JS handles disk/console I/O without
// us having to emulate Tarbell FDC ports.
//
// Loader's load sequence (gleaned from sector 2 disasm):
//   1. Console init: out 0xF3, F4, F5 — no-ops for us.
//   2. CALL FAR 40:01ED (= BIOSREAD) — reads 56 sectors at LR 0x50 into 7B:0.
//   3. CALL FAR 7B:0000 — enter MSDOS proper.

import { readFileSync } from 'node:fs';
import { createMemory } from '../tools/core/memory.js';
import { createCPU } from '../tools/core/cpu.js';
import { installBios, patchBiosImpls, makeBiosBus, BIOS_NAMES } from '../tools/core/scp_bios.js';
import { createImdDisk } from '../tools/core/disk_imd.js';

const imdPath = process.argv[2] ?? 'assets/86dos114-tarbell-dd.imd';
const disk = createImdDisk(readFileSync(imdPath));
console.log(`disk: ${disk.imdHeader.replace(/\r?\n/g, ' | ').trim()}`);
const G = disk.geometry;
console.log(`geometry: ${G.cylinders}c × ${G.heads}h × ${G.sectorsPerTrack}s × ${G.sectorSize}B`);

const mem = createMemory();

// Load the SCP loader + on-disk BIOS at 40:0 — sectors 2..26 of cyl 0
// plus sectors 1..26 of cyl 1, contiguous from linear 0x0400.
let addr = 0x0400, loaded = 0;
for (let c = 0; c <= 1; c++) {
  for (let s = (c === 0 ? 2 : 1); s <= G.sectorsPerTrack; s++) {
    const sec = disk.sector(c, 0, s);
    if (!sec) continue;
    for (let i = 0; i < sec.length; i++) mem.buf[(addr + i) & 0xFFFFF] = sec[i];
    addr += sec.length; loaded++;
  }
}
console.log(`loaded ${loaded} sectors (${loaded * G.sectorSize} bytes) of loader+BIOS at 40:0`);

// Trampoline the JMP-table at 40:0003..001D (slots used by MSDOS proper
// once it's running — `CALL FAR 40:0015` for BIOSREAD etc.).
installBios(mem);

// Trampoline the actual on-disk routine entries the loader CALLs into.
// Offsets derived from the JMP-table targets in sector 2:
//   slot 0: E9 9B 01 → 0x06 + 0x019B = 0x1A1   STAT
//   slot 1: E9 9D 01 → 0x09 + 0x019D = 0x1A6   IN
//   slot 2: E9 A5 01 → 0x0C + 0x01A5 = 0x1B1   OUT
//   slot 3: E9 AD 01 → 0x0F + 0x01AD = 0x1BC   PRINT
//   slot 4: E9 B5 01 → 0x12 + 0x01B5 = 0x1C7   AUXIN
//   slot 5: E9 BB 01 → 0x15 + 0x01BB = 0x1D0   AUXOUT
//   slot 6: E9 D5 01 → 0x18 + 0x01D5 = 0x1ED   READ
//   slot 7: E9 E5 01 → 0x1B + 0x01E5 = 0x200   WRITE
//   slot 8: E9 BD 01 → 0x1E + 0x01BD = 0x1DB   DSKCHG
patchBiosImpls(mem, [0x01A1, 0x01A6, 0x01B1, 0x01BC, 0x01C7, 0x01D0, 0x01ED, 0x0200, 0x01DB]);

// Adapter so the BIOS shim's `io.disk.{read,write}` (no `mem` arg) can
// reach this run's `mem` via closure.
const diskBound = {
  read:    (drive, track, sec, n, lin) => disk.read (drive, track, sec, n, lin, mem),
  write:   (drive, track, sec, n, lin) => disk.write(drive, track, sec, n, lin, mem),
  changed: (drive) => disk.changed(drive),
};

const SPT = G.sectorsPerTrack;
const lrToCHS = (lr) => ({ c: (lr / SPT) | 0, h: 0, s: (lr % SPT) + 1 });

const stdoutBytes = [];
let inputN = 0;
const calls = Object.fromEntries(BIOS_NAMES.map(n => [n, 0]));
const handlers = {
  STAT(r)   { calls.STAT++;  r.ax = (r.ax & 0xFF00) | 0xFF; },
  IN  (r)   { calls.IN++;    r.ax = (r.ax & 0xFF00) | (inputN++ < 1 ? 0x0D : 0x1A); },
  OUT (r)   { calls.OUT++;   const b = r.ax & 0xFF;
              stdoutBytes.push(b);
              process.stdout.write(String.fromCharCode(b === 0x0D ? 0x0A : b)); },
  PRINT(r)  { calls.PRINT++; },
  AUXIN(r)  { calls.AUXIN++; r.ax = (r.ax & 0xFF00) | 0x1A; },
  AUXOUT(r) { calls.AUXOUT++; },
  READ(r)   { calls.READ++;
              const drive = r.ax & 0xFF;
              const lr = r.dx & 0xFFFF;
              const n  = r.cx & 0xFFFF;
              const lin = ((r.ds << 4) + r.bx) & 0xFFFFF;
              const { c, s } = lrToCHS(lr);
              const ok = diskBound.read(drive, c, s, n, lin);
              if (ok) r.flags &= ~0x0001; else r.flags |= 0x0001;
            },
  WRITE(r)  { calls.WRITE++; r.flags |= 0x0001; }, // ignore writes
  DSKCHG(r) { calls.DSKCHG++; r.ax = (r.ax & 0xFF00) | 0; r.flags &= ~0x0001; },
};
const bus = makeBiosBus(handlers, mem);

const cpu = createCPU(mem, bus);
cpu.r.cs = 0x0040; cpu.r.ip = 0x0000; // run the on-disk loader
cpu.r.ds = 0x0000; cpu.r.es = 0x0000;
cpu.r.ss = 0x0000; cpu.r.sp = 0x0400;

let steps = 0;
const MAX = 2_000_000;
const SAMPLE_EVERY = 200_000;
const pcHistogram = new Map();
try {
  while (steps < MAX) {
    cpu.step(); steps++;
    const pc = (cpu.r.cs << 16) | cpu.r.ip;
    pcHistogram.set(pc, (pcHistogram.get(pc) || 0) + 1);
    if (steps % SAMPLE_EVERY === 0) {
      console.error(`[step ${steps}] cs:ip=${cpu.r.cs.toString(16)}:${cpu.r.ip.toString(16)} ax=${cpu.r.ax.toString(16)} bx=${cpu.r.bx.toString(16)} cx=${cpu.r.cx.toString(16)} dx=${cpu.r.dx.toString(16)}`);
    }
  }
} catch (e) {
  console.error(`\n[stopped after ${steps} steps] ${e.message}`);
}

// Top hot PCs
const top = [...pcHistogram.entries()].sort((a,b) => b[1]-a[1]).slice(0, 10);
console.error('\nhot PCs:');
for (const [pc, n] of top) {
  console.error(`  ${((pc >> 16) & 0xFFFF).toString(16).padStart(4,'0')}:${(pc & 0xFFFF).toString(16).padStart(4,'0')}  ${n}`);
}

console.error(`\n--- summary ---`);
console.error(`steps=${steps} cs:ip=${cpu.r.cs.toString(16)}:${cpu.r.ip.toString(16)}`);
console.error('bios calls:', calls);
console.error(`stdout bytes: ${stdoutBytes.length}`);
