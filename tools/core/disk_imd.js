// IMD-backed disk adapter for the SCP BIOS shim.
//
// 86DOS issues sector-count R/W requests using its own (track, sector,
// drive) convention via BIOSREAD/BIOSWRITE. We expose a minimal interface
// matching what `defaultHandlers` in scp_bios.js expects:
//
//     read (drive, track, sector, count, linAddr) → boolean
//     write(drive, track, sector, count, linAddr) → boolean
//     changed(drive) → boolean
//
// `linAddr` is the 20-bit linear address in the emulator memory's `buf`.
// Caller passes that already-resolved (segment-shifted) address.
//
// Geometry comes from the IMD itself (single-sided 77c × 26s × 128B for
// the 86-DOS Tarbell DD images we use). When `count` spans multiple
// sectors we walk forward (sec++, then track++ on overflow).

import { parseImd, geometry, readSector } from '../imd.js';

export function createImdDisk(buf, { writable = false } = {}) {
  const imd = parseImd(buf);
  const g = geometry(imd);
  const writes = new Map(); // overlay: "C/H/S" → Uint8Array (writes never touch the original IMD)

  function getSector(c, h, s) {
    const k = `${c}/${h}/${s}`;
    return writes.get(k) ?? readSector(imd, c, h, s);
  }
  function putSector(c, h, s, bytes) {
    writes.set(`${c}/${h}/${s}`, bytes);
  }

  function transfer(mem, drive, track, sector, count, linAddr, isWrite) {
    if (drive !== 0) return false; // single drive for now
    let c = track | 0, s = sector | 0, h = 0, n = count | 0, addr = linAddr | 0;
    while (n > 0) {
      const sec = getSector(c, h, s);
      if (!sec) return false;
      if (isWrite) {
        const copy = new Uint8Array(sec.length);
        for (let i = 0; i < sec.length; i++) copy[i] = mem.buf[(addr + i) & 0xFFFFF];
        putSector(c, h, s, copy);
      } else {
        for (let i = 0; i < sec.length; i++) mem.buf[(addr + i) & 0xFFFFF] = sec[i];
      }
      addr += sec.length;
      n--;
      s++;
      if (s > g.sectorsPerTrack) { s = 1; c++; if (c >= g.cylinders) return false; }
    }
    return true;
  }

  return {
    geometry: g,
    imdHeader: imd.header,
    bootSector: () => readSector(imd, 0, 0, 1),
    sector: getSector,
    read (drive, track, sector, count, linAddr, mem) { return transfer(mem, drive, track, sector, count, linAddr, false); },
    write(drive, track, sector, count, linAddr, mem) {
      if (!writable) return false;
      return transfer(mem, drive, track, sector, count, linAddr, true);
    },
    changed: () => false,
  };
}
