// 8086 CPU core. Browser-safe. Drives the decoder from instruction_set.js.
//
// Status: functional subset — enough to run the PKLITE 1.15 stub prologue in .008.
// Opcodes implemented below cover: MOV/PUSH/POP/XCHG, ADD/SUB/CMP/AND/OR/XOR/TEST/INC/DEC/NEG/NOT,
// shifts/rotates, Jcc/JMP/LOOP/JCXZ, CALL/RET (near+far), string ops w/ REP,
// IN/OUT (trapped to bus), CLI/STI/CLD/STD/CLC/STC/CMC, LEA, segment MOVs, INT (dispatched to bus).
// Undocumented / FPU left to throw for now.

import { decode } from './instruction_set.js';
import { s8, s16 } from './modrm.js';
import { instructionCycles, TAKEN_BRANCH_EXTRA, REP_PER_ITER, FLUSH_MNEMONICS, memAccessBytes } from './cycles_8088.js';
import { biuCycles } from './cycles_8088_eu.js';

// Flag bit indices inside the 16-bit flags word (8086)
export const FLAG = {
  CF: 1 << 0, PF: 1 << 2, AF: 1 << 4, ZF: 1 << 6, SF: 1 << 7,
  TF: 1 << 8, IF: 1 << 9, DF: 1 << 10, OF: 1 << 11,
};

export function createCPU(mem, bus = {}, opts = {}) {
  // cycleModel: 'fixed' (legacy, 6 cyc/instr) or 'mnemonic' (per-instruction
  // EU cycles from cycles_8088.js). Defaults to 'fixed' to keep existing test
  // thresholds stable; flip to 'mnemonic' to get realistic timing.
  const CYCLE_MODEL = opts.cycleModel === 'biu' ? 'biu'
                    : opts.cycleModel === 'mnemonic' ? 'mnemonic'
                    : 'fixed';
  const r = {
    // Register pairs — all 16-bit; 8-bit accessors read/write halves.
    ax: 0, cx: 0, dx: 0, bx: 0, sp: 0, bp: 0, si: 0, di: 0,
    es: 0, cs: 0, ss: 0, ds: 0,
    ip: 0,
    flags: 0x0002, // bit 1 always set on 8086
    halted: false,
    // DRAM refresh cycle-steal model. Real PC/XT: PIT ch1 fires every 72 CPU
    // cycles and DMA ch0 steals ~4 cycles to refresh one DRAM row. Without
    // this tax, tight cycle-counted loops finish ~5% too fast and drift
    // against the CRTC raster. `refreshAcc` counts CPU cycles toward the
    // next refresh; step() folds the burst directly into its pixel-clock
    // return value.
    refreshAcc: 0,
  };
  const CYCLES_PER_STEP = 6;   // coarse 8088 average; BIU/prefetch not modeled
  const REFRESH_PERIOD  = 72;  // PIT ch1 cadence on 4.77 MHz XT
  const REFRESH_STEAL   = 4;   // CPU cycles stolen per refresh
  const PX_PER_CPU      = 3;   // CGA pixel clock = 3 × CPU clock (4.77 → 14.318 MHz)
  // Base pixel clocks per step, pre-refresh. Mean of (base + avg-steal) matches
  // the old empirical 18.35 constant that callers used in lockstep with the
  // CPU step rate. Shift the refresh contribution out of the base into
  // explicit bursts so cycle-raced effects see real cadence.
  const BASE_PX_PER_STEP = 17.35;
  const REFRESH_PX_BURST = REFRESH_STEAL * PX_PER_CPU;

  // --- 8-bit register access (al=lo(ax), ah=hi(ax); same for cx/dx/bx) ---
  const R16 = ['ax','cx','dx','bx','sp','bp','si','di'];
  const R8MAP = [ // idx → {reg, hi}
    {reg:'ax',hi:false},{reg:'cx',hi:false},{reg:'dx',hi:false},{reg:'bx',hi:false},
    {reg:'ax',hi:true }, {reg:'cx',hi:true }, {reg:'dx',hi:true }, {reg:'bx',hi:true },
  ];
  const SEG = ['es','cs','ss','ds'];

  function get16(i)    { return r[R16[i]]; }
  function set16(i, v) { r[R16[i]] = v & 0xFFFF; }
  function get8(i)     { const m = R8MAP[i]; return m.hi ? (r[m.reg] >> 8) & 0xFF : r[m.reg] & 0xFF; }
  function set8(i, v)  {
    const m = R8MAP[i], cur = r[m.reg];
    r[m.reg] = m.hi ? ((cur & 0x00FF) | ((v & 0xFF) << 8)) : ((cur & 0xFF00) | (v & 0xFF));
  }
  function getSeg(i)    { return r[SEG[i]]; }
  function setSeg(i, v) { r[SEG[i]] = v & 0xFFFF; }

  // --- Effective address for mem operand ---
  function eaBase(mem) {
    let ea = 0;
    if (mem.base) {
      if (mem.base === 'bx') ea += r.bx;
      else if (mem.base === 'bp') ea += r.bp;
    }
    if (mem.index) {
      if (mem.index === 'si') ea += r.si;
      else if (mem.index === 'di') ea += r.di;
    }
    ea = (ea + (mem.disp | 0)) & 0xFFFF;
    return ea;
  }
  function eaSeg(mem, segOverride) {
    if (segOverride) return r[segOverride];
    return r[mem.seg];
  }

  // --- Read/write an operand ---
  function readOp(op, segOverride) {
    switch (op.kind) {
      case 'reg':  return op.size === 8 ? get8(op.idx) : get16(op.idx);
      case 'seg':  return getSeg(op.idx);
      case 'imm':  return op.value & (op.size === 8 ? 0xFF : 0xFFFF);
      case 'rel':  return op.target & 0xFFFF;
      case 'mem': {
        const ea = eaBase(op);
        const seg = eaSeg(op, segOverride);
        const v = op.size === 8 ? mem.read8(seg, ea) : mem.read16(seg, ea);
        if (globalThis.__DEBUG_MEM) console.log(`   [readOp mem] ${seg.toString(16)}:${ea.toString(16)} (lin=${mem.linear(seg,ea).toString(16)}) size=${op.size} → 0x${v.toString(16)}`);
        return v;
      }
      case 'moff': {
        const seg = segOverride ? r[segOverride] : r[op.seg];
        return op.size === 8 ? mem.read8(seg, op.disp) : mem.read16(seg, op.disp);
      }
      case 'dx': return r.dx;
      case 'cl': return r.cx & 0xFF;
      case 'one': return 1;
      default: throw new Error(`readOp: unsupported kind ${op.kind}`);
    }
  }
  function writeOp(op, v, segOverride) {
    switch (op.kind) {
      case 'reg':  op.size === 8 ? set8(op.idx, v) : set16(op.idx, v); return;
      case 'seg':  setSeg(op.idx, v); return;
      case 'mem': {
        const ea = eaBase(op);
        const seg = eaSeg(op, segOverride);
        if (op.size === 8) mem.write8(seg, ea, v); else mem.write16(seg, ea, v);
        return;
      }
      case 'moff': {
        const seg = segOverride ? r[segOverride] : r[op.seg];
        if (op.size === 8) mem.write8(seg, op.disp, v); else mem.write16(seg, op.disp, v);
        return;
      }
      default: throw new Error(`writeOp: unsupported kind ${op.kind}`);
    }
  }

  // --- Flag helpers ---
  function setFlag(f, on) { r.flags = on ? (r.flags | f) : (r.flags & ~f); r.flags |= 0x0002; }
  function getFlag(f) { return (r.flags & f) !== 0; }
  function parity(v) {
    let x = v & 0xFF, c = 0;
    while (x) { c ^= x & 1; x >>= 1; }
    return !c;
  }
  // Arithmetic flag update helpers
  function flagsLogic(res, size) {
    const mask = size === 8 ? 0xFF : 0xFFFF;
    res &= mask;
    setFlag(FLAG.CF, false); setFlag(FLAG.OF, false); setFlag(FLAG.AF, false);
    setFlag(FLAG.ZF, res === 0);
    setFlag(FLAG.SF, (res & (size === 8 ? 0x80 : 0x8000)) !== 0);
    setFlag(FLAG.PF, parity(res));
  }
  function flagsAdd(a, b, size, withCarry = 0) {
    const mask = size === 8 ? 0xFF : 0xFFFF;
    const sign = size === 8 ? 0x80 : 0x8000;
    const sum = (a & mask) + (b & mask) + (withCarry ? 1 : 0);
    const res = sum & mask;
    setFlag(FLAG.CF, sum > mask);
    setFlag(FLAG.AF, (((a ^ b ^ res) & 0x10) !== 0));
    setFlag(FLAG.ZF, res === 0);
    setFlag(FLAG.SF, (res & sign) !== 0);
    setFlag(FLAG.PF, parity(res));
    setFlag(FLAG.OF, (((a ^ res) & (b ^ res) & sign) !== 0));
    return res;
  }
  function flagsSub(a, b, size, withBorrow = 0) {
    const mask = size === 8 ? 0xFF : 0xFFFF;
    const sign = size === 8 ? 0x80 : 0x8000;
    const diff = (a & mask) - (b & mask) - (withBorrow ? 1 : 0);
    const res = diff & mask;
    setFlag(FLAG.CF, diff < 0);
    setFlag(FLAG.AF, (((a ^ b ^ res) & 0x10) !== 0));
    setFlag(FLAG.ZF, res === 0);
    setFlag(FLAG.SF, (res & sign) !== 0);
    setFlag(FLAG.PF, parity(res));
    setFlag(FLAG.OF, (((a ^ b) & (a ^ res) & sign) !== 0));
    return res;
  }

  // --- Stack helpers ---
  function push16(v) { r.sp = (r.sp - 2) & 0xFFFF; mem.write16(r.ss, r.sp, v); }
  function pop16()   { const v = mem.read16(r.ss, r.sp); r.sp = (r.sp + 2) & 0xFFFF; return v; }

  // --- Condition codes (0..15) → predicate ---
  function cond(cc) {
    const F = FLAG;
    switch (cc) {
      case 0:  return  getFlag(F.OF);
      case 1:  return !getFlag(F.OF);
      case 2:  return  getFlag(F.CF);
      case 3:  return !getFlag(F.CF);
      case 4:  return  getFlag(F.ZF);
      case 5:  return !getFlag(F.ZF);
      case 6:  return  getFlag(F.CF) || getFlag(F.ZF);
      case 7:  return !(getFlag(F.CF) || getFlag(F.ZF));
      case 8:  return  getFlag(F.SF);
      case 9:  return !getFlag(F.SF);
      case 10: return  getFlag(F.PF);
      case 11: return !getFlag(F.PF);
      case 12: return  getFlag(F.SF) !== getFlag(F.OF);
      case 13: return  getFlag(F.SF) === getFlag(F.OF);
      case 14: return (getFlag(F.SF) !== getFlag(F.OF)) || getFlag(F.ZF);
      case 15: return !(getFlag(F.SF) !== getFlag(F.OF)) && !getFlag(F.ZF);
    }
    return false;
  }

  // --- Read one instruction from CS:IP ---
  function fetch() {
    // Copy up to 8 bytes into a small buffer (covers all 8086 encodings + prefixes)
    const base = mem.linear(r.cs, r.ip);
    const scratch = mem.buf.subarray(base, Math.min(base + 16, mem.buf.length));
    return decode(scratch, 0, r.ip);
  }

  // --- Main execute step ---
  // Returns pixel clocks elapsed during this step (base + bursty refresh),
  // so callers can feed that count uniformly into cga.tick()/pit.tick().
  // Advances the refresh model and pixel-clock budget even when halted —
  // the CPU clock keeps running; HLT just waits for an interrupt.
  // Per-step state for the mnemonic cycle model. exec() / branch handlers
  // update these so step() can bill the right number of cycles.
  let _branchTaken = false;
  let _repIterations = 0;

  // --- 8088 BIU / prefetch queue model (mnemonic path only) ---
  // The 8088 BIU is 8 bits wide and the instruction queue holds up to 4 bytes.
  // One byte is fetched every 4 CPU cycles when the BIU is idle (no data mem
  // access in progress). EU consumes insn.length bytes per instruction; if
  // the queue doesn't have enough, EU stalls. Taken branches / calls / rets
  // flush the queue. We account for this by charging
  //   cyc = max(eu_cycles, fetchWait + memAccessCycles)
  // where fetchWait = (bytes_needed - queueBytes) * 4 and memAccessCycles
  // covers the explicit data-bus ops. During `cyc` cycles, BIU free time
  // = cyc - memAccessCycles; it refills the queue at 1 byte / 4 cyc.
  //
  // Caveat: Intel Table 2-20 values already bake in a worst-case refetch, so
  // replacing eu_cycles wholesale with this formula double-counts. For now
  // `max(eu, fetchWait+memCyc)` rarely beats eu — it's scaffolding for a
  // future pure-EU table where we strip the baked-in fetch out of Intel's
  // figures for flush/memory-heavy ops and let this model compute it instead.
  const QUEUE_MAX = 4;
  const BIU_BYTE_CYCLES = 4;  // 8088: 4 cyc per byte fetched/accessed
  let queueBytes = 0;

  function step() {
    if (CYCLE_MODEL === 'fixed') {
      let px = BASE_PX_PER_STEP;
      r.refreshAcc += CYCLES_PER_STEP;
      if (r.refreshAcc >= REFRESH_PERIOD) {
        r.refreshAcc -= REFRESH_PERIOD;
        px += REFRESH_PX_BURST;
      }
      if (r.halted) return px;
      const insn = fetch();
      const nextIP = (r.ip + insn.length) & 0xFFFF;
      const segOv = insn.prefixes.seg;
      r.ip = nextIP;
      exec(insn, segOv);
      if (mem.stall && mem.stall.acc > 0) {
        px += mem.stall.acc * PX_PER_CPU;
        mem.stall.acc = 0;
      }
      return px;
    }

    // Mnemonic model: charge per-instruction EU cycles.
    if (r.halted) {
      // HLT idle tick: 4 cpu cycles per step (arbitrary small bound — keeps
      // the raster / PIT advancing at roughly real cadence while waiting
      // for an IRQ).
      const hcyc = 4;
      r.refreshAcc += hcyc;
      let hpx = hcyc * PX_PER_CPU;
      if (r.refreshAcc >= REFRESH_PERIOD) { r.refreshAcc -= REFRESH_PERIOD; hpx += REFRESH_PX_BURST; }
      return hpx;
    }
    const insn = fetch();
    const nextIP = (r.ip + insn.length) & 0xFFFF;
    const segOv = insn.prefixes.seg;
    r.ip = nextIP;
    _branchTaken = false;
    _repIterations = 0;
    exec(insn, segOv);

    let cyc;
    if (CYCLE_MODEL === 'biu') {
      const r2 = biuCycles(insn, queueBytes, _branchTaken);
      cyc = r2.cyc;
      // Note: queueBytes is updated below (post-prefix) to keep the existing
      // scaffolding's accounting in one place; biuCycles' queueAfter is the
      // authoritative figure but we recompute consistently here.
      queueBytes = r2.queueAfter;
    } else {
      cyc = instructionCycles(insn);
      if (_branchTaken) cyc += TAKEN_BRANCH_EXTRA;
    }
    if (_repIterations > 0) {
      // REP string ops: 9 setup already folded into TAB base; add per-iter.
      const per = REP_PER_ITER[insn.mnemonic] ?? 0;
      cyc = 9 + per * _repIterations;
    }
    // Instruction prefixes (seg override, LOCK, REP w/o iteration) cost 2 ea.
    for (const k of Object.keys(insn.prefixes || {})) {
      if (insn.prefixes[k]) cyc += 2;
    }
    // Prefetch queue accounting (scaffolding). Queue state is tracked so a
    // future pure-EU table can compute real BIU stalls via `max(pureEU,
    // fetchWait+memCyc)` — but the cyc charge is deliberately left alone.
    // Tried enabling the max rule (for non-flush mnemonics only, with push/
    // pushf decomposed) — calibration went from 3890 → 4101. Intel Table 2-20
    // values for simple ops (mov imm, out, in) already implicitly assume
    // queue-full; adding fetchWait+memCyc on top double-counts. Unlock only
    // once per-mnemonic pure-EU data is decomposed from real-HW T-state
    // traces, not back-calculated from Intel alone.
    //
    // Reference data now available locally:
    //   - test/8088_cycles_hw.json — best-case totals per opcode
    //     (extracted from SingleStepTests/8088 v2:
    //      https://github.com/SingleStepTests/8088 ).
    //   - Algorithm reference: MartyPC blog,
    //     https://martypc.blogspot.com/2023/08/the-8088-prefetch-algorithm.html
    //   - reenigne, http://www.reenigne.org/blog/ (8088 cycle accuracy posts).
    if (CYCLE_MODEL === 'mnemonic') {
      // Mnemonic-path queue accounting: drain consumed bytes, refill with
      // BIU-free cycles. The biu path manages queueBytes itself via biuCycles.
      const memCyc = memAccessBytes(insn) * BIU_BYTE_CYCLES;
      queueBytes = Math.max(0, queueBytes - insn.length);
      const biuFreeCyc = Math.max(0, cyc - memCyc);
      queueBytes = Math.min(QUEUE_MAX, queueBytes + (biuFreeCyc / BIU_BYTE_CYCLES | 0));
      if (_branchTaken || FLUSH_MNEMONICS.has(insn.mnemonic)) queueBytes = 0;
    }

    r.refreshAcc += cyc;
    let px = cyc * PX_PER_CPU;
    while (r.refreshAcc >= REFRESH_PERIOD) {
      r.refreshAcc -= REFRESH_PERIOD;
      px += REFRESH_PX_BURST;
    }
    if (mem.stall && mem.stall.acc > 0) {
      px += mem.stall.acc * PX_PER_CPU;
      mem.stall.acc = 0;
    }
    return px;
  }

  function exec(insn, segOv) {
    const [d, s] = insn.operands;
    const sizeOf = (op) => op?.size ?? (op?.kind === 'reg' ? (op.size || 16) : 16);
    const m = insn.mnemonic;

    switch (m) {
      case 'nop': case 'wait': return;
      case 'cli': setFlag(FLAG.IF, false); return;
      case 'sti': setFlag(FLAG.IF, true);  return;
      case 'cld': setFlag(FLAG.DF, false); return;
      case 'std': setFlag(FLAG.DF, true);  return;
      case 'clc': setFlag(FLAG.CF, false); return;
      case 'stc': setFlag(FLAG.CF, true);  return;
      case 'cmc': r.flags ^= FLAG.CF; return;
      case 'hlt': r.halted = true; return;

      case 'mov':  writeOp(d, readOp(s, segOv), segOv); return;
      case 'lea':  writeOp(d, eaBase(s), segOv); return;
      case 'lds':
      case 'les': {
        // Load 32-bit far pointer from [s] into d:segment. LDS → DS, LES → ES.
        if (s.kind !== 'mem') throw new Error(`${m} with non-mem source`);
        const ea  = eaBase(s);
        const seg = eaSeg(s, segOv);
        const off = mem.read16(seg, ea);
        const sel = mem.read16(seg, (ea + 2) & 0xFFFF);
        writeOp(d, off, segOv);
        if (m === 'lds') r.ds = sel; else r.es = sel;
        return;
      }
      case 'xchg': {
        const a = readOp(d, segOv), b = readOp(s, segOv);
        writeOp(d, b, segOv); writeOp(s, a, segOv); return;
      }
      case 'push': {
        // op might be reg16, seg, or mem16
        let v = readOp(d, segOv);
        push16(v); return;
      }
      case 'pop': {
        const v = pop16();
        writeOp(d, v, segOv); return;
      }
      case 'pushf': push16(r.flags); return;
      case 'popf':  r.flags = pop16() | 0x0002; return;
      case 'sahf':  r.flags = (r.flags & 0xFF00) | (((r.ax >> 8) & 0xD5) | 0x02); return;
      case 'lahf':  r.ax = (r.ax & 0x00FF) | ((r.flags & 0xFF) << 8); return;

      case 'add': { const size = sizeOf(d); const res = flagsAdd(readOp(d,segOv), readOp(s,segOv), size); writeOp(d, res, segOv); return; }
      case 'adc': { const size = sizeOf(d); const res = flagsAdd(readOp(d,segOv), readOp(s,segOv), size, getFlag(FLAG.CF) ? 1 : 0); writeOp(d, res, segOv); return; }
      case 'sub': { const size = sizeOf(d); const res = flagsSub(readOp(d,segOv), readOp(s,segOv), size); writeOp(d, res, segOv); return; }
      case 'sbb': { const size = sizeOf(d); const res = flagsSub(readOp(d,segOv), readOp(s,segOv), size, getFlag(FLAG.CF) ? 1 : 0); writeOp(d, res, segOv); return; }
      case 'cmp': { const size = sizeOf(d); flagsSub(readOp(d,segOv), readOp(s,segOv), size); return; }
      case 'and': { const size = sizeOf(d); const res = readOp(d,segOv) & readOp(s,segOv); flagsLogic(res, size); writeOp(d, res, segOv); return; }
      case 'or':  { const size = sizeOf(d); const res = readOp(d,segOv) | readOp(s,segOv); flagsLogic(res, size); writeOp(d, res, segOv); return; }
      case 'xor': { const size = sizeOf(d); const res = readOp(d,segOv) ^ readOp(s,segOv); flagsLogic(res, size); writeOp(d, res, segOv); return; }
      case 'test':{ const size = sizeOf(d); flagsLogic(readOp(d,segOv) & readOp(s,segOv), size); return; }
      case 'inc': { const size = sizeOf(d); const cf = getFlag(FLAG.CF); const res = flagsAdd(readOp(d,segOv), 1, size); setFlag(FLAG.CF, cf); writeOp(d, res, segOv); return; }
      case 'dec': { const size = sizeOf(d); const cf = getFlag(FLAG.CF); const res = flagsSub(readOp(d,segOv), 1, size); setFlag(FLAG.CF, cf); writeOp(d, res, segOv); return; }
      case 'neg': { const size = sizeOf(d); const v = readOp(d,segOv); const res = flagsSub(0, v, size); writeOp(d, res, segOv); return; }
      case 'not': { const size = sizeOf(d); const mask = size === 8 ? 0xFF : 0xFFFF; writeOp(d, (~readOp(d,segOv)) & mask, segOv); return; }

      case 'shl': case 'sal': return doShift(d, s, segOv, 'shl');
      case 'shr':             return doShift(d, s, segOv, 'shr');
      case 'sar':             return doShift(d, s, segOv, 'sar');
      case 'rol':             return doShift(d, s, segOv, 'rol');
      case 'ror':             return doShift(d, s, segOv, 'ror');
      case 'rcl':             return doShift(d, s, segOv, 'rcl');
      case 'rcr':             return doShift(d, s, segOv, 'rcr');

      case 'jo':case 'jno':case 'jb':case 'jnb':case 'jz':case 'jnz':
      case 'jbe':case 'jnbe':case 'js':case 'jns':case 'jp':case 'jnp':
      case 'jl':case 'jnl':case 'jle':case 'jnle': {
        const ccIdx = [
          'jo','jno','jb','jnb','jz','jnz','jbe','jnbe',
          'js','jns','jp','jnp','jl','jnl','jle','jnle'
        ].indexOf(m);
        if (cond(ccIdx)) { r.ip = d.target & 0xFFFF; _branchTaken = true; }
        return;
      }
      case 'jmp': {
        if (d.kind === 'rel') r.ip = d.target & 0xFFFF;
        else if (d.kind === 'far') { r.cs = d.seg; r.ip = d.off; }
        else { r.ip = readOp(d, segOv) & 0xFFFF; } // near indirect: JMP r/m16
        return;
      }
      case 'call': {
        if (d.kind === 'rel') { push16(r.ip); r.ip = d.target & 0xFFFF; return; }
        if (d.kind === 'far') { push16(r.cs); push16(r.ip); r.cs = d.seg; r.ip = d.off; return; }
        // Near indirect: CALL r/m16
        const tgt = readOp(d, segOv) & 0xFFFF;
        push16(r.ip); r.ip = tgt; return;
      }
      case 'call far': {
        if (d.kind !== 'mem') throw new Error('call far: expected mem operand');
        const ea  = eaBase(d);
        const seg = eaSeg(d, segOv);
        const off = mem.read16(seg, ea);
        const sel = mem.read16(seg, (ea + 2) & 0xFFFF);
        push16(r.cs); push16(r.ip);
        r.cs = sel; r.ip = off; return;
      }
      case 'jmp far': {
        if (d.kind !== 'mem') throw new Error('jmp far: expected mem operand');
        const ea  = eaBase(d);
        const seg = eaSeg(d, segOv);
        const off = mem.read16(seg, ea);
        const sel = mem.read16(seg, (ea + 2) & 0xFFFF);
        r.cs = sel; r.ip = off; return;
      }
      case 'ret':  { r.ip = pop16(); if (d) r.sp = (r.sp + d.value) & 0xFFFF; return; }
      case 'retf': { r.ip = pop16(); r.cs = pop16(); if (d) r.sp = (r.sp + d.value) & 0xFFFF; return; }
      case 'int':  return doInt(d.value);
      case 'int3': return doInt(3);
      case 'iret': { r.ip = pop16(); r.cs = pop16(); r.flags = pop16() | 0x0002; return; }
      case 'loop':   { r.cx = (r.cx - 1) & 0xFFFF; if (r.cx !== 0) { r.ip = d.target & 0xFFFF; _branchTaken = true; } return; }
      case 'loopz':  { r.cx = (r.cx - 1) & 0xFFFF; if (r.cx !== 0 &&  getFlag(FLAG.ZF)) { r.ip = d.target & 0xFFFF; _branchTaken = true; } return; }
      case 'loopnz': { r.cx = (r.cx - 1) & 0xFFFF; if (r.cx !== 0 && !getFlag(FLAG.ZF)) { r.ip = d.target & 0xFFFF; _branchTaken = true; } return; }
      case 'jcxz':   { if (r.cx === 0) { r.ip = d.target & 0xFFFF; _branchTaken = true; } return; }

      case 'movsb': case 'movsw': return doStringOp(insn, m, segOv);
      case 'stosb': case 'stosw': return doStringOp(insn, m, segOv);
      case 'lodsb': case 'lodsw': return doStringOp(insn, m, segOv);
      case 'scasb': case 'scasw': return doStringOp(insn, m, segOv);
      case 'cmpsb': case 'cmpsw': return doStringOp(insn, m, segOv);

      case 'in':  {
        const port = s.kind === 'dx' ? r.dx : s.value;
        const size = d.size;
        if (!bus.inPort) { writeOp(d, size === 16 ? 0xFFFF : 0xFF, segOv); return; }
        // 8088 bus issues sequential byte accesses for word port I/O.
        const v = size === 16
          ? (bus.inPort(port, 8) & 0xFF) | ((bus.inPort((port + 1) & 0xFFFF, 8) & 0xFF) << 8)
          : bus.inPort(port, 8);
        writeOp(d, v, segOv);
        return;
      }
      case 'out': {
        const port = d.kind === 'dx' ? r.dx : d.value;
        const size = s.size;
        const v = readOp(s, segOv);
        if (bus.outPort) {
          if (size === 16) { bus.outPort(port, v & 0xFF, 8); bus.outPort((port + 1) & 0xFFFF, (v >> 8) & 0xFF, 8); }
          else             { bus.outPort(port, v & 0xFF, 8); }
        }
        return;
      }

      case 'mul': {
        const v = readOp(d, segOv);
        if (d.size === 8) {
          const res = (r.ax & 0xFF) * (v & 0xFF);
          r.ax = res & 0xFFFF;
          const of = (res & 0xFF00) !== 0;
          setFlag(FLAG.CF, of); setFlag(FLAG.OF, of);
        } else {
          const res = (r.ax & 0xFFFF) * (v & 0xFFFF);
          r.ax = res & 0xFFFF; r.dx = (res >>> 16) & 0xFFFF;
          const of = r.dx !== 0;
          setFlag(FLAG.CF, of); setFlag(FLAG.OF, of);
        }
        return;
      }
      case 'imul': {
        const v = readOp(d, segOv);
        if (d.size === 8) {
          const a = ((r.ax & 0xFF) << 24) >> 24;
          const b = ((v & 0xFF) << 24) >> 24;
          const res = a * b;
          r.ax = res & 0xFFFF;
          const of = (res < -128 || res > 127);
          setFlag(FLAG.CF, of); setFlag(FLAG.OF, of);
        } else {
          const a = ((r.ax & 0xFFFF) << 16) >> 16;
          const b = ((v & 0xFFFF) << 16) >> 16;
          const res = a * b;
          r.ax = res & 0xFFFF; r.dx = (res >> 16) & 0xFFFF;
          const of = (res < -32768 || res > 32767);
          setFlag(FLAG.CF, of); setFlag(FLAG.OF, of);
        }
        return;
      }
      case 'div': {
        const v = readOp(d, segOv);
        if (v === 0) return doInt(0);
        if (d.size === 8) {
          const num = r.ax & 0xFFFF;
          const q = Math.floor(num / (v & 0xFF));
          const rem = num % (v & 0xFF);
          if (q > 0xFF) return doInt(0);
          r.ax = ((rem & 0xFF) << 8) | (q & 0xFF);
        } else {
          const num = ((r.dx & 0xFFFF) * 0x10000) + (r.ax & 0xFFFF);
          const q = Math.floor(num / (v & 0xFFFF));
          const rem = num % (v & 0xFFFF);
          if (q > 0xFFFF) return doInt(0);
          r.ax = q & 0xFFFF; r.dx = rem & 0xFFFF;
        }
        return;
      }
      case 'idiv': {
        const vRaw = readOp(d, segOv);
        if (vRaw === 0) return doInt(0);
        if (d.size === 8) {
          const v = ((vRaw & 0xFF) << 24) >> 24;
          const num = ((r.ax & 0xFFFF) << 16) >> 16;
          const q = (num / v) | 0;
          const rem = num - q * v;
          if (q > 127 || q < -128) return doInt(0);
          r.ax = ((rem & 0xFF) << 8) | (q & 0xFF);
        } else {
          const v = ((vRaw & 0xFFFF) << 16) >> 16;
          // 32-bit signed dividend from DX:AX — use BigInt for safety.
          const num = BigInt((r.dx << 16) | r.ax) << 32n >> 32n; // sign-extend 32→BigInt
          const nSigned = BigInt.asIntN(32, (BigInt(r.dx) << 16n) | BigInt(r.ax));
          const bv = BigInt(v);
          const q = nSigned / bv;
          const rem = nSigned - q * bv;
          if (q > 32767n || q < -32768n) return doInt(0);
          r.ax = Number(q & 0xFFFFn); r.dx = Number(rem & 0xFFFFn);
        }
        return;
      }
      case 'xlat': case 'xlatb': {
        const seg = segOv ? r[segOv] : r.ds;
        const al  = mem.read8(seg, (r.bx + (r.ax & 0xFF)) & 0xFFFF);
        r.ax = (r.ax & 0xFF00) | al;
        return;
      }
      case 'cbw':  r.ax = (r.ax & 0xFF) | ((r.ax & 0x80) ? 0xFF00 : 0); return;
      case 'salc': r.ax = (r.ax & 0xFF00) | ((r.flags & 0x0001) ? 0xFF : 0x00); return;
      case 'esc':  return; // 8087 coprocessor — no FPU on target; decoder consumed the ModR/M bytes
      case 'wait': return; // FWAIT — no-op without FPU
      case 'cwd':  r.dx = (r.ax & 0x8000) ? 0xFFFF : 0; return;

      case 'daa': {
        let al = r.ax & 0xFF;
        const oldCF = getFlag(FLAG.CF);
        let newCF = false;
        if ((al & 0x0F) > 9 || getFlag(FLAG.AF)) { al += 6; setFlag(FLAG.AF, true); } else setFlag(FLAG.AF, false);
        if (al > 0x9F || oldCF) { al += 0x60; newCF = true; }
        r.ax = (r.ax & 0xFF00) | (al & 0xFF);
        setFlag(FLAG.CF, newCF);
        setFlag(FLAG.ZF, (al & 0xFF) === 0);
        setFlag(FLAG.SF, (al & 0x80) !== 0);
        setFlag(FLAG.PF, parity(al));
        return;
      }
      case 'das': {
        let al = r.ax & 0xFF;
        const oldCF = getFlag(FLAG.CF);
        let newCF = false;
        if ((al & 0x0F) > 9 || getFlag(FLAG.AF)) { al -= 6; setFlag(FLAG.AF, true); } else setFlag(FLAG.AF, false);
        if ((al & 0xFF) > 0x9F || oldCF) { al -= 0x60; newCF = true; }
        r.ax = (r.ax & 0xFF00) | (al & 0xFF);
        setFlag(FLAG.CF, newCF);
        setFlag(FLAG.ZF, (al & 0xFF) === 0);
        setFlag(FLAG.SF, (al & 0x80) !== 0);
        setFlag(FLAG.PF, parity(al));
        return;
      }
      case 'aaa': {
        let al = r.ax & 0xFF, ah = (r.ax >> 8) & 0xFF;
        if ((al & 0x0F) > 9 || getFlag(FLAG.AF)) {
          al = (al + 6) & 0xFF; ah = (ah + 1) & 0xFF;
          setFlag(FLAG.AF, true); setFlag(FLAG.CF, true);
        } else { setFlag(FLAG.AF, false); setFlag(FLAG.CF, false); }
        r.ax = (ah << 8) | (al & 0x0F);
        return;
      }
      case 'aas': {
        let al = r.ax & 0xFF, ah = (r.ax >> 8) & 0xFF;
        if ((al & 0x0F) > 9 || getFlag(FLAG.AF)) {
          al = (al - 6) & 0xFF; ah = (ah - 1) & 0xFF;
          setFlag(FLAG.AF, true); setFlag(FLAG.CF, true);
        } else { setFlag(FLAG.AF, false); setFlag(FLAG.CF, false); }
        r.ax = (ah << 8) | (al & 0x0F);
        return;
      }
      case 'aam': {
        const base = (d?.value ?? 10) & 0xFF;
        if (base === 0) return doInt(0);
        const al = r.ax & 0xFF;
        const ah = Math.floor(al / base) & 0xFF;
        const nal = (al % base) & 0xFF;
        r.ax = (ah << 8) | nal;
        setFlag(FLAG.ZF, nal === 0); setFlag(FLAG.SF, (nal & 0x80) !== 0); setFlag(FLAG.PF, parity(nal));
        return;
      }
      case 'aad': {
        const base = (d?.value ?? 10) & 0xFF;
        const al = r.ax & 0xFF, ah = (r.ax >> 8) & 0xFF;
        const nal = (al + ah * base) & 0xFF;
        r.ax = nal;
        setFlag(FLAG.ZF, nal === 0); setFlag(FLAG.SF, (nal & 0x80) !== 0); setFlag(FLAG.PF, parity(nal));
        return;
      }

      case 'db':   throw new Error(`illegal opcode at cs:ip=${r.cs.toString(16)}:${(r.ip - insn.length).toString(16)} byte ${insn.bytes[0]?.toString(16)}`);
      default:     throw new Error(`unimplemented: ${m}`);
    }
  }

  function doShift(d, s, segOv, kind) {
    const size = d.size || 16;
    const mask = size === 8 ? 0xFF : 0xFFFF;
    const signBit = size === 8 ? 0x80 : 0x8000;
    let v = readOp(d, segOv) & mask;
    let cnt = s.kind === 'cl' ? (r.cx & 0xFF) : (s.kind === 'one' ? 1 : readOp(s, segOv) & 0x1F);
    if (cnt === 0) return;
    let cf = getFlag(FLAG.CF) ? 1 : 0;
    for (let i = 0; i < cnt; i++) {
      switch (kind) {
        case 'shl': cf = (v & signBit) ? 1 : 0; v = (v << 1) & mask; break;
        case 'shr': cf = v & 1; v = v >>> 1; break;
        case 'sar': cf = v & 1; v = (v & signBit) ? ((v >>> 1) | signBit) : (v >>> 1); break;
        case 'rol': cf = (v & signBit) ? 1 : 0; v = ((v << 1) | cf) & mask; break;
        case 'ror': cf = v & 1; v = ((v >>> 1) | (cf ? signBit : 0)) & mask; break;
        case 'rcl': { const nb = (v & signBit) ? 1 : 0; v = ((v << 1) | cf) & mask; cf = nb; break; }
        case 'rcr': { const nb = v & 1; v = ((v >>> 1) | (cf ? signBit : 0)) & mask; cf = nb; break; }
      }
    }
    setFlag(FLAG.CF, !!cf);
    if (cnt === 1) {
      // OF defined only for count=1
      if (kind === 'shl' || kind === 'sal') setFlag(FLAG.OF, ((v & signBit) !== 0) !== !!cf);
      else if (kind === 'shr') setFlag(FLAG.OF, (readOp(d, segOv) & signBit) !== 0);
      else if (kind === 'sar') setFlag(FLAG.OF, false);
      else if (kind === 'rol' || kind === 'rcl') setFlag(FLAG.OF, ((v & signBit) !== 0) !== !!cf);
      else if (kind === 'ror' || kind === 'rcr') setFlag(FLAG.OF, ((v & signBit) !== 0) !== (((v >>> (size-1-1)) & 1) !== 0));
    }
    // For non-rotate, also set SF/ZF/PF
    if (kind === 'shl' || kind === 'sal' || kind === 'shr' || kind === 'sar') {
      setFlag(FLAG.ZF, v === 0);
      setFlag(FLAG.SF, (v & signBit) !== 0);
      setFlag(FLAG.PF, parity(v));
    }
    writeOp(d, v, segOv);
  }

  function doStringOp(insn, m, segOv) {
    const isWord = m.endsWith('w');
    const size = isWord ? 16 : 8;
    const step = (isWord ? 2 : 1) * (getFlag(FLAG.DF) ? -1 : 1);
    const rep = insn.prefixes.rep;
    const srcSeg = segOv ? r[segOv] : r.ds;
    const dstSeg = r.es;

    const one = () => {
      switch (m) {
        case 'movsb': case 'movsw': {
          const v = isWord ? mem.read16(srcSeg, r.si) : mem.read8(srcSeg, r.si);
          if (isWord) mem.write16(dstSeg, r.di, v); else mem.write8(dstSeg, r.di, v);
          r.si = (r.si + step) & 0xFFFF; r.di = (r.di + step) & 0xFFFF;
          return null;
        }
        case 'stosb': case 'stosw': {
          const v = isWord ? (r.ax & 0xFFFF) : (r.ax & 0xFF);
          if (isWord) mem.write16(dstSeg, r.di, v); else mem.write8(dstSeg, r.di, v);
          r.di = (r.di + step) & 0xFFFF;
          return null;
        }
        case 'lodsb': case 'lodsw': {
          const v = isWord ? mem.read16(srcSeg, r.si) : mem.read8(srcSeg, r.si);
          if (isWord) r.ax = v; else r.ax = (r.ax & 0xFF00) | (v & 0xFF);
          r.si = (r.si + step) & 0xFFFF;
          return null;
        }
        case 'scasb': case 'scasw': {
          const a = isWord ? (r.ax & 0xFFFF) : (r.ax & 0xFF);
          const b = isWord ? mem.read16(dstSeg, r.di) : mem.read8(dstSeg, r.di);
          flagsSub(a, b, size);
          r.di = (r.di + step) & 0xFFFF;
          return getFlag(FLAG.ZF);
        }
        case 'cmpsb': case 'cmpsw': {
          const a = isWord ? mem.read16(srcSeg, r.si) : mem.read8(srcSeg, r.si);
          const b = isWord ? mem.read16(dstSeg, r.di) : mem.read8(dstSeg, r.di);
          flagsSub(a, b, size);
          r.si = (r.si + step) & 0xFFFF; r.di = (r.di + step) & 0xFFFF;
          return getFlag(FLAG.ZF);
        }
      }
    };

    if (!rep) { one(); return; }
    // REP variants
    let iter = 0;
    while (r.cx !== 0) {
      const zf = one();
      r.cx = (r.cx - 1) & 0xFFFF;
      iter++;
      if (zf !== null) {
        if (rep === 'rep'   && !zf) break; // REPE / REPZ
        if (rep === 'repnz' &&  zf) break;
      }
    }
    _repIterations = iter;
  }

  function doInt(n) {
    if (bus.int) { const handled = bus.int(n, r); if (handled) return; }
    // Default behavior: push flags/cs/ip, read IVT. For our harness we prefer to let bus.int
    // handle all software ints; if it returns false, fall through to IVT dispatch.
    push16(r.flags);
    setFlag(FLAG.IF, false); setFlag(FLAG.TF, false);
    push16(r.cs); push16(r.ip);
    r.ip = mem.read16(0, n * 4);
    r.cs = mem.read16(0, n * 4 + 2);
  }

  // Hardware interrupt delivery (IRQ0..IRQ7). Called from outside the step
  // loop after checking IF=1. Pushes flags/cs/ip like a software INT but
  // does NOT call bus.int — hardware ints always vector through the IVT.
  function hwInt(n) {
    const off = mem.read16(0, n * 4), seg = mem.read16(0, n * 4 + 2);
    if (seg === 0 && off === 0) { r.halted = false; return false; }
    push16(r.flags);
    setFlag(FLAG.IF, false); setFlag(FLAG.TF, false);
    push16(r.cs); push16(r.ip);
    r.ip = off; r.cs = seg;
    r.halted = false;
    queueBytes = 0;
    return true;
  }

  return { r, step, exec, push16, pop16, get8, get16, set8, set16, getSeg, setSeg, eaBase, readOp, writeOp, getFlag, setFlag, hwInt };
}
