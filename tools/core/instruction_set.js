// 8086/8088 instruction decoder.
//
// Covers the full 8086 ISA (no 186+ opcodes, no FPU — FPU instructions decode as generic
// ESC for now; 8088 MPH uses PC speaker, not x87). Returns a structured DecodedInsn used
// by both the disassembler and the CPU executor.
//
// DecodedInsn shape:
//   { address, length, bytes,
//     prefixes: { rep, seg, lock },
//     mnemonic,
//     operands: [Operand, ...] }
//
// Operand kinds:
//   { kind:'reg',  size:8|16, idx:0..7 }
//   { kind:'seg',  idx:0..3 }           // ES/CS/SS/DS
//   { kind:'mem',  base, index, disp, seg, size:8|16 }
//   { kind:'imm',  size:8|16, value }
//   { kind:'rel',  size:8|16, value, target }
//   { kind:'far',  seg, off }
//   { kind:'moff', disp, seg, size:8|16 }
//   { kind:'dx' } | { kind:'cl' } | { kind:'one' }
//
// This module is browser-safe (no Node APIs).

import { decodeModRM, s8, s16 } from './modrm.js';

// --- Group mnemonics ---
const GRP1 = ['add','or','adc','sbb','and','sub','xor','cmp'];
const GRP2 = ['rol','ror','rcl','rcr','shl','shr','shl','sar']; // note: 110 is undocumented SAL alias of SHL
const GRP3 = ['test','test','not','neg','mul','imul','div','idiv']; // 000 and 001 both TEST (001 undocumented)
const GRP4 = ['inc','dec']; // for FE / FF low entries
const GRP5_FF = ['inc','dec','call','call far','jmp','jmp far','push','?']; // reg field for FF
const CC    = ['o','no','b','nb','z','nz','be','nbe','s','ns','p','np','l','nl','le','nle'];

// --- Operand constructors (kept small) ---
const R8  = (idx) => ({ kind:'reg', size:8,  idx });
const R16 = (idx) => ({ kind:'reg', size:16, idx });
const SEG = (idx) => ({ kind:'seg', idx });
const IMM = (size, value) => ({ kind:'imm', size, value });
const REL = (size, value, target) => ({ kind:'rel', size, value, target });
const FAR = (seg, off) => ({ kind:'far', seg, off });
const MOFF = (disp, seg, size) => ({ kind:'moff', disp, seg, size });
const DX  = () => ({ kind:'dx' });
const CL  = () => ({ kind:'cl' });
const ONE = () => ({ kind:'one' });

function mem(rmDesc, size) {
  return { kind:'mem', base: rmDesc.base, index: rmDesc.index,
           disp: rmDesc.disp, seg: rmDesc.seg, size, mod: rmDesc.mod };
}

// --- Helpers for reading immediates/displacements ---
function rd8(b, o)  { return b[o]; }
function rd16(b, o) { return b[o] | (b[o+1] << 8); }

// Decode a group-1 arithmetic op at byte OP (0x00..0x3D range).
// OP encodes: base-op-index*8 + (direction<<1 | size). Returns mnemonic+operands.
function decodeArith(bytes, offset, op) {
  const group = (op >> 3) & 7;
  const mnemonic = GRP1[group];
  const low3 = op & 7;
  // low3 values:
  //   0: r/m8,  reg8   (mod/rm w/ 8-bit reg, dir=0)
  //   1: r/m16, reg16  (dir=0, 16-bit)
  //   2: reg8,  r/m8   (dir=1)
  //   3: reg16, r/m16
  //   4: AL, imm8
  //   5: AX, imm16
  //   6: PUSH sreg / seg override handled elsewhere
  //   7: POP sreg  (or DAA/AAA etc at 0x27/0x2F/0x37/0x3F — see caller)
  if (low3 <= 3) {
    const size = (low3 & 1) ? 16 : 8;
    const dir  = (low3 >> 1) & 1;
    const { reg, rm, length } = decodeModRM(bytes, offset);
    const regOp = size === 8 ? R8(reg) : R16(reg);
    const rmOp  = rm.type === 'reg'
      ? (size === 8 ? R8(rm.idx) : R16(rm.idx))
      : mem(rm, size);
    const operands = dir ? [regOp, rmOp] : [rmOp, regOp];
    return { mnemonic, operands, consumed: length };
  } else if (low3 === 4) { // AL, imm8
    return { mnemonic, operands: [R8(0), IMM(8, rd8(bytes, offset))], consumed: 1 };
  } else { // 5: AX, imm16
    return { mnemonic, operands: [R16(0), IMM(16, rd16(bytes, offset))], consumed: 2 };
  }
}

/**
 * Decode one instruction.
 * @param {Uint8Array|Buffer} bytes
 * @param {number} offset  - start index into bytes
 * @param {number} [addr]  - logical address for relative-branch targets (defaults to offset)
 * @returns {object} DecodedInsn, or throws if unknown opcode
 */
export function decode(bytes, offset, addr = offset) {
  const start = offset;
  const startAddr = addr;
  const prefixes = { rep: null, seg: null, lock: false };

  // --- Consume prefixes ---
  // 8086 allows multiple; keep consuming until a non-prefix is seen.
  while (offset < bytes.length) {
    const b = bytes[offset];
    if (b === 0xF0) { prefixes.lock = true; offset++; addr++; continue; }
    if (b === 0xF2) { prefixes.rep = 'repnz'; offset++; addr++; continue; }
    if (b === 0xF3) { prefixes.rep = 'rep';   offset++; addr++; continue; }
    if (b === 0x26) { prefixes.seg = 'es'; offset++; addr++; continue; }
    if (b === 0x2E) { prefixes.seg = 'cs'; offset++; addr++; continue; }
    if (b === 0x36) { prefixes.seg = 'ss'; offset++; addr++; continue; }
    if (b === 0x3E) { prefixes.seg = 'ds'; offset++; addr++; continue; }
    break;
  }

  const opStart = offset;
  const op = bytes[offset++];
  addr++;

  let mnemonic = '?';
  let operands = [];

  // --- Arithmetic group 0x00..0x3F ---
  if (op < 0x40) {
    const low3 = op & 7;
    const group = (op >> 3) & 7;
    if (low3 === 6) {
      // PUSH sreg (ES=06 CS=0E SS=16 DS=1E)
      mnemonic = 'push';
      operands = [SEG(group & 3)];
    } else if (low3 === 7) {
      // POP sreg, or DAA/DAS/AAA/AAS
      if (op === 0x27) { mnemonic = 'daa'; }
      else if (op === 0x2F) { mnemonic = 'das'; }
      else if (op === 0x37) { mnemonic = 'aaa'; }
      else if (op === 0x3F) { mnemonic = 'aas'; }
      else { mnemonic = 'pop'; operands = [SEG(group & 3)]; }
    } else {
      const r = decodeArith(bytes, offset, op);
      mnemonic = r.mnemonic; operands = r.operands;
      offset += r.consumed; addr += r.consumed;
    }
  }
  // --- INC/DEC reg16  0x40..0x4F ---
  else if (op < 0x50) {
    mnemonic = (op < 0x48) ? 'inc' : 'dec';
    operands = [R16(op & 7)];
  }
  // --- PUSH/POP reg16  0x50..0x5F ---
  else if (op < 0x60) {
    mnemonic = (op < 0x58) ? 'push' : 'pop';
    operands = [R16(op & 7)];
  }
  // --- Jcc rel8  0x70..0x7F (and 0x60..0x6F, undocumented 8088 aliases) ---
  else if (op < 0x80) {
    mnemonic = 'j' + CC[op & 0xF];
    const rel = s8(bytes[offset]); offset++; addr++;
    operands = [REL(8, rel, (addr + rel) & 0xFFFF)];
  }
  // --- 0x80..0x83  group1 r/m, imm ---
  else if (op < 0x84) {
    const sizeBit = op & 1;          // 0 → 8-bit, 1 → 16-bit
    const signExt = (op & 2) !== 0;  // 82/83 sign-extend imm8→imm16
    const { reg: sub, rm, length } = decodeModRM(bytes, offset);
    offset += length; addr += length;
    mnemonic = GRP1[sub];
    const size = sizeBit ? 16 : 8;
    const dstOp = rm.type === 'reg' ? (size === 8 ? R8(rm.idx) : R16(rm.idx)) : mem(rm, size);
    let imm;
    if (op === 0x81) {
      imm = IMM(16, rd16(bytes, offset)); offset += 2; addr += 2;
    } else if (op === 0x80 || op === 0x82) {
      imm = IMM(8, rd8(bytes, offset)); offset++; addr++;
    } else {
      // 0x83: sign-extended 8-bit immediate treated as 16-bit operand
      imm = IMM(16, s8(rd8(bytes, offset)) & 0xFFFF); offset++; addr++;
    }
    operands = [dstOp, imm];
  }
  // --- 0x84/0x85  TEST r/m, reg ---
  else if (op === 0x84 || op === 0x85) {
    const size = (op & 1) ? 16 : 8;
    const { reg, rm, length } = decodeModRM(bytes, offset); offset += length; addr += length;
    mnemonic = 'test';
    const rOp = size === 8 ? R8(reg) : R16(reg);
    const mOp = rm.type === 'reg' ? (size === 8 ? R8(rm.idx) : R16(rm.idx)) : mem(rm, size);
    operands = [mOp, rOp];
  }
  // --- 0x86/0x87  XCHG r/m, reg ---
  else if (op === 0x86 || op === 0x87) {
    const size = (op & 1) ? 16 : 8;
    const { reg, rm, length } = decodeModRM(bytes, offset); offset += length; addr += length;
    mnemonic = 'xchg';
    const rOp = size === 8 ? R8(reg) : R16(reg);
    const mOp = rm.type === 'reg' ? (size === 8 ? R8(rm.idx) : R16(rm.idx)) : mem(rm, size);
    operands = [mOp, rOp];
  }
  // --- 0x88..0x8B  MOV r/m,reg / reg,r/m ---
  else if (op < 0x8C) {
    const size = (op & 1) ? 16 : 8;
    const dir  = (op >> 1) & 1;
    const { reg, rm, length } = decodeModRM(bytes, offset); offset += length; addr += length;
    mnemonic = 'mov';
    const rOp = size === 8 ? R8(reg) : R16(reg);
    const mOp = rm.type === 'reg' ? (size === 8 ? R8(rm.idx) : R16(rm.idx)) : mem(rm, size);
    operands = dir ? [rOp, mOp] : [mOp, rOp];
  }
  // --- 0x8C  MOV r/m16, sreg ---
  else if (op === 0x8C) {
    const { reg, rm, length } = decodeModRM(bytes, offset); offset += length; addr += length;
    mnemonic = 'mov';
    const mOp = rm.type === 'reg' ? R16(rm.idx) : mem(rm, 16);
    operands = [mOp, SEG(reg & 3)];
  }
  // --- 0x8D  LEA ---
  else if (op === 0x8D) {
    const { reg, rm, length } = decodeModRM(bytes, offset); offset += length; addr += length;
    mnemonic = 'lea';
    operands = [R16(reg), mem(rm, 16)];
  }
  // --- 0x8E  MOV sreg, r/m16 ---
  else if (op === 0x8E) {
    const { reg, rm, length } = decodeModRM(bytes, offset); offset += length; addr += length;
    mnemonic = 'mov';
    const mOp = rm.type === 'reg' ? R16(rm.idx) : mem(rm, 16);
    operands = [SEG(reg & 3), mOp];
  }
  // --- 0x8F  POP r/m16 (only reg=0 valid) ---
  else if (op === 0x8F) {
    const { rm, length } = decodeModRM(bytes, offset); offset += length; addr += length;
    mnemonic = 'pop';
    operands = [rm.type === 'reg' ? R16(rm.idx) : mem(rm, 16)];
  }
  // --- 0x90  NOP (= XCHG AX,AX) ---
  else if (op === 0x90) {
    mnemonic = 'nop'; operands = [];
  }
  // --- 0x91..0x97  XCHG AX, reg16 ---
  else if (op < 0x98) {
    mnemonic = 'xchg'; operands = [R16(0), R16(op & 7)];
  }
  // --- 0x98..0x9F  misc ---
  else if (op === 0x98) { mnemonic = 'cbw'; }
  else if (op === 0x99) { mnemonic = 'cwd'; }
  else if (op === 0x9A) {
    mnemonic = 'call';
    const off = rd16(bytes, offset); const seg = rd16(bytes, offset + 2);
    offset += 4; addr += 4;
    operands = [FAR(seg, off)];
  }
  else if (op === 0x9B) { mnemonic = 'wait'; }
  else if (op === 0x9C) { mnemonic = 'pushf'; }
  else if (op === 0x9D) { mnemonic = 'popf'; }
  else if (op === 0x9E) { mnemonic = 'sahf'; }
  else if (op === 0x9F) { mnemonic = 'lahf'; }
  // --- 0xA0..0xA3  MOV A, moff / moff, A ---
  else if (op < 0xA4) {
    const size = (op & 1) ? 16 : 8;
    const dir  = (op >> 1) & 1;              // 0=→AL/AX, 1=→moff
    const disp = rd16(bytes, offset); offset += 2; addr += 2;
    mnemonic = 'mov';
    const aReg = size === 8 ? R8(0) : R16(0);
    const m    = MOFF(disp, prefixes.seg || 'ds', size);
    operands = dir ? [m, aReg] : [aReg, m];
  }
  else if (op === 0xA4) { mnemonic = 'movsb'; }
  else if (op === 0xA5) { mnemonic = 'movsw'; }
  else if (op === 0xA6) { mnemonic = 'cmpsb'; }
  else if (op === 0xA7) { mnemonic = 'cmpsw'; }
  // --- 0xA8/0xA9  TEST A, imm ---
  else if (op === 0xA8) {
    mnemonic = 'test'; operands = [R8(0), IMM(8, rd8(bytes, offset))];
    offset++; addr++;
  }
  else if (op === 0xA9) {
    mnemonic = 'test'; operands = [R16(0), IMM(16, rd16(bytes, offset))];
    offset += 2; addr += 2;
  }
  else if (op === 0xAA) { mnemonic = 'stosb'; }
  else if (op === 0xAB) { mnemonic = 'stosw'; }
  else if (op === 0xAC) { mnemonic = 'lodsb'; }
  else if (op === 0xAD) { mnemonic = 'lodsw'; }
  else if (op === 0xAE) { mnemonic = 'scasb'; }
  else if (op === 0xAF) { mnemonic = 'scasw'; }
  // --- 0xB0..0xB7  MOV reg8, imm8 ---
  else if (op < 0xB8) {
    mnemonic = 'mov';
    operands = [R8(op & 7), IMM(8, rd8(bytes, offset))];
    offset++; addr++;
  }
  // --- 0xB8..0xBF  MOV reg16, imm16 ---
  else if (op < 0xC0) {
    mnemonic = 'mov';
    operands = [R16(op & 7), IMM(16, rd16(bytes, offset))];
    offset += 2; addr += 2;
  }
  else if (op === 0xC2) {
    mnemonic = 'ret'; operands = [IMM(16, rd16(bytes, offset))]; offset += 2; addr += 2;
  }
  else if (op === 0xC3) { mnemonic = 'ret'; }
  else if (op === 0xC4 || op === 0xC5) {
    const { reg, rm, length } = decodeModRM(bytes, offset); offset += length; addr += length;
    mnemonic = op === 0xC4 ? 'les' : 'lds';
    operands = [R16(reg), rm.type === 'reg' ? R16(rm.idx) : mem(rm, 16) /* 32-bit mem technically */];
  }
  else if (op === 0xC6) {
    const { rm, length } = decodeModRM(bytes, offset); offset += length; addr += length;
    mnemonic = 'mov';
    const dst = rm.type === 'reg' ? R8(rm.idx) : mem(rm, 8);
    operands = [dst, IMM(8, rd8(bytes, offset))]; offset++; addr++;
  }
  else if (op === 0xC7) {
    const { rm, length } = decodeModRM(bytes, offset); offset += length; addr += length;
    mnemonic = 'mov';
    const dst = rm.type === 'reg' ? R16(rm.idx) : mem(rm, 16);
    operands = [dst, IMM(16, rd16(bytes, offset))]; offset += 2; addr += 2;
  }
  else if (op === 0xCA) {
    mnemonic = 'retf'; operands = [IMM(16, rd16(bytes, offset))]; offset += 2; addr += 2;
  }
  else if (op === 0xCB) { mnemonic = 'retf'; }
  else if (op === 0xCC) { mnemonic = 'int3'; }
  else if (op === 0xCD) { mnemonic = 'int'; operands = [IMM(8, rd8(bytes, offset))]; offset++; addr++; }
  else if (op === 0xCE) { mnemonic = 'into'; }
  else if (op === 0xCF) { mnemonic = 'iret'; }
  // --- 0xD0..0xD3  group2 shifts/rotates ---
  else if (op >= 0xD0 && op <= 0xD3) {
    const size   = (op & 1) ? 16 : 8;
    const useCL  = (op & 2) !== 0;
    const { reg: sub, rm, length } = decodeModRM(bytes, offset); offset += length; addr += length;
    mnemonic = GRP2[sub];
    const dst = rm.type === 'reg' ? (size === 8 ? R8(rm.idx) : R16(rm.idx)) : mem(rm, size);
    operands = [dst, useCL ? CL() : ONE()];
  }
  else if (op === 0xD4) { mnemonic = 'aam'; const imm = rd8(bytes, offset); offset++; addr++; if (imm !== 0x0A) operands = [IMM(8, imm)]; }
  else if (op === 0xD5) { mnemonic = 'aad'; const imm = rd8(bytes, offset); offset++; addr++; if (imm !== 0x0A) operands = [IMM(8, imm)]; }
  else if (op === 0xD6) { mnemonic = 'salc'; /* undocumented */ }
  else if (op === 0xD7) { mnemonic = 'xlat'; }
  // --- 0xD8..0xDF  ESC (FPU) — emit raw escape for now ---
  else if (op >= 0xD8 && op <= 0xDF) {
    const { reg: sub, rm, length } = decodeModRM(bytes, offset); offset += length; addr += length;
    mnemonic = 'esc';
    const dst = rm.type === 'reg' ? R16(rm.idx) : mem(rm, 16);
    operands = [IMM(8, ((op - 0xD8) << 3) | sub), dst];
  }
  else if (op === 0xE0) { const r = s8(bytes[offset++]); addr++; mnemonic = 'loopnz'; operands = [REL(8, r, (addr + r) & 0xFFFF)]; }
  else if (op === 0xE1) { const r = s8(bytes[offset++]); addr++; mnemonic = 'loopz';  operands = [REL(8, r, (addr + r) & 0xFFFF)]; }
  else if (op === 0xE2) { const r = s8(bytes[offset++]); addr++; mnemonic = 'loop';   operands = [REL(8, r, (addr + r) & 0xFFFF)]; }
  else if (op === 0xE3) { const r = s8(bytes[offset++]); addr++; mnemonic = 'jcxz';   operands = [REL(8, r, (addr + r) & 0xFFFF)]; }
  else if (op === 0xE4) { mnemonic = 'in';  operands = [R8(0),  IMM(8, rd8(bytes, offset))]; offset++; addr++; }
  else if (op === 0xE5) { mnemonic = 'in';  operands = [R16(0), IMM(8, rd8(bytes, offset))]; offset++; addr++; }
  else if (op === 0xE6) { mnemonic = 'out'; operands = [IMM(8, rd8(bytes, offset)), R8(0)];  offset++; addr++; }
  else if (op === 0xE7) { mnemonic = 'out'; operands = [IMM(8, rd8(bytes, offset)), R16(0)]; offset++; addr++; }
  else if (op === 0xE8) {
    const rel = s16(rd16(bytes, offset)); offset += 2; addr += 2;
    mnemonic = 'call'; operands = [REL(16, rel, (addr + rel) & 0xFFFF)];
  }
  else if (op === 0xE9) {
    const rel = s16(rd16(bytes, offset)); offset += 2; addr += 2;
    mnemonic = 'jmp'; operands = [REL(16, rel, (addr + rel) & 0xFFFF)];
  }
  else if (op === 0xEA) {
    const offAbs = rd16(bytes, offset); const segAbs = rd16(bytes, offset + 2);
    offset += 4; addr += 4;
    mnemonic = 'jmp'; operands = [FAR(segAbs, offAbs)];
  }
  else if (op === 0xEB) {
    const rel = s8(bytes[offset++]); addr++;
    mnemonic = 'jmp'; operands = [REL(8, rel, (addr + rel) & 0xFFFF)];
  }
  else if (op === 0xEC) { mnemonic = 'in';  operands = [R8(0),  DX()]; }
  else if (op === 0xED) { mnemonic = 'in';  operands = [R16(0), DX()]; }
  else if (op === 0xEE) { mnemonic = 'out'; operands = [DX(), R8(0)];  }
  else if (op === 0xEF) { mnemonic = 'out'; operands = [DX(), R16(0)]; }
  else if (op === 0xF4) { mnemonic = 'hlt'; }
  else if (op === 0xF5) { mnemonic = 'cmc'; }
  // --- 0xF6/0xF7  group3 ---
  else if (op === 0xF6 || op === 0xF7) {
    const size = (op & 1) ? 16 : 8;
    const { reg: sub, rm, length } = decodeModRM(bytes, offset); offset += length; addr += length;
    mnemonic = GRP3[sub];
    const dst = rm.type === 'reg' ? (size === 8 ? R8(rm.idx) : R16(rm.idx)) : mem(rm, size);
    if (sub === 0 || sub === 1) { // TEST takes an immediate
      if (size === 8) { operands = [dst, IMM(8, rd8(bytes, offset))]; offset++; addr++; }
      else            { operands = [dst, IMM(16, rd16(bytes, offset))]; offset += 2; addr += 2; }
    } else {
      operands = [dst];
    }
  }
  else if (op === 0xF8) { mnemonic = 'clc'; }
  else if (op === 0xF9) { mnemonic = 'stc'; }
  else if (op === 0xFA) { mnemonic = 'cli'; }
  else if (op === 0xFB) { mnemonic = 'sti'; }
  else if (op === 0xFC) { mnemonic = 'cld'; }
  else if (op === 0xFD) { mnemonic = 'std'; }
  // --- 0xFE  group4 (inc/dec r/m8) ---
  else if (op === 0xFE) {
    const { reg: sub, rm, length } = decodeModRM(bytes, offset); offset += length; addr += length;
    mnemonic = GRP4[sub] || '?';
    const dst = rm.type === 'reg' ? R8(rm.idx) : mem(rm, 8);
    operands = [dst];
  }
  // --- 0xFF  group5 ---
  else if (op === 0xFF) {
    const { reg: sub, rm, length } = decodeModRM(bytes, offset); offset += length; addr += length;
    mnemonic = GRP5_FF[sub];
    // For call-far/jmp-far (sub 3,5) the operand is a 32-bit memory pointer; for push/call/jmp/inc/dec it's 16-bit
    const operandSize = (sub === 3 || sub === 5) ? 32 : 16;
    const dst = rm.type === 'reg' ? R16(rm.idx) : mem(rm, operandSize);
    operands = [dst];
  }
  else {
    // Unknown byte — emit as 'db' so disasm keeps walking
    mnemonic = 'db'; operands = [IMM(8, op)];
  }

  const length = offset - start;
  return {
    address: startAddr - (length - (offset - opStart)), // opStart was base address of opcode
    length,
    bytes: bytes.slice(start, offset),
    prefixes,
    mnemonic,
    operands,
  };
}
