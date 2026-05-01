// CLI: node tools/imd_dump.js <image.imd> [cyl head sector]
// With CHS args, dumps that sector's bytes; otherwise prints geometry +
// the first 256 bytes of cyl 0 head 0 sector 1 (typically the boot sector
// on SCP-format 8" disks).

import { readFileSync } from 'node:fs';
import { parseImd, geometry, readSector } from './imd.js';

const [,, path, cs, hs, ss] = process.argv;
if (!path) { console.error('usage: node tools/imd_dump.js <image.imd> [cyl head sector]'); process.exit(2); }
const imd = parseImd(readFileSync(path));
const g = geometry(imd);
console.log(`header: ${imd.header.replace(/\r?\n/g, ' | ').trim()}`);
console.log(`tracks: ${imd.tracks.length}  geometry: ${g.cylinders}c × ${g.heads}h × ${g.sectorsPerTrack}s × ${g.sectorSize}B`);

const c = cs !== undefined ? +cs : 0;
const h = hs !== undefined ? +hs : 0;
const s = ss !== undefined ? +ss : 1;
const sec = readSector(imd, c, h, s);
if (!sec) { console.error(`no sector at C${c}/H${h}/S${s}`); process.exit(1); }
console.log(`sector ${c}/${h}/${s} (${sec.length} bytes):`);
hex(sec.slice(0, 256));

function hex(u8) {
  for (let i = 0; i < u8.length; i += 16) {
    const row = u8.subarray(i, i + 16);
    const hexs = Array.from(row).map(b => b.toString(16).padStart(2,'0')).join(' ');
    const asc  = Array.from(row).map(b => (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.').join('');
    console.log(`  ${i.toString(16).padStart(4,'0')}  ${hexs.padEnd(48)}  ${asc}`);
  }
}
