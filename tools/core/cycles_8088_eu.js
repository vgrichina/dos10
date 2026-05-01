// 8088 cycle model — pure-EU + BIU decomposition variant.
//
// Replaces Intel Table 2-20 totals with hardware-validated decomposition for
// the subset of opcodes covered. For each known opcode we know:
//   - pureEU: cycles where the bus is idle (PASV) and EU is doing work
//   - memCyc: 4-cyc bus transfers for memory reads/writes
//   - ioCyc:  bus cycles for IOR/IOW
// On a flush instruction, the BIU also has to refetch enough bytes for the
// EU to consume the next opcode. We approximate that as `(2 - queueBytes) *
// BIU_BYTE_CYCLES` (need at least 2 bytes for any opcode + operand) with a
// floor of 0, only on flush mnemonics.
//
// Sources:
//   - Decomposition data: test/8088_cycles_decomposed.json (extracted by
//     test/decompose_eu_biu.js from SingleStepTests/8088 v2 traces).
//     https://github.com/SingleStepTests/8088
//   - Cycle/T-state semantics: MartyPC,
//     https://martypc.blogspot.com/2024/02/the-complete-bus-logic-of-intel-8088.html
//     https://martypc.blogspot.com/2023/08/the-8088-prefetch-algorithm.html
//   - Background: reenigne, http://www.reenigne.org/blog/

import { instructionCycles, eaCycles, memAccessBytes } from './cycles_8088.js';

// Keyed by opcode hex string. Values are { eu, mem, io, code } (cycles).
// `code` is the bytes-fetched component (codeCyc) measured from prefetched-queue
// HW tests; including it makes per-insn cyc match the HW median total.
// Source: test/8088_cycles_decomposed.json — median over 5000 prefetched-queue
// tests per opcode (snapshot below to keep core dependency-free).
const EU_TABLE = {
  EB: { eu: 12, mem: 0, io: 0, code: 4, flush: true  },  // jmp short, HW total=16
  E8: { eu: 15, mem: 4, io: 0, code: 4, flush: true  },  // call near, HW=23
  C3: { eu: 13, mem: 4, io: 0, code: 2, flush: true  },  // ret near, HW=19
  CB: { eu: 21, mem: 8, io: 0, code: 4, flush: true  },  // retf, HW=33
  CF: { eu: 27, mem:12, io: 0, code: 4, flush: true  },  // iret, HW=43
  '50': { eu: 9, mem: 4, io: 0, code: 2, flush: false }, // push, HW=15
  '51': { eu: 9, mem: 4, io: 0, code: 2, flush: false },
  '52': { eu: 9, mem: 4, io: 0, code: 2, flush: false },
  '53': { eu: 9, mem: 4, io: 0, code: 2, flush: false },
  '54': { eu: 9, mem: 4, io: 0, code: 2, flush: false },
  '55': { eu: 9, mem: 4, io: 0, code: 2, flush: false },
  '56': { eu: 9, mem: 4, io: 0, code: 2, flush: false },
  '57': { eu: 9, mem: 4, io: 0, code: 2, flush: false },
  '58': { eu: 8, mem: 4, io: 0, code: 0, flush: false }, // pop, HW=12
  '59': { eu: 8, mem: 4, io: 0, code: 0, flush: false },
  '5A': { eu: 8, mem: 4, io: 0, code: 0, flush: false },
  '5B': { eu: 8, mem: 4, io: 0, code: 0, flush: false },
  '5C': { eu: 8, mem: 4, io: 0, code: 0, flush: false },
  '5D': { eu: 8, mem: 4, io: 0, code: 0, flush: false },
  '5E': { eu: 8, mem: 4, io: 0, code: 0, flush: false },
  '5F': { eu: 8, mem: 4, io: 0, code: 0, flush: false },
  '9C': { eu: 7, mem: 4, io: 0, code: 4, flush: false }, // pushf, HW=15
  '9D': { eu: 6, mem: 4, io: 0, code: 2, flush: false }, // popf, HW=12
  // io values include the IBM PC ISA-bus 1-cyc fixed wait state (TW inserted
  // in every IOR/IOW). HW corpus from SingleStepTests/8088 was captured with
  // the i8288 emulated against the AMD chip and includes this wait state in
  // the bus phase, so io: 3/5 matches the captured HW total.
  E6: { eu: 7, mem: 0, io: 3, code: 2, flush: false },   // out imm,al, HW=12
  E7: { eu: 7, mem: 0, io: 5, code: 2, flush: false },   // out imm,ax
  E4: { eu: 6, mem: 0, io: 3, code: 2, flush: false },   // in al,imm, HW=11
  E5: { eu: 6, mem: 0, io: 5, code: 2, flush: false },
  // mov reg, imm — HW total=4 (eu 2 + code 2)
  B0:{eu:2,mem:0,io:0,code:2,flush:false}, B1:{eu:2,mem:0,io:0,code:2,flush:false},
  B2:{eu:2,mem:0,io:0,code:2,flush:false}, B3:{eu:2,mem:0,io:0,code:2,flush:false},
  B4:{eu:2,mem:0,io:0,code:2,flush:false}, B5:{eu:2,mem:0,io:0,code:2,flush:false},
  B6:{eu:2,mem:0,io:0,code:2,flush:false}, B7:{eu:2,mem:0,io:0,code:2,flush:false},
  B8:{eu:2,mem:0,io:0,code:2,flush:false}, B9:{eu:2,mem:0,io:0,code:2,flush:false},
  BA:{eu:2,mem:0,io:0,code:2,flush:false}, BB:{eu:2,mem:0,io:0,code:2,flush:false},
  BC:{eu:2,mem:0,io:0,code:2,flush:false}, BD:{eu:2,mem:0,io:0,code:2,flush:false},
  BE:{eu:2,mem:0,io:0,code:2,flush:false}, BF:{eu:2,mem:0,io:0,code:2,flush:false},
  // Short Jcc 70..7F: HW taken=16 (eu 12 + code 4 on flush)
  '70':{eu:12,mem:0,io:0,code:4,flush:'cond'}, '71':{eu:12,mem:0,io:0,code:4,flush:'cond'},
  '72':{eu:12,mem:0,io:0,code:4,flush:'cond'}, '73':{eu:12,mem:0,io:0,code:4,flush:'cond'},
  '74':{eu:12,mem:0,io:0,code:4,flush:'cond'}, '75':{eu:12,mem:0,io:0,code:4,flush:'cond'},
  '76':{eu:12,mem:0,io:0,code:4,flush:'cond'}, '77':{eu:12,mem:0,io:0,code:4,flush:'cond'},
  '78':{eu:12,mem:0,io:0,code:4,flush:'cond'}, '79':{eu:12,mem:0,io:0,code:4,flush:'cond'},
  '7A':{eu:12,mem:0,io:0,code:4,flush:'cond'}, '7B':{eu:12,mem:0,io:0,code:4,flush:'cond'},
  '7C':{eu:12,mem:0,io:0,code:4,flush:'cond'}, '7D':{eu:12,mem:0,io:0,code:4,flush:'cond'},
  '7E':{eu:12,mem:0,io:0,code:4,flush:'cond'}, '7F':{eu:12,mem:0,io:0,code:4,flush:'cond'},
  E0: { eu: 5, mem: 0, io: 0, code: 2, flush: 'cond' }, // loopnz
  E1: { eu: 6, mem: 0, io: 0, code: 2, flush: 'cond' },
  E2: { eu:12, mem: 0, io: 0, code: 6, flush: 'cond' }, // loop taken, HW=18
  FA: { eu: 2, mem: 0, io: 0, code: 2, flush: false },  // cli
  FB: { eu: 2, mem: 0, io: 0, code: 2, flush: false },  // sti
  '90':{eu:2,mem:0,io:0,code:0,flush:false}, // nop, HW=2
  '91':{eu:2,mem:0,io:0,code:0,flush:false}, '92':{eu:2,mem:0,io:0,code:0,flush:false},
  '93':{eu:2,mem:0,io:0,code:0,flush:false}, '94':{eu:2,mem:0,io:0,code:0,flush:false},
  '95':{eu:2,mem:0,io:0,code:0,flush:false}, '96':{eu:2,mem:0,io:0,code:0,flush:false},
  '97':{eu:2,mem:0,io:0,code:0,flush:false},
  '04':{eu:2,mem:0,io:0,code:2,flush:false}, // add al,imm8, HW=4
  '05':{eu:2,mem:0,io:0,code:2,flush:false},
};

// ModR/M-form register-only entries. Used only when insn.bytes[1] has mod=11
// (top two bits set). EA/memory variants of these opcodes still fall through
// to Intel-table fallback. Values: Intel Table 2-21 EU + measured codeCyc=2
// for 2-byte ModR/M opcodes (one fetch beyond the prefetched first byte).
// Sources: Intel 8086 User's Manual Table 2-21; codeCyc convention from
// SingleStepTests/8088 prefetched-queue traces (test/8088_cycles_decomposed.json).
const MODRM_REG_TABLE = {
  '88':{eu:2,mem:0,io:0,code:2,flush:false}, // mov r/m8,r8 (reg form)
  '89':{eu:2,mem:0,io:0,code:2,flush:false}, // mov r/m16,r16
  '8A':{eu:2,mem:0,io:0,code:2,flush:false}, // mov r8,r/m8
  '8B':{eu:2,mem:0,io:0,code:2,flush:false}, // mov r16,r/m16
  '00':{eu:3,mem:0,io:0,code:2,flush:false}, // add r/m8,r8
  '01':{eu:3,mem:0,io:0,code:2,flush:false}, // add r/m16,r16
  '02':{eu:3,mem:0,io:0,code:2,flush:false},
  '03':{eu:3,mem:0,io:0,code:2,flush:false},
  '28':{eu:3,mem:0,io:0,code:2,flush:false}, // sub r/m8,r8
  '29':{eu:3,mem:0,io:0,code:2,flush:false},
  '2A':{eu:3,mem:0,io:0,code:2,flush:false},
  '2B':{eu:3,mem:0,io:0,code:2,flush:false},
  '38':{eu:3,mem:0,io:0,code:2,flush:false}, // cmp
  '39':{eu:3,mem:0,io:0,code:2,flush:false},
  '3A':{eu:3,mem:0,io:0,code:2,flush:false},
  '3B':{eu:3,mem:0,io:0,code:2,flush:false},
  '86':{eu:4,mem:0,io:0,code:2,flush:false}, // xchg r/m8,r8 (reg form)
  '87':{eu:4,mem:0,io:0,code:2,flush:false}, // xchg r/m16,r16
  // F6/F7 group: only /3 (neg) is register-form here. Others (mul, div, etc.)
  // have very different cycles — gate on ModR/M reg field too.
  // F6_3: neg r/m8, F7_3: neg r/m16 (3 cyc reg form per Table 2-21).
};
const F67_REG_TABLE = {
  3: {eu:3,mem:0,io:0,code:2,flush:false}, // neg
  2: {eu:3,mem:0,io:0,code:2,flush:false}, // not
};

const BIU_BYTE_CYCLES = 4;

// Find the post-prefix opcode byte. Prefixes occupy the first N bytes of
// insn.bytes; we count how many prefix flags are set in insn.prefixes.
// Prefix bytes on 8086: F0/F2/F3 (lock/repne/rep), 26/2E/36/3E (seg overrides).
const PREFIX_BYTES = new Set([0xF0,0xF2,0xF3,0x26,0x2E,0x36,0x3E]);
function opcodeBytePos(insn) {
  if (!insn.bytes) return -1;
  for (let i = 0; i < insn.bytes.length; i++) {
    if (!PREFIX_BYTES.has(insn.bytes[i])) return i;
  }
  return -1;
}
function opcodeByteHex(insn) {
  const i = opcodeBytePos(insn);
  return i < 0 ? null : insn.bytes[i].toString(16).toUpperCase().padStart(2, '0');
}

// Compute cycles for the BIU model. queueBytes is current prefetch queue
// occupancy (0..4); branchTaken is whether exec just took a Jcc branch.
// Returns { cyc, queueAfter } so the caller can update its queue model.
export function biuCycles(insn, queueBytes, branchTaken) {
  const opPos = opcodeBytePos(insn);
  const op = opPos < 0 ? null : insn.bytes[opPos].toString(16).toUpperCase().padStart(2, '0');
  let ent = op ? EU_TABLE[op] : null;
  // ModR/M register-form lookup. modrm byte follows opcode; mod=11 → reg-only.
  if (!ent && op && opPos + 1 < insn.bytes.length) {
    const mrm = insn.bytes[opPos + 1];
    const isRegForm = (mrm & 0xC0) === 0xC0;
    if (isRegForm) {
      if (op === 'F6' || op === 'F7') {
        const sub = (mrm >> 3) & 7;
        ent = F67_REG_TABLE[sub] || null;
      } else {
        ent = MODRM_REG_TABLE[op] || null;
      }
    }
  }
  if (!ent) {
    // Fallback: use Intel-table total as eu+mem+io, apply BIU refill model.
    const total = instructionCycles(insn);
    const memCyc = memAccessBytes(insn) * BIU_BYTE_CYCLES;
    const bytesNeeded = Math.max(0, insn.length - queueBytes);
    const fetchWait = bytesNeeded * BIU_BYTE_CYCLES;
    const cyc = Math.max(total, fetchWait + memCyc);
    const biuFreeCyc = Math.max(0, cyc - memCyc);
    const refill = (biuFreeCyc / BIU_BYTE_CYCLES) | 0;
    const queueAfter = Math.min(4, Math.max(0, queueBytes - insn.length) + refill);
    return { cyc, mem: memCyc, io: 0, eu: total, fetchWait, queueAfter };
  }
  const isFlush = ent.flush === true || (ent.flush === 'cond' && branchTaken);
  // Bimodal-aware formula: 8088 BIU fetches 1 byte per 4 cyc into a 4-byte
  // queue. EU waits when queue lacks the instruction's bytes.
  //   bytesNeeded = max(0, insn.length - queueBytes)
  //   codeFetchCyc = bytesNeeded * 4
  //   cyc = max(eu, codeFetchCyc) + mem + io  (non-flush)
  //   cyc = eu + mem + io + code               (flush — queue is empty after)
  // Queue update: drain insn.length bytes, then refill at 1 byte per 4 cyc
  // for the EU/mem/io duration.
  let cyc, queueAfter, fetchWait;
  if (isFlush) {
    fetchWait = ent.code;
    cyc = ent.eu + ent.mem + ent.io + fetchWait;
    queueAfter = 2;
  } else {
    const bytesFromQueue = Math.min(queueBytes, insn.length);
    const bytesNeeded = insn.length - bytesFromQueue;
    fetchWait = bytesNeeded * BIU_BYTE_CYCLES;
    const euTotal = ent.eu + ent.mem + ent.io;
    cyc = Math.max(euTotal, fetchWait + ent.mem + ent.io);
    // Queue model: BIU and EU run concurrently. During non-mem/io phase BIU
    // fetches 1 byte per 4 cyc into queue (or directly to EU if queue empty).
    // Approximate: refill = biuFreeCyc/4, drain = insn.length.
    const biuFreeCyc = Math.max(0, cyc - ent.mem - ent.io);
    const refill = (biuFreeCyc / BIU_BYTE_CYCLES) | 0;
    queueAfter = Math.min(4, Math.max(0, queueBytes - insn.length) + refill);
  }
  return { cyc, mem: ent.mem, io: ent.io, eu: ent.eu, fetchWait, queueAfter };
}

export { EU_TABLE };
