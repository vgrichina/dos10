// ImageDisk (.imd) reader.
//
// Format reference: Dave Dunfield's IMD spec (the de-facto standard for 8"
// floppy archival used by SIMH and other emulators).
//
// Layout:
//   - ASCII header line(s), terminated by 0x1A (DOS EOF).
//   - Sequence of track records:
//       u8  mode         0..5: FM/MFM × data rate
//       u8  cyl
//       u8  head_flags   bit 0: head; bit 7: cyl-map present; bit 6: head-map present
//       u8  nsec         sector count
//       u8  sizeCode     0=128, 1=256, 2=512, 3=1024, 4=2048, 5=4096, 6=8192
//       u8[nsec] sectorMap   logical sector numbers (1-based on real disks)
//       u8[nsec] cylMap      (if cyl-map flag set)
//       u8[nsec] headMap     (if head-map flag set)
//       per sector:
//         u8 type
//           0 = unavailable
//           1 = normal data, followed by `size` bytes
//           2 = compressed, followed by 1 fill byte
//           3,5,7 = normal w/ deleted-mark / read-error / both
//           4,6,8 = compressed w/ deleted-mark / read-error / both
//
// We expose:
//   parseImd(buf) → { header, tracks: [{cyl,head,mode,sizeCode,sectorMap,sectors:Uint8Array[]}] }
//   buildSectorIndex(imd) → key "C/H/S" → Uint8Array
//   readSector(imd, drive=0, cyl, head, sec) → Uint8Array | null

const SIZE_FROM_CODE = [128, 256, 512, 1024, 2048, 4096, 8192];

export function parseImd(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let i = 0;
  // Header runs until 0x1A.
  while (i < u8.length && u8[i] !== 0x1A) i++;
  const header = new TextDecoder('latin1').decode(u8.subarray(0, i));
  if (i >= u8.length) throw new Error('imd: unterminated header');
  i++; // skip the 0x1A
  const tracks = [];
  while (i < u8.length) {
    const mode      = u8[i++];
    const cyl       = u8[i++];
    const headFlags = u8[i++];
    const nsec      = u8[i++];
    const sizeCode  = u8[i++];
    if (sizeCode > 6) throw new Error(`imd: bad size code ${sizeCode} at offset ${i-1}`);
    const sectorSize = SIZE_FROM_CODE[sizeCode];
    const head = headFlags & 1;
    const hasCylMap  = (headFlags & 0x80) !== 0;
    const hasHeadMap = (headFlags & 0x40) !== 0;
    const sectorMap = u8.subarray(i, i + nsec); i += nsec;
    const cylMap  = hasCylMap  ? u8.subarray(i, i + nsec) : null; if (hasCylMap)  i += nsec;
    const headMap = hasHeadMap ? u8.subarray(i, i + nsec) : null; if (hasHeadMap) i += nsec;
    const sectors = new Array(nsec);
    for (let s = 0; s < nsec; s++) {
      const type = u8[i++];
      if (type === 0) { sectors[s] = null; continue; }
      if (type === 1 || type === 3 || type === 5 || type === 7) {
        sectors[s] = u8.slice(i, i + sectorSize); i += sectorSize;
      } else if (type === 2 || type === 4 || type === 6 || type === 8) {
        const fill = u8[i++];
        const buf2 = new Uint8Array(sectorSize); buf2.fill(fill);
        sectors[s] = buf2;
      } else {
        throw new Error(`imd: bad sector type ${type} at offset ${i-1}`);
      }
    }
    tracks.push({ mode, cyl, head, sizeCode, sectorSize, sectorMap,
                  cylMap: cylMap ? Array.from(cylMap) : null,
                  headMap: headMap ? Array.from(headMap) : null,
                  sectors });
  }
  return { header, tracks };
}

export function buildSectorIndex(imd) {
  const idx = new Map();
  for (const t of imd.tracks) {
    for (let s = 0; s < t.sectorMap.length; s++) {
      const c = t.cylMap  ? t.cylMap[s]  : t.cyl;
      const h = t.headMap ? t.headMap[s] : t.head;
      const sec = t.sectorMap[s];
      idx.set(`${c}/${h}/${sec}`, t.sectors[s]);
    }
  }
  return idx;
}

export function readSector(imd, cyl, head, sec) {
  const idx = imd._idx ?? (imd._idx = buildSectorIndex(imd));
  return idx.get(`${cyl}/${head}/${sec}`) ?? null;
}

// Linear-CHS helpers: SCP 8" SSSD has 77 trk × 26 sec × 128 B; many other
// 8" disks use 26 sectors per track (FM) or 8/15/26 (MFM). We don't bake
// in a geometry — caller decides.
export function geometry(imd) {
  const tMax = Math.max(...imd.tracks.map(t => t.cyl)) + 1;
  const hMax = Math.max(...imd.tracks.map(t => t.head)) + 1;
  const sMax = Math.max(...imd.tracks.map(t => t.sectorMap.length));
  const ssz  = imd.tracks[0]?.sectorSize ?? 128;
  return { cylinders: tMax, heads: hMax, sectorsPerTrack: sMax, sectorSize: ssz };
}
