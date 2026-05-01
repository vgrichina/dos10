// 8088 per-instruction cycle counts.
//
// Sources:
//   - Intel 8086 Family User's Manual, Table 2-20 (EU execution timing) and
//     Table 2-21 (EA calculation penalties) — primary table values below.
//   - 8088-specific bus penalties: 8088 BIU is 8 bits wide, so every *word*
//     memory access costs +4 cycles over the 8086 figure (two sequential
//     byte transfers on the multiplexed bus).
//   - Hardware-validated reference: SingleStepTests/8088 v2 corpus
//     <https://github.com/SingleStepTests/8088> (Daniel Balsom, AMD D8088 1982
//     captured via Arduino8088). Extracted to `test/8088_cycles_hw.json` via
//     `test/extract_8088_cycles.js`; deltas reported by
//     `test/compare_cycles_to_hw.js`. Known undercharges vs HW median (NOT
//     applied — see proj_hw_cycle_reference memory): pushf 10→15, popf 8→12,
//     retf 26→33, iret 32→43, call near 19→23. Lifting these without a paired
//     BIU/queue overlap model regresses the launcher calibration.
//   - BIU/queue semantics: reenigne <http://www.reenigne.org/blog/> ("8088"
//     posts) and MartyPC
//     <https://martypc.blogspot.com/2023/08/the-8088-prefetch-algorithm.html>
//     ("The 8088 Prefetch Algorithm") +
//     <https://martypc.blogspot.com/2024/02/the-complete-bus-logic-of-intel-8088.html>.
//
// This does NOT yet model the 4-byte prefetch queue, BIU contention beyond
// B8000, or DRAM refresh — the CPU step loop still owns refresh. The table
// gives us realistic per-instruction EU cycles, which is the single biggest
// accuracy gap vs. the previous 6-cycles-for-everything stub.
//
// Opt-in: createCPU({ cycleModel: 'mnemonic' }) to use this table. Default
// stays on the fixed model so existing test thresholds don't shift.

// Effective-address penalty. Intel Table 2-21.
// Args match the operand shape we use in instruction_set.js:
//   { kind:'mem', base, index, disp, seg, size }
export function eaCycles(op) {
  if (!op || op.kind !== 'mem') return 0;
  const hasB = !!op.base, hasI = !!op.index;
  const hasD = (op.disp | 0) !== 0;
  // Direct address (no base/index, only disp)
  if (!hasB && !hasI) return 6;
  // Base only OR index only
  if (hasB !== hasI) return hasD ? 9 : 5;
  // Base + index
  // "Fast" pairs: BP+DI, BX+SI → 7 (or 11 w/ disp)
  // "Slow" pairs: BP+SI, BX+DI → 8 (or 12 w/ disp)
  const fast = (op.base === 'bp' && op.index === 'di') ||
               (op.base === 'bx' && op.index === 'si');
  return (fast ? 7 : 8) + (hasD ? 4 : 0);
}

// Base EU cycles per mnemonic / operand shape.
// Keys are the mnemonic strings produced by instruction_set.js decode().
// Value is either a number or a function(insn) → number.
const TAB = {
  nop: 3, wait: 3, hlt: 2,
  cli: 2, sti: 2, cld: 2, std: 2, clc: 2, stc: 2, cmc: 2,

  mov: (i) => movCyc(i),
  lea: (i) => 2 + eaCycles(i.operands[1]),
  // LDS/LES read 4 bytes (2 words) from mem → +8 on 8088 (2 word transfers).
  // HW-validated: SingleStepTests/8088 C4/C5 median=37 for [disp16] form
  // (EA=6); base=23 = Intel-16 + 7 unbilled overhead (memform fetch +
  // BIU stall on segment-load).
  lds: (i) => 23 + eaCycles(i.operands[1]) + 8,
  les: (i) => 23 + eaCycles(i.operands[1]) + 8,
  xchg: (i) => xchgCyc(i),
  push: (i) => pushCyc(i),
  pop:  (i) => popCyc(i),
  // HW-validated values (SingleStepTests/8088). Intel manual lists 10/8;
  // real silicon reports 15/12. Applied now that BIU model + PIT fix expose
  // the gap; previously masked by PIT running 3× too fast.
  // HW-validated medians: pushf 17, popf 13 (SingleStepTests/8088 9C/9D).
  // Intel manual lists 10/8.
  pushf: 17, popf: 13, sahf: 4, lahf: 4,

  add: (i) => aluCyc(i), sub: (i) => aluCyc(i),
  adc: (i) => aluCyc(i), sbb: (i) => aluCyc(i),
  cmp: (i) => cmpCyc(i),
  and: (i) => aluCyc(i), or:  (i) => aluCyc(i),
  xor: (i) => aluCyc(i), test:(i) => cmpCyc(i),
  inc: (i) => incDecCyc(i), dec: (i) => incDecCyc(i),
  neg: (i) => memOrReg(i, 3, 16),
  not: (i) => memOrReg(i, 3, 16),

  shl: (i) => shiftCyc(i), sal: (i) => shiftCyc(i),
  shr: (i) => shiftCyc(i), sar: (i) => shiftCyc(i),
  rol: (i) => shiftCyc(i), ror: (i) => shiftCyc(i),
  rcl: (i) => shiftCyc(i), rcr: (i) => shiftCyc(i),

  // Jcc: 16 taken / 4 not-taken. We don't know the outcome here; bill the
  // unconditional 4 here and let cpu.step() add the taken-branch penalty.
  jo: 4, jno: 4, jb: 4, jnb: 4, jz: 4, jnz: 4, jbe: 4, jnbe: 4,
  js: 4, jns: 4, jp: 4, jnp: 4, jl: 4, jnl: 4, jle: 4, jnle: 4,
  // jcxz: HW E3 not-taken=8 (Intel 6); cpu.step adds taken extra
  jcxz: 8,
  jmp: (i) => jmpCyc(i),
  call: (i) => callCyc(i),
  'call far': 36,
  'jmp far': 24,
  // Flush insns keep Intel's values — EU work and refetch are serial (EU
  // must update IP before BIU can fetch new target), so Intel's numbers are
  // already the additive sum pureEU + refetch. cpu.step intentionally does
  // NOT apply the BIU max-rule to these mnemonics (see FLUSH_MNEMONICS).
  // HW-validated medians (SingleStepTests/8088 C3/CB/CF): ret 21, retf 35,
  // iret 46. Intel manual: 16/26/32.
  ret: 21, retf: 35,
  // HW-validated (SingleStepTests/8088 v2 medians):
  // int imm (CD)=73, int 3 (CC)=73, into (CE)=72 taken, iret (CF)=46.
  // Intel manual: 51/52/53/32 — HW adds ~22 cycles for vector fetch + push frame.
  'int': 73, int3: 73, into: 72, iret: 46,
  // LOOP/LOOPZ/LOOPNZ: base = not-taken cost; cpu.step adds TAKEN_BRANCH_EXTRA
  // (12) when branch is taken, producing 17/18/19 for taken. Previously these
  // were set to 17/18/19 and we ALSO added +12 on taken → double-count.
  loop: 5, loopz: 6, loopnz: 5,

  // String-op single-iter HW medians (SingleStepTests/8088 A4–AF, no prefix):
  // movsb=19, movsw=27 (Intel 18/26). Others match Intel.
  movsb: 19, movsw: 27,
  stosb: 11, stosw: 15,
  lodsb: 12, lodsw: 16,
  scasb: 15, scasw: 19,
  cmpsb: 22, cmpsw: 30,

  'in':  (i) => (i.operands[1].kind === 'dx' ? 8 : 10) + ((i.operands[0]?.size === 16) ? 4 : 0),
  'out': (i) => (i.operands[0].kind === 'dx' ? 8 : 10) + ((i.operands[1]?.size === 16) ? 4 : 0),

  // mul/imul HW-validated (SingleStepTests/8088 F6.4/F6.5/F7.4/F7.5):
  // mul8=89 (Intel 77), mul16=145 (Intel 133), imul8=102 (Intel 86),
  // imul16=157 (Intel 144). Reg and mem medians agree → not data-dependent.
  // div/idiv left at Intel's max because HW medians are data-dependent
  // (8088 divide is iterative; reg-form HW tests bias low due to random
  // exception/overflow paths and aren't a clean median).
  mul:  (i) => (i.operands[0].size === 8 ? 89  : 145) + (isMem(i,0) ? 4+eaCycles(i.operands[0]) : 0),
  imul: (i) => (i.operands[0].size === 8 ? 102 : 157) + (isMem(i,0) ? 4+eaCycles(i.operands[0]) : 0),
  div:  (i) => (i.operands[0].size === 8 ? 90  : 162) + (isMem(i,0) ? 4+eaCycles(i.operands[0]) : 0),
  idiv: (i) => (i.operands[0].size === 8 ? 112 : 184) + (isMem(i,0) ? 4+eaCycles(i.operands[0]) : 0),

  xlat: 11, xlatb: 11,
  cbw: 2, cwd: 5, salc: 2, esc: 2,

  // aam/aad: HW-validated medians (SingleStepTests/8088 D4/D5). Intel manual
  // says 83/60; real silicon reports 77/63.
  daa: 4, das: 4, aaa: 4, aas: 4, aam: 77, aad: 63,
};

function isMem(insn, idx) { return insn.operands[idx]?.kind === 'mem'; }
function isReg(insn, idx) { return insn.operands[idx]?.kind === 'reg' || insn.operands[idx]?.kind === 'seg'; }
function word(op) { return op?.size === 16; }

// 8088 word-mem penalty: +4 cyc per word memory transfer (8088 BIU is 8-bit,
// each word = 2 sequential byte transfers, +4 over the 8086 figure).
function wordMemPenalty(op) {
  if (!op || (op.kind !== 'mem' && op.kind !== 'moff')) return 0;
  return op.size === 16 ? 4 : 0;
}
// RMW (read-modify-write) does 2 word transfers on word memory → +8.
function rmwWordMemPenalty(op) {
  if (!op || (op.kind !== 'mem' && op.kind !== 'moff')) return 0;
  return op.size === 16 ? 8 : 0;
}

// Code-fetch overhead for mem-form ModR/M opcodes. SingleStepTests/8088 v2
// shows mem-form ALU/MOV/CMP/XCHG/INC ops run +4 cyc over (Intel EU + EA +
// word penalty) — this is the BIU paying to refetch the multi-byte ModR/M+
// disp envelope. Applied to mem-form paths only.
const MEMFORM_CODE_FETCH = 4;

function movCyc(i) {
  const [d, s] = i.operands;
  if (isReg(i,0) && isReg(i,1)) return 2;
  if (isReg(i,0) && s.kind === 'imm') return 4;
  if (isMem(i,0) && s.kind === 'imm') return 10 + eaCycles(d) + wordMemPenalty(d) + MEMFORM_CODE_FETCH;
  if (isMem(i,0) && isReg(i,1))       return 9  + eaCycles(d) + wordMemPenalty(d) + MEMFORM_CODE_FETCH;
  if (isReg(i,0) && isMem(i,1))       return 8  + eaCycles(s) + wordMemPenalty(s) + MEMFORM_CODE_FETCH;
  if (d?.kind === 'moff' || s?.kind === 'moff') return 10 + wordMemPenalty(d) + wordMemPenalty(s) + MEMFORM_CODE_FETCH;
  return 2;
}

function aluCyc(i) {
  const [d, s] = i.operands;
  if (isReg(i,0) && isReg(i,1)) return 3;
  if (isReg(i,0) && s.kind === 'imm') return 4;
  if (isMem(i,0) && s.kind === 'imm') return 17 + eaCycles(d) + rmwWordMemPenalty(d) + MEMFORM_CODE_FETCH;
  if (isMem(i,0) && isReg(i,1))       return 16 + eaCycles(d) + rmwWordMemPenalty(d) + MEMFORM_CODE_FETCH;
  if (isReg(i,0) && isMem(i,1))       return 9  + eaCycles(s) + wordMemPenalty(s) + MEMFORM_CODE_FETCH;
  return 3;
}

function cmpCyc(i) {
  const [d, s] = i.operands;
  if (isReg(i,0) && isReg(i,1)) return 3;
  if (isReg(i,0) && s.kind === 'imm') return 4;
  if (isMem(i,0) && s.kind === 'imm') return 10 + eaCycles(d) + wordMemPenalty(d) + MEMFORM_CODE_FETCH;
  if (isMem(i,0) && isReg(i,1))       return 9  + eaCycles(d) + wordMemPenalty(d) + MEMFORM_CODE_FETCH;
  if (isReg(i,0) && isMem(i,1))       return 9  + eaCycles(s) + wordMemPenalty(s) + MEMFORM_CODE_FETCH;
  return 3;
}

function incDecCyc(i) {
  const [d] = i.operands;
  if (isReg(i,0)) return d.size === 8 ? 3 : 2;
  if (isMem(i,0)) return 15 + eaCycles(d) + rmwWordMemPenalty(d) + MEMFORM_CODE_FETCH;
  return 3;
}

function memOrReg(i, regC, memC) {
  const [d] = i.operands;
  if (isMem(i,0)) return memC + eaCycles(d) + rmwWordMemPenalty(d) + MEMFORM_CODE_FETCH;
  return regC;
}

function shiftCyc(i) {
  const [d, s] = i.operands;
  const isCL = s?.kind === 'cl';
  // Intel manual gives 15/20 for shift mem,1 / mem,CL; HW (SingleStepTests/8088
  // D0..D3 mem-form) shows median +4 over Intel for both forms. Bump base.
  // Shift mem-form base already absorbs the +4 mem-form code-fetch overhead
  // (HW med = Intel-15 + EA + word-RMW + 4 → use 19 base directly).
  const base = isMem(i,0)
    ? (isCL ? 24 : 19) + eaCycles(d) + rmwWordMemPenalty(d)
    : (isCL ? 8  : 2);
  // If count comes from CL we don't know N here; approximate mid (CL avg ~4).
  return isCL ? base + 4 * 4 : base;
}

function pushCyc(i) {
  const [d] = i.operands;
  if (d?.kind === 'reg') return 15;
  if (d?.kind === 'seg') return 14;
  // PUSH mem: 1 word read + 1 word stack write = 2 word transfers → +8 on 8088.
  if (d?.kind === 'mem') return 24 + eaCycles(d) + 8;
  return 15;
}
function popCyc(i) {
  const [d] = i.operands;
  if (d?.kind === 'reg') return 12;
  if (d?.kind === 'seg') return 12;
  // POP mem: 1 word stack read + 1 word mem write = 2 word transfers → +8.
  if (d?.kind === 'mem') return 25 + eaCycles(d) + 8;
  return 12;
}

function xchgCyc(i) {
  const [d, s] = i.operands;
  if (isReg(i,0) && isReg(i,1)) return 4;
  if (isMem(i,0) || isMem(i,1)) {
    const memOp = isMem(i,0) ? d : s;
    return 17 + eaCycles(memOp) + rmwWordMemPenalty(memOp) + MEMFORM_CODE_FETCH;
  }
  return 4;
}

// Flush insns keep Intel values (see FLUSH_MNEMONICS comment above).
function jmpCyc(i) {
  const [d] = i.operands;
  // HW-validated (SingleStepTests/8088): EB short=18 (Intel 15),
  // E9 near disp16=22 (Intel 15), EA far ptr=28 (Intel 15).
  // Distinguish short (1-byte rel) from near (2-byte rel) by operand size.
  if (d?.kind === 'rel') return d.size === 8 ? 18 : 22;
  if (d?.kind === 'far') return 28;
  if (d?.kind === 'mem') return 18 + eaCycles(d);
  return 11;
}

function callCyc(i) {
  const [d] = i.operands;
  // HW-validated: E8 call rel16 med=28 (Intel 19).
  if (d?.kind === 'rel') return 28;
  if (d?.kind === 'far') return 28;
  if (d?.kind === 'mem') return 21 + eaCycles(d);
  return 16;
}

export function instructionCycles(insn) {
  const entry = TAB[insn.mnemonic];
  if (entry === undefined) return 8; // conservative default for unknown
  return typeof entry === 'function' ? entry(insn) : entry;
}

// Extra cycles when a conditional branch is taken. Caller checks outcome.
export const TAKEN_BRANCH_EXTRA = 12; // 16 taken − 4 not-taken

// Mnemonics whose execution flushes the prefetch queue (branch taken, call,
// return, interrupt, unconditional jump). The cpu step loop uses this to
// reset queueBytes so the next instruction fetch pays real BIU time.
export const FLUSH_MNEMONICS = new Set([
  'jmp', 'call', 'call far', 'jmp far', 'ret', 'retf', 'iret', 'int', 'int3', 'into',
]);

// Number of explicit memory-access bytes this instruction performs (reads +
// writes of data operands, plus pushes/pops). Used to keep the BIU busy for
// that long so it can't prefetch simultaneously. This is an approximation:
// we attribute mem bytes from the first memory operand and add a fixed count
// for push/pop/call/ret/iret. Instruction-fetch bytes are accounted
// separately via queueBytes in cpu.step.
export function memAccessBytes(insn) {
  const m = insn.mnemonic;
  // Stack ops: each push/pop is 1 word = 2 bytes. CALL rel = 1 push (2 B).
  // CALL far / INT = 2 pushes (4 B) + INT adds flags push (6 B total for INT).
  // RET = 1 pop (2 B); RETF = 2 pops (4 B); IRET = 3 pops (6 B).
  if (m === 'push' || m === 'pop' || m === 'pushf' || m === 'popf') {
    const mem = (m === 'push' || m === 'pop') && isMem(insn, 0) ? 2 : 0;
    return 2 + mem;
  }
  if (m === 'call') return insn.operands[0]?.kind === 'far' ? 4 : 2;
  if (m === 'call far') return 4;
  if (m === 'ret')  return 2;
  if (m === 'retf') return 4;
  if (m === 'iret') return 6;
  if (m === 'int' || m === 'int3' || m === 'into') return 6;
  // Data operand: pick first memory operand's byte count.
  for (const op of insn.operands || []) {
    if (op?.kind === 'mem' || op?.kind === 'moff') {
      const sz = (op.size === 16) ? 2 : 1;
      // Both read and write for RMW ops (ADD/SUB/INC/etc. with mem dest);
      // conservative: 2× for ALU ops writing mem, 1× for pure loads/stores.
      const rmw = /^(add|sub|adc|sbb|and|or|xor|inc|dec|neg|not|shl|shr|sal|sar|rol|ror|rcl|rcr)$/.test(m);
      return sz * (rmw ? 2 : 1);
    }
  }
  return 0;
}

// REP string-op per-iteration cost (after the 9-cyc setup).
export const REP_PER_ITER = {
  movsb: 17, movsw: 25,
  stosb: 10, stosw: 14,
  lodsb: 13, lodsw: 17,
  scasb: 15, scasw: 19,
  cmpsb: 22, cmpsw: 30,
};
