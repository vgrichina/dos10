// SCP-style BIOS shim for 86-DOS 1.00.
//
// 86DOS.ASM expects a "BIOS segment" at 40H containing nine 3-byte vector
// slots starting at 40:0003 (offset 0 is reserved). Each slot in the real
// SCP BIOS is a `JMP <handler>`; in our emulator we install a trampoline:
//
//     CD vv     INT 0xE0+idx     ; bus.int short-circuits to a JS handler
//     CB        RETF             ; pops the far return frame from the CALL FAR
//
// Slot layout (matches 86DOS.ASM):
//   40:0003  BIOSSTAT     return AL=0FFH if a key is ready, AL=0 otherwise
//   40:0006  BIOSIN       wait for a key, return it in AL
//   40:0009  BIOSOUT      write AL to console
//   40:000C  BIOSPRINT    write AL to printer
//   40:000F  BIOSAUXIN    wait for a byte from AUX, return in AL
//   40:0012  BIOSAUXOUT   write AL to AUX
//   40:0015  BIOSREAD     read CX sectors from disk; DMA at DS:[DMAADD]
//   40:0018  BIOSWRITE    write CX sectors to disk; DMA at DS:[DMAADD]
//   40:001B  BIOSDSKCHG   report disk-changed status (AL=1 if changed)
//
// Disk geometry follows the SCP convention: track in CH, sector (1..N) in
// CL, drive in DL. We do not model interleave or seek time.

export const BIOS_SEG = 0x40;
export const BIOS_BASE = 0x0003;

// In-table order; index maps to INT vector 0xE0+idx.
export const BIOS_NAMES = [
  'STAT', 'IN', 'OUT', 'PRINT', 'AUXIN', 'AUXOUT', 'READ', 'WRITE', 'DSKCHG',
];

export const INT_BASE = 0xE0;

// Emit a 3-byte trampoline (INT vec; RETF) at seg:off.
function trampoline(mem, seg, off, vec) {
  mem.write8(seg, off,     0xCD);
  mem.write8(seg, off + 1, vec);
  mem.write8(seg, off + 2, 0xCB);
}

export function installBios(mem) {
  for (let idx = 0; idx < BIOS_NAMES.length; idx++) {
    trampoline(mem, BIOS_SEG, BIOS_BASE + idx * 3, INT_BASE + idx);
  }
}

// Patch trampolines over the on-disk BIOS routine entry points reached
// by the SCP loader's direct `CALL FAR 40:xxxx` calls (which bypass the
// JMP table). `entryOffsets` is an array of 9 offsets in BIOS_NAMES
// order — STAT, IN, OUT, PRINT, AUXIN, AUXOUT, READ, WRITE, DSKCHG.
export function patchBiosImpls(mem, entryOffsets) {
  if (entryOffsets.length !== BIOS_NAMES.length)
    throw new Error(`patchBiosImpls: expected ${BIOS_NAMES.length} offsets, got ${entryOffsets.length}`);
  for (let idx = 0; idx < BIOS_NAMES.length; idx++) {
    trampoline(mem, BIOS_SEG, entryOffsets[idx], INT_BASE + idx);
  }
}

// Build a bus.int handler that dispatches the trampoline INTs to user
// callbacks. `handlers` is an object keyed by name from BIOS_NAMES; each
// entry takes (regs, mem) and may set regs.ax / write into memory.
export function makeBiosBus(handlers, mem) {
  return {
    int(n, regs) {
      const idx = n - INT_BASE;
      if (idx < 0 || idx >= BIOS_NAMES.length) return false;
      const name = BIOS_NAMES[idx];
      const h = handlers[name];
      if (!h) return true; // swallow unhandled BIOS ints rather than IVT
      h(regs, mem);
      return true;
    },
  };
}

// Convenience: a default handler set suitable for headless smoke-tests.
// `io` is a small adapter:
//   io.read()        → number 0..255 or null if no key (used by STAT/IN)
//   io.write(byte)   → console output
//   io.print(byte)   → printer (ignored if absent)
//   io.aux           → { in(), out(b) }
//   io.disk          → { read(drive,track,sector,count,linAddr),
//                        write(...), changed(drive) }
export function defaultHandlers(io) {
  const must = (k) => { if (!io[k]) throw new Error(`scp_bios: io.${k} missing`); };
  return {
    STAT(r) {
      r.ax = (r.ax & 0xFF00) | (io.read && io.peek && io.peek() != null ? 0xFF : 0x00);
    },
    IN(r) {
      must('read');
      let b; while ((b = io.read()) == null) { /* spin: caller should pump */ }
      r.ax = (r.ax & 0xFF00) | (b & 0xFF);
    },
    OUT(r) { must('write'); io.write(r.ax & 0xFF); },
    PRINT(r) { if (io.print) io.print(r.ax & 0xFF); },
    AUXIN(r) {
      if (!io.aux) { r.ax = (r.ax & 0xFF00) | 0x1A; return; } // EOF
      let b; while ((b = io.aux.in()) == null) {}
      r.ax = (r.ax & 0xFF00) | (b & 0xFF);
    },
    AUXOUT(r) { if (io.aux) io.aux.out(r.ax & 0xFF); },
    READ(r, mem) {
      if (!io.disk) { r.ax = (r.ax & 0xFF00) | 0x01; return; }
      // 86DOS passes DMA address as a 16-bit offset within the user's DS.
      const dma = mem.read16(r.ds, dmaAddrOffset(mem, r.ds));
      const lin = (r.ds << 4) + dma;
      const ok = io.disk.read(r.dx & 0xFF, (r.cx >> 8) & 0xFF, r.cx & 0xFF, sectorCount(r), lin);
      r.ax = (r.ax & 0xFF00) | (ok ? 0 : 1);
    },
    WRITE(r, mem) {
      if (!io.disk) { r.ax = (r.ax & 0xFF00) | 0x01; return; }
      const dma = mem.read16(r.ds, dmaAddrOffset(mem, r.ds));
      const lin = (r.ds << 4) + dma;
      const ok = io.disk.write(r.dx & 0xFF, (r.cx >> 8) & 0xFF, r.cx & 0xFF, sectorCount(r), lin);
      r.ax = (r.ax & 0xFF00) | (ok ? 0 : 1);
    },
    DSKCHG(r) {
      r.ax = (r.ax & 0xFF00) | (io.disk?.changed?.(r.dx & 0xFF) ? 1 : 0);
    },
  };
}

// Sector-count register convention varies; SCP READ/WRITE put it in nothing
// special — most callers loop themselves. We treat each call as 1 sector
// unless caller has stashed a count in BL (a 86DOS-specific extension we
// keep optional).
function sectorCount(r) { return ((r.bx & 0xFF) || 1); }

// 86DOS stores the user's DMA address at the DMAADD label in its DS. The
// label is at a fixed offset, but it varies by build — we let the caller
// patch it post-hoc if needed. By default we read offset 0 (caller can
// override via mem.dmaAddrOff if wired).
function dmaAddrOffset(mem, ds) { return mem.dmaAddrOff ?? 0; }
