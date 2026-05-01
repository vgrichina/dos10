// Boots an on-disk 86-DOS image (IMD format) under our 8086 CPU + SCP-BIOS
// shim. The Tarbell-format boot sector talks to physical FDC ports
// (out 0x78 etc.) which we don't emulate, so we mimic what it does:
//   1. Read the system-area sectors (track 0 sec 2.. + track 1) into 0:0400.
//   2. Jump to 40:0 (= linear 0x400), which is where the on-disk MSDOS
//      lives — its first 30 bytes are the BIOS jump table, then code.
//   3. Install our INT 0xE0+idx trampolines OVER the on-disk BIOS table
//      so MSDOS's CALL FAR BIOSREAD,40H lands in JS.
//
// Disk reads MSDOS issues for COMMAND.COM go through BIOSREAD → IMD.

import { readFileSync } from 'node:fs';
import { createMemory } from '../tools/core/memory.js';
import { createCPU } from '../tools/core/cpu.js';
import { installBios, makeBiosBus, BIOS_NAMES, INT_BASE } from '../tools/core/scp_bios.js';
import { createImdDisk } from '../tools/core/disk_imd.js';

const imdPath = process.argv[2] ?? 'assets/86dos114-tarbell-dd.imd';
const disk = createImdDisk(readFileSync(imdPath));
console.log(`disk: ${disk.imdHeader.replace(/\r?\n/g, ' | ').trim()}`);
console.log(`geometry: ${disk.geometry.cylinders}c × ${disk.geometry.heads}h × ${disk.geometry.sectorsPerTrack}s × ${disk.geometry.sectorSize}B`);

const mem = createMemory();

// Skip the on-disk SCP-BIOS+loader at 40:0 entirely (it talks to Tarbell
// FDC ports we don't emulate). Replicate what the loader's BIOSREAD call
// does: read 56 sectors starting at logical record 0x50 into segment 7B
// — that's the MSDOS proper image. Then we'll jump straight to 7B:0 with
// our BIOS trampolines installed at 40:0..1D.
const SPT = disk.geometry.sectorsPerTrack;
const SS  = disk.geometry.sectorSize;
function lrToCHS(lr) { return { c: (lr / SPT) | 0, h: 0, s: (lr % SPT) + 1 }; }
function loadAt(seg, off, lrStart, count) {
  let addr = ((seg << 4) + off) & 0xFFFFF;
  for (let i = 0; i < count; i++) {
    const { c, h, s } = lrToCHS(lrStart + i);
    const sec = disk.sector(c, h, s);
    if (!sec) { console.error(`missing sector LR ${lrStart + i} (C${c}/H${h}/S${s})`); return i; }
    for (let j = 0; j < sec.length; j++) mem.buf[(addr + j) & 0xFFFFF] = sec[j];
    addr += sec.length;
  }
  return count;
}
const N_MSDOS_SECTORS = 56;
const LR_MSDOS = 0x50;
const got = loadAt(0x007B, 0x0000, LR_MSDOS, N_MSDOS_SECTORS);
console.log(`loaded ${got} sectors (${got * SS} bytes) from LR ${LR_MSDOS} into 7B:0000`);

// Install BIOS trampolines AT segment 0x40 — these overwrite the first
// 30 bytes of the loaded MSDOS image, which on disk are the BIOS jump
// table that the SCP boot would normally patch in.
installBios(mem);

// Wrap the IMD disk so the BIOS shim's `io.disk` interface (which doesn't
// pass mem) gets it from closure.
const diskBound = {
  read:    (drive, track, sec, n, lin) => disk.read (drive, track, sec, n, lin, mem),
  write:   (drive, track, sec, n, lin) => disk.write(drive, track, sec, n, lin, mem),
  changed: (drive) => disk.changed(drive),
};

// Hand-rolled handlers (defaultHandlers' IN spins forever — we want
// non-blocking for headless smoke tests).
const stdoutBytes = [];
let inputN = 0;
const calls = Object.fromEntries(BIOS_NAMES.map(n => [n, 0]));
const handlers = {
  STAT(r)      { calls.STAT++;   r.ax = (r.ax & 0xFF00) | 0xFF; }, // always say "key ready"
  IN  (r)      { calls.IN++;     r.ax = (r.ax & 0xFF00) | (inputN++ < 1 ? 0x0D : 0x1A); },
  OUT (r)      { calls.OUT++;    const b = r.ax & 0xFF; stdoutBytes.push(b); process.stdout.write(String.fromCharCode(b === 0x0D ? 0x0A : b)); },
  PRINT(r)     { calls.PRINT++; },
  AUXIN(r)     { calls.AUXIN++;  r.ax = (r.ax & 0xFF00) | 0x1A; },
  AUXOUT(r)    { calls.AUXOUT++; },
  READ(r, m)   { calls.READ++;
                 // 86DOS BIOSREAD convention (per DREAD in 86DOS.ASM):
                 //   AL = drive number
                 //   DS:BX = transfer address
                 //   CX = sector count
                 //   DX = absolute (logical) record number
                 //   returns CF=1 on error
                 const drive = r.ax & 0xFF;
                 const lr = r.dx & 0xFFFF;
                 const n  = r.cx & 0xFFFF;
                 const lin = ((r.ds << 4) + r.bx) & 0xFFFFF;
                 const { c, s } = lrToCHS(lr);
                 const ok = diskBound.read(drive, c, s, n, lin);
                 if (ok) { r.flags &= ~0x0001; } else { r.flags |= 0x0001; }
               },
  WRITE(r, m)  { calls.WRITE++; r.ax = (r.ax & 0xFF00) | 1; }, // ignore writes for now
  DSKCHG(r)    { calls.DSKCHG++; r.ax = (r.ax & 0xFF00) | 0; },
};
const bus = makeBiosBus(handlers, mem);

const cpu = createCPU(mem, bus);
cpu.r.cs = 0x007B; cpu.r.ip = 0x0000; // jump to MSDOS proper, skipping on-disk loader
cpu.r.ds = 0x007B; cpu.r.es = 0x007B;
cpu.r.ss = 0x0000; cpu.r.sp = 0x0400;
cpu.r.si = 0x037F; // matches what on-disk loader sets up before its CALL FAR 7B:0

let steps = 0;
const MAX = 200_000;
try {
  while (steps < MAX) { cpu.step(); steps++; }
} catch (e) {
  console.error(`\n[stopped after ${steps} steps] ${e.message}`);
}
console.error(`\n--- summary ---`);
console.error(`steps=${steps} cs:ip=${cpu.r.cs.toString(16)}:${cpu.r.ip.toString(16)}`);
console.error('bios calls:', calls);
console.error(`stdout bytes captured: ${stdoutBytes.length}`);
