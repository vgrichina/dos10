// 8086 ModR/M byte decoder.
//
// ModR/M = mod(2) reg(3) rm(3). Follows the first opcode byte of most two-operand ops.
// This module decodes ONLY the addressing side (mod+rm) into an operand descriptor.
// The reg field is just returned as a number — callers interpret it as 8-bit reg,
// 16-bit reg, segment reg, or a sub-opcode depending on the parent instruction.

export const REGS8  = ['al','cl','dl','bl','ah','ch','dh','bh'];
export const REGS16 = ['ax','cx','dx','bx','sp','bp','si','di'];
export const SEGS   = ['es','cs','ss','ds'];

// rm encoding (mod ≠ 11): [base][+index][+disp]
const RM_MEM = [
  { base: 'bx', idx: 'si', seg: 'ds' },
  { base: 'bx', idx: 'di', seg: 'ds' },
  { base: 'bp', idx: 'si', seg: 'ss' },
  { base: 'bp', idx: 'di', seg: 'ss' },
  { base: null, idx: 'si', seg: 'ds' },
  { base: null, idx: 'di', seg: 'ds' },
  { base: 'bp', idx: null, seg: 'ss' }, // special: mod=00 → [disp16] instead
  { base: 'bx', idx: null, seg: 'ds' },
];

export function s8(x)  { return x & 0x80  ? x - 0x100  : x; }
export function s16(x) { return x & 0x8000 ? x - 0x10000 : x; }

/**
 * Decode a ModR/M byte (plus following displacement bytes) starting at bytes[offset].
 * Returns { reg, rm, length } where:
 *   reg: 0..7 — the reg field, caller interprets
 *   rm:  operand descriptor:
 *     { type: 'reg',  size: 8|16, idx: 0..7 }          (mod=11)
 *     { type: 'mem',  base, index, disp, seg }         (mod≠11; size depends on parent opcode)
 *   length: total bytes consumed (1 for ModR/M + 0/1/2 for displacement)
 */
export function decodeModRM(bytes, offset) {
  const mb = bytes[offset];
  const mod = (mb >> 6) & 3;
  const reg = (mb >> 3) & 7;
  const rm  =  mb       & 7;
  let length = 1;

  if (mod === 3) {
    return { reg, rm: { type: 'reg', size: null, idx: rm }, length };
  }

  // Memory operand
  let disp = 0;
  let base = RM_MEM[rm].base;
  let index = RM_MEM[rm].idx;
  let seg = RM_MEM[rm].seg;

  if (mod === 0 && rm === 6) {
    // [disp16] — direct addressing, DS (NOT the rm=6 table entry which is [BP]/SS)
    base = null; index = null; seg = 'ds';
    disp = bytes[offset + 1] | (bytes[offset + 2] << 8);
    length += 2;
  } else if (mod === 1) {
    disp = s8(bytes[offset + 1]);
    length += 1;
  } else if (mod === 2) {
    disp = s16(bytes[offset + 1] | (bytes[offset + 2] << 8));
    length += 2;
  }

  return {
    reg,
    rm: { type: 'mem', base, index, disp, seg, mod, rmField: rm },
    length,
  };
}

// Format a mem operand to Intel-syntax string. `sizeHint` ∈ {'byte','word','dword',null}.
export function fmtMem(mem, sizeHint, segOverride) {
  let inner = '';
  if (mem.base)  inner += mem.base;
  if (mem.index) inner += (inner ? '+' : '') + mem.index;
  if (!mem.base && !mem.index) {
    inner = `0x${(mem.disp & 0xFFFF).toString(16)}`;
  } else if (mem.disp) {
    const d = mem.disp;
    inner += d < 0 ? `-0x${(-d).toString(16)}` : `+0x${d.toString(16)}`;
  }
  const seg = segOverride || mem.seg;
  const segStr = (segOverride && segOverride !== mem.seg) ? `${seg}:` : '';
  const sz = sizeHint ? `${sizeHint} ptr ` : '';
  return `${sz}${segStr}[${inner}]`;
}

export function fmtReg(idx, size) {
  return size === 8 ? REGS8[idx] : REGS16[idx];
}
