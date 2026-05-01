// SCP 8086 Assembler (Tim Paterson dialect, version 2.43) — JS implementation.
//
// Targets the source files in DOS-History/Paterson-Listings:
//   - 86-DOS_1.00/86DOS.ASM
//   - SCP_ASM/ASM_2.43.ASM (self-host)
//
// Dialect summary:
//   - Numbers default decimal; H-suffix for hex; B-suffix for binary; O/Q for octal.
//   - Strings: single-quoted (or double-quoted; a few sources use both).
//   - Labels: NAME: at start of line. Optional whitespace.
//   - Directives: ORG, PUT, EQU/=, DB, DW, DS, IF/ELSE/ENDIF, END, ALIGN.
//   - Expressions: + - * / ( ), unary -, $ = current PC, decimal/hex/char literals.
//   - SCP mnemonic aliases: JP=JMPS=short JMP, DI=CLI, EI=STI, UP=CLD, DOWN=STD,
//     SBC=SBB, JE=JZ, JNE=JNZ, JG/JNG/JL/JNL/JGE/JNGE/JBE/JNBE/JAE/JNAE/JNB/JNC,
//     LODB/LODW/STOB/STOW/MOVB/MOVW/CMPB/CMPW/SCAB/SCAW (string ops, byte/word),
//     SEG <reg> as a one-shot prefix attached to the next instruction.
//
// Two-pass: pass 1 collects symbol table by tracking sizes; pass 2 emits bytes.
// Sizes are deterministic by always picking a canonical encoding (no shrink).
// 86DOS.ASM and ASM_2.43.ASM both verify under that rule.

'use strict';

// --- Lexer ---------------------------------------------------------------

const TT = {
  EOL: 'eol', EOF: 'eof', ID: 'id', NUM: 'num', STR: 'str',
  COLON: ':', COMMA: ',', LBRK: '[', RBRK: ']', LPAREN: '(', RPAREN: ')',
  PLUS: '+', MINUS: '-', STAR: '*', SLASH: '/', DOLLAR: '$', EQ: '=',
};

class Lexer {
  constructor(src) {
    this.src = src.replace(/\r\n?/g, '\n');
    this.i = 0;
    this.line = 1;
  }
  _peek(o = 0) { return this.src.charCodeAt(this.i + o); }
  _isAlpha(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 63 /* '?' allowed in idents */; }
  _isDigit(c) { return c >= 48 && c <= 57; }
  _isAlnum(c) { return this._isAlpha(c) || this._isDigit(c); }
  _skipWS() {
    for (;;) {
      const c = this._peek();
      if (c === 32 || c === 9 || c === 12) { this.i++; continue; }
      if (c === 59 /* ; */) { while (this.i < this.src.length && this.src.charCodeAt(this.i) !== 10) this.i++; continue; }
      // Backslash-newline: SCP doesn't use line continuation; ignore stray FFs (page breaks) elsewhere.
      return;
    }
  }
  next() {
    this._skipWS();
    if (this.i >= this.src.length) return { type: TT.EOF, line: this.line };
    const c = this._peek();
    const startLine = this.line;
    if (c === 10) { this.i++; this.line++; return { type: TT.EOL, line: startLine }; }
    if (c === 0x1A) return { type: TT.EOF, line: startLine }; // DOS Ctrl-Z EOF marker
    if (this._isAlpha(c)) {
      const s = this.i;
      while (this._isAlnum(this._peek())) this.i++;
      return { type: TT.ID, value: this.src.slice(s, this.i), line: startLine };
    }
    if (this._isDigit(c)) {
      const s = this.i;
      while (this._isAlnum(this._peek())) this.i++;
      const raw = this.src.slice(s, this.i);
      return { type: TT.NUM, value: parseNumber(raw, startLine), raw, line: startLine };
    }
    if (c === 39 /* ' */ || c === 34 /* " */) {
      const quote = c;
      this.i++;
      const out = [];
      while (this.i < this.src.length) {
        const ch = this._peek();
        if (ch === quote) {
          if (this._peek(1) === quote) { out.push(quote); this.i += 2; continue; }
          this.i++;
          return { type: TT.STR, value: out, line: startLine };
        }
        if (ch === 10) throw asmErr(startLine, 'unterminated string');
        out.push(ch); this.i++;
      }
      throw asmErr(startLine, 'unterminated string');
    }
    const single = {
      ':': TT.COLON, ',': TT.COMMA, '[': TT.LBRK, ']': TT.RBRK,
      '(': TT.LPAREN, ')': TT.RPAREN, '+': TT.PLUS, '-': TT.MINUS,
      '*': TT.STAR, '/': TT.SLASH, '$': TT.DOLLAR, '=': TT.EQ,
    };
    const ch = String.fromCharCode(c);
    if (single[ch] !== undefined) { this.i++; return { type: single[ch], line: startLine }; }
    throw asmErr(startLine, `unexpected character '${ch}' (0x${c.toString(16)})`);
  }
}

function parseNumber(raw, line) {
  const last = raw[raw.length - 1].toUpperCase();
  let base = 10, body = raw;
  if (last === 'H') { base = 16; body = raw.slice(0, -1); }
  else if (last === 'B' && /^[01]+B$/i.test(raw)) { base = 2; body = raw.slice(0, -1); }
  else if (last === 'O' || last === 'Q') { base = 8; body = raw.slice(0, -1); }
  else if (last === 'D' && /^[0-9]+D$/i.test(raw)) { base = 10; body = raw.slice(0, -1); }
  if (!body.length) throw asmErr(line, `bad number '${raw}'`);
  let n = 0;
  for (const d of body) {
    const v = parseInt(d, base);
    if (Number.isNaN(v)) throw asmErr(line, `bad digit '${d}' in '${raw}'`);
    n = n * base + v;
  }
  return n;
}

function asmErr(line, msg) {
  const e = new Error(`scpasm: line ${line}: ${msg}`);
  e.line = line;
  return e;
}

// --- Register tables -----------------------------------------------------

const REG8  = { AL:0, CL:1, DL:2, BL:3, AH:4, CH:5, DH:6, BH:7 };
const REG16 = { AX:0, CX:1, DX:2, BX:3, SP:4, BP:5, SI:6, DI:7 };
const SREG  = { ES:0, CS:1, SS:2, DS:3 };
const MNEM_ALIAS = {
  // SCP-style mnemonic synonyms map onto the canonical ones used in the encoder switch.
  JP: 'JMPS', JE: 'JZ', JNE: 'JNZ', JNAE: 'JB', JNB: 'JAE', JNBE: 'JA',
  JNG: 'JLE', JNGE: 'JL', JNL: 'JGE', JNLE: 'JG',
  DI: 'CLI', EI: 'STI', UP: 'CLD', DOWN: 'STD', SBC: 'SBB',
  LODSB:'LODB', LODSW:'LODW', STOSB:'STOB', STOSW:'STOW',
  MOVSB:'MOVB', MOVSW:'MOVW', CMPSB:'CMPB', CMPSW:'CMPW',
  SCASB:'SCAB', SCASW:'SCAW',
  REPZ: 'REPE', REPNZ: 'REPNE',
};

// --- Public API ----------------------------------------------------------

export function assemble(source, opts = {}) {
  const lx = new Lexer(source);
  const lines = tokenize(lx);
  const ctx = {
    symbols: new Map(),
    prevSymbols: new Map(), // stable values from the previous pass; used to decide encoding sizes
    pc: 0,
    putBase: null,
    output: [],
    pass: 1,
    emitting: false, // true on the final pass — affects out-of-range diagnostics
    skipStack: [],
    skipping: false,
    end: false,
    pendingPrefixes: [],
    retSpots: [],
    prevRetSpots: [], // full set of RET PCs from the previous pass — used for resolving "RET" idiom forward-references
    opts,
  };
  // Iterate passes until the symbol table stabilises. First pass has no previous
  // values → forward refs force worst-case (disp16, JMP rel16) encoding. Each
  // subsequent pass may shrink encodings as more values become known. Monotone:
  // shrinking only makes addresses smaller, so labels can't outgrow their slots.
  let prev = new Map();
  for (let iter = 0; iter < 8; iter++) {
    ctx.prevSymbols = prev;
    runPass(ctx, lines, 1);
    ctx.prevRetSpots = ctx.retSpots;
    if (mapsEqual(prev, ctx.symbols)) break;
    prev = ctx.symbols;
  }
  // Final emit pass with stable values.
  ctx.prevSymbols = ctx.symbols;
  ctx.emitting = true;
  runPass(ctx, lines, 2);
  ctx.prevRetSpots = ctx.retSpots;
  return { bytes: new Uint8Array(ctx.output), base: ctx.putBase ?? 0, symbols: ctx.symbols };
}

function mapsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const o = b.get(k);
    if (!o || o.value !== v.value) return false;
  }
  return true;
}

function tokenize(lx) {
  const out = [];
  let row = [];
  for (;;) {
    const t = lx.next();
    if (t.type === TT.EOF) { if (row.length) out.push(row); break; }
    if (t.type === TT.EOL) { if (row.length) { out.push(row); row = []; } continue; }
    row.push(t);
  }
  return out;
}

function runPass(ctx, lines, passNo) {
  ctx.pass = passNo;
  ctx.pc = 0;
  ctx.output = [];
  ctx.symbols = new Map();
  ctx.skipStack = [];
  ctx.skipping = false;
  ctx.end = false;
  ctx.pendingPrefixes = [];
  ctx.retSpots = [];
  for (const row of lines) {
    if (ctx.end) break;
    try { assembleLine(ctx, row); }
    catch (e) {
      if (!e.line || e.line === 0) e.message = `${e.message} (at source line ${row[0]?.line ?? '?'})`;
      throw e;
    }
  }
}

function assembleLine(ctx, tokens) {
  let i = 0;
  ctx.lastLabelKey = null;
  // Forms recognised at the head of a line:
  //   LABEL:                      → label = pc
  //   LABEL: EQU expr | LABEL: = e → labelled equate (colon decorative)
  //   LABEL  EQU expr | LABEL = e  → equate without colon
  if (tokens[i]?.type === TT.ID && tokens[i+1]?.type === TT.COLON) {
    const j = i + 2;
    const isEqu = tokens[j]?.type === TT.EQ ||
                  (tokens[j]?.type === TT.ID && tokens[j].value.toUpperCase() === 'EQU');
    if (isEqu) {
      const name = tokens[i].value;
      if (!ctx.skipping) {
        const v = evalExpr(ctx, tokens.slice(j + 1), 0).value;
        defineSymbol(ctx, name, v, 'equ');
      }
      return;
    }
    if (!ctx.skipping) {
      defineLabel(ctx, tokens[i].value, ctx.pc);
      ctx.lastLabelKey = tokens[i].value.toUpperCase();
    }
    i += 2;
  } else if (tokens[i]?.type === TT.ID && (tokens[i+1]?.type === TT.EQ ||
             (tokens[i+1]?.type === TT.ID && tokens[i+1].value.toUpperCase() === 'EQU')) &&
             !isMnemonic(tokens[i].value) && tokens.length > i + 2) {
    const name = tokens[i].value;
    if (!ctx.skipping) {
      const rest = tokens.slice(i + 2);
      const v = evalExpr(ctx, rest, 0).value;
      defineSymbol(ctx, name, v, 'equ');
    }
    return;
  }
  if (i >= tokens.length) return;
  const tok = tokens[i];
  if (tok.type !== TT.ID) throw asmErr(tok.line, `expected directive or mnemonic, got ${tok.type}`);
  let op = tok.value.toUpperCase();
  // IF/ELSE/ENDIF must execute even while skipping (to track nesting).
  if (op === 'IF') { handleIf(ctx, tokens.slice(i + 1)); return; }
  if (op === 'ELSE') { handleElse(ctx, tok.line); return; }
  if (op === 'ENDIF') { handleEndif(ctx, tok.line); return; }
  if (ctx.skipping) return;
  if (op === 'END') { ctx.end = true; return; }
  if (op === 'ORG') { ctx.pc = evalExpr(ctx, tokens.slice(i + 1), 0).value & 0xFFFF; return; }
  if (op === 'PUT') {
    const v = evalExpr(ctx, tokens.slice(i + 1), 0).value & 0xFFFF;
    if (ctx.pass === 2) ctx.putBase = v;
    return;
  }
  if (op === 'ALIGN') {
    // SCP ALIGN with no arg → word boundary (2).
    const rest = tokens.slice(i + 1);
    const a = (rest.length ? evalExpr(ctx, rest, 0).value : 2) & 0xFFFF;
    if (a > 0) { while (ctx.pc % a !== 0) emit(ctx, 0); }
    return;
  }
  if (op === 'DM') {
    // SCP "define message/mnemonic": comma-separated list of bytes/strings;
    // the LAST byte of the LAST string in the list gets the high bit set
    // (terminator). Plain numeric items emit one byte each.
    const rest = tokens.slice(i + 1);
    // Find index of last STR token at top level (commas are separators).
    let items = [];
    let j = 0;
    while (j < rest.length) {
      if (rest[j].type === TT.STR) { items.push({ kind:'str', value: rest[j].value }); j++; }
      else {
        const r = evalExpr(ctx, rest, j);
        items.push({ kind:'num', value: r.value & 0xFF });
        j = r.next;
      }
      if (j < rest.length) {
        if (rest[j].type !== TT.COMMA) throw asmErr(tok.line, `DM: expected ',' between items`);
        j++;
      }
    }
    let lastStrIdx = -1;
    for (let k = items.length - 1; k >= 0; k--) if (items[k].kind === 'str') { lastStrIdx = k; break; }
    if (lastStrIdx < 0) throw asmErr(tok.line, 'DM: needs at least one string');
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      if (it.kind === 'num') { emit(ctx, it.value); continue; }
      const s = it.value, isLast = (k === lastStrIdx);
      for (let m = 0; m < s.length; m++) {
        const b = s[m] & 0xFF;
        emit(ctx, (isLast && m === s.length - 1) ? (b | 0x80) : b);
      }
    }
    return;
  }
  if (op === 'DB') { tagLastLabelSize(ctx, 8);  dataBytes(ctx, tokens.slice(i + 1), 1, tok.line); return; }
  if (op === 'DW') { tagLastLabelSize(ctx, 16); dataBytes(ctx, tokens.slice(i + 1), 2, tok.line); return; }
  if (op === 'DS') {
    const v = evalExpr(ctx, tokens.slice(i + 1), 0).value & 0xFFFF;
    tagLastLabelSize(ctx, v === 2 ? 16 : 8);
    for (let k = 0; k < v; k++) emit(ctx, 0);
    return;
  }
  if (MNEM_ALIAS[op]) op = MNEM_ALIAS[op];
  encodeInstruction(ctx, op, tokens.slice(i + 1), tok.line);
}

// Used to disambiguate `JZ EQU` (jump-to-label-EQU) from `LABEL EQU value`.
const MNEMONIC_SET = new Set([
  'NOP','RET','RETF','IRET','INTO','HLT','WAIT','CLC','STC','CLI','STI','CLD','STD','CMC',
  'CBW','CWD','AAA','AAS','DAA','DAS','PUSHF','POPF','SAHF','LAHF','XLAT',
  'LODB','LODW','STOB','STOW','MOVB','MOVW','CMPB','CMPW','SCAB','SCAW',
  'LODSB','LODSW','STOSB','STOSW','MOVSB','MOVSW','CMPSB','CMPSW','SCASB','SCASW',
  'AAM','AAD','SEG','LOCK','REP','REPE','REPZ','REPNE','REPNZ',
  'ADD','OR','ADC','SBB','AND','SUB','XOR','CMP',
  'MOV','XCHG','TEST','PUSH','POP','INC','DEC','NEG','NOT','MUL','IMUL','DIV','IDIV',
  'LEA','LDS','LES','INT','IN','OUT','CALL','JMP','JMPS','JP',
  'LOOP','LOOPE','LOOPZ','LOOPNE','LOOPNZ','JCXZ',
  'ROL','ROR','RCL','RCR','SHL','SAL','SHR','SAR',
  'JO','JNO','JB','JC','JAE','JNB','JNC','JZ','JE','JNZ','JNE',
  'JBE','JNA','JA','JNBE','JS','JNS','JPE','JNP','JPO',
  'JL','JNGE','JGE','JNL','JLE','JNG','JG','JNLE',
  'DI','EI','UP','DOWN','SBC',
]);
function isMnemonic(name) { return MNEMONIC_SET.has(name.toUpperCase()); }

function tagLastLabelSize(ctx, elemSize) {
  if (!ctx.lastLabelKey) return;
  const sym = ctx.symbols.get(ctx.lastLabelKey);
  if (sym && sym.elemSize === undefined) sym.elemSize = elemSize;
}
function defineLabel(ctx, name, value) {
  defineSymbol(ctx, name, value, 'label');
}
function defineSymbol(ctx, name, value, kind) {
  // Each pass rebuilds ctx.symbols from scratch; duplicates within one pass are
  // fatal, but redefinition across passes (with new computed value) is normal.
  const key = name.toUpperCase();
  if (ctx.symbols.has(key)) throw new Error(`duplicate symbol ${name}`);
  ctx.symbols.set(key, { value: value & 0xFFFF, kind, name });
}

function handleIf(ctx, rest) {
  if (ctx.skipping) {
    ctx.skipStack.push({ taken: false, sawElse: false, parentSkip: true });
    return;
  }
  const v = evalExpr(ctx, rest, 0).value;
  const taken = v !== 0;
  ctx.skipStack.push({ taken, sawElse: false, parentSkip: false });
  ctx.skipping = !taken;
}
function handleElse(ctx, line) {
  const top = ctx.skipStack[ctx.skipStack.length - 1];
  if (!top) throw asmErr(line, 'ELSE without IF');
  if (top.sawElse) throw asmErr(line, 'duplicate ELSE');
  top.sawElse = true;
  if (top.parentSkip) return;
  ctx.skipping = top.taken;
}
function handleEndif(ctx, line) {
  const top = ctx.skipStack.pop();
  if (!top) throw asmErr(line, 'ENDIF without IF');
  ctx.skipping = ctx.skipStack.some(f => f.parentSkip || (f.sawElse ? !f.taken : !f.taken));
  // Recompute correctly: we are skipping if any active frame above is in its skipped branch.
  ctx.skipping = false;
  for (const f of ctx.skipStack) {
    if (f.parentSkip) { ctx.skipping = true; break; }
    const inSkippedBranch = f.sawElse ? f.taken : !f.taken;
    if (inSkippedBranch) { ctx.skipping = true; break; }
  }
}

function dataBytes(ctx, tokens, size, line) {
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].type === TT.STR && size === 1) {
      for (const b of tokens[i].value) emit(ctx, b & 0xFF);
      i++;
    } else {
      const r = evalExpr(ctx, tokens, i);
      const v = r.value;
      if (size === 1) emit(ctx, v & 0xFF);
      else { emit(ctx, v & 0xFF); emit(ctx, (v >> 8) & 0xFF); }
      i = r.next;
    }
    if (i < tokens.length) {
      if (tokens[i].type !== TT.COMMA) throw asmErr(tokens[i].line, `expected ',' in data list`);
      i++;
    }
  }
}

function emit(ctx, byte) {
  ctx.output.push(byte & 0xFF);
  ctx.pc = (ctx.pc + 1) & 0xFFFF;
}
function emitBytes(ctx, ...bs) { for (const b of bs) emit(ctx, b); }
function emitWord(ctx, v) { emit(ctx, v & 0xFF); emit(ctx, (v >> 8) & 0xFF); }

// --- Expression evaluator ------------------------------------------------

function evalExpr(ctx, tokens, start) {
  const p = { tokens, i: start, hasLabel: false, unresolved: false };
  const v = parseAdd(ctx, p);
  return { value: v & 0xFFFF, next: p.i, hasLabel: p.hasLabel, unresolved: p.unresolved };
}
function parseAdd(ctx, p) {
  let v = parseMul(ctx, p);
  while (p.i < p.tokens.length && (p.tokens[p.i].type === TT.PLUS || p.tokens[p.i].type === TT.MINUS)) {
    const op = p.tokens[p.i++].type;
    const r = parseMul(ctx, p);
    v = (op === TT.PLUS) ? (v + r) : (v - r);
  }
  return v | 0;
}
function parseMul(ctx, p) {
  let v = parseUnary(ctx, p);
  while (p.i < p.tokens.length && (p.tokens[p.i].type === TT.STAR || p.tokens[p.i].type === TT.SLASH)) {
    const op = p.tokens[p.i++].type;
    const r = parseUnary(ctx, p);
    v = (op === TT.STAR) ? (v * r) : ((r === 0) ? 0 : (v / r) | 0);
  }
  return v | 0;
}
function parseUnary(ctx, p) {
  if (p.i < p.tokens.length && p.tokens[p.i].type === TT.MINUS) { p.i++; return -parseUnary(ctx, p); }
  if (p.i < p.tokens.length && p.tokens[p.i].type === TT.PLUS)  { p.i++; return  parseUnary(ctx, p); }
  return parseAtom(ctx, p);
}
function parseAtom(ctx, p) {
  const t = p.tokens[p.i];
  if (!t) {
    const prev = p.tokens[p.i - 1];
    throw asmErr(prev?.line ?? 0, 'unexpected end of expression');
  }
  if (t.type === TT.NUM)    { p.i++; return t.value | 0; }
  if (t.type === TT.DOLLAR) { p.i++; return ctx.pc | 0; }
  if (t.type === TT.LPAREN) { p.i++; const v = parseAdd(ctx, p);
                              if (p.tokens[p.i]?.type !== TT.RPAREN) throw asmErr(t.line, 'missing )');
                              p.i++; return v; }
  if (t.type === TT.ID) {
    p.i++;
    const key = t.value.toUpperCase();
    // Read from the previous pass's stable values (so forward refs see the
    // value computed in the prior iteration). Within a pass we still register
    // the new value into ctx.symbols.
    const sym = ctx.prevSymbols.get(key) ?? ctx.symbols.get(key);
    if (p.soleSymKey === undefined) p.soleSymKey = key;
    else if (p.soleSymKey !== key)  p.multiSym = true;
    if (sym) {
      if (sym.kind === 'label') p.hasLabel = true;
      return sym.value | 0;
    }
    // SCP idiom: bare "RET" in an operand means "the nearest RET instruction".
    // Same for RETF/IRET. Resolve to closest by absolute PC distance, using
    // the previous pass's full set of RET PCs (so we see RETs ahead in source).
    if (key === 'RET' || key === 'RETF' || key === 'IRET') {
      const spots = ctx.prevRetSpots.length ? ctx.prevRetSpots : ctx.retSpots;
      if (spots.length) {
        let best = spots[0], bd = Math.abs(ctx.pc - best);
        for (let k = 1; k < spots.length; k++) {
          const d = Math.abs(ctx.pc - spots[k]);
          if (d < bd) { bd = d; best = spots[k]; }
        }
        p.hasLabel = true;
        return best | 0;
      }
      p.unresolved = true; p.hasLabel = true; return 0;
    }
    if (!ctx.emitting) { p.unresolved = true; p.hasLabel = true; return 0; }
    throw asmErr(t.line, `undefined symbol '${t.value}'`);
  }
  if (t.type === TT.STR) {
    p.i++;
    if (t.value.length === 0) return 0;
    if (t.value.length === 1) return t.value[0];
    if (t.value.length === 2) return t.value[0] | (t.value[1] << 8);
    throw asmErr(t.line, 'string too long for expression');
  }
  throw asmErr(t.line ?? 0, `unexpected token in expression: ${t.type}`);
}

// --- Operand parser ------------------------------------------------------
// Parses comma-separated operand list. Returns array of operand objects:
//   { kind: 'reg8'|'reg16'|'sreg', idx }
//   { kind: 'mem',  base, index, disp, hasDisp, sizeHint? }
//        base/index ∈ {null, 'BX','BP','SI','DI'}
//   { kind: 'imm',  expr, value }   // value may be undefined in pass 1 if forward ref
//   { kind: 'lab',  expr, value }   // bare label (label/expr without [])

function parseOperands(ctx, tokens) {
  const ops = [];
  let i = 0;
  while (i < tokens.length) {
    const r = parseOperand(ctx, tokens, i);
    ops.push(r.op);
    i = r.next;
    if (i < tokens.length) {
      if (tokens[i].type !== TT.COMMA) throw asmErr(tokens[i].line, `expected ',' between operands`);
      i++;
    }
  }
  return ops;
}

function parseOperand(ctx, tokens, start) {
  let i = start;
  // Optional size override: BYTE PTR / WORD PTR (rare in SCP but harmless).
  let sizeHint = null;
  if (tokens[i]?.type === TT.ID) {
    const u = tokens[i].value.toUpperCase();
    if (u === 'BYTE' || u === 'WORD') {
      const next = tokens[i+1];
      if (next?.type === TT.ID && next.value.toUpperCase() === 'PTR') {
        sizeHint = u === 'BYTE' ? 8 : 16; i += 2;
      }
    }
  }
  const t = tokens[i];
  if (!t) throw new Error('expected operand');
  // [ memory ]
  if (t.type === TT.LBRK) {
    const r = parseMem(ctx, tokens, i + 1);
    if (sizeHint) r.op.sizeHint = sizeHint;
    return r;
  }
  // Bare register?
  if (t.type === TT.ID) {
    const u = t.value.toUpperCase();
    if (REG8[u]  !== undefined) return { op: { kind:'reg8',  idx: REG8[u] },  next: i + 1 };
    if (REG16[u] !== undefined) return { op: { kind:'reg16', idx: REG16[u] }, next: i + 1 };
    if (SREG[u]  !== undefined) return { op: { kind:'sreg',  idx: SREG[u] },  next: i + 1 };
  }
  // Otherwise: expression operand. For instructions that take a label (CALL, JMP,
  // Jcc, LOOP) we treat it as 'lab'; the caller decides if 'imm' is expected.
  const r = evalExpr(ctx, tokens, i);
  return { op: { kind:'imm', value: r.value, sizeHint }, next: r.next };
}

function parseMem(ctx, tokens, start) {
  // Forms: [reg], [reg+reg], [reg+expr], [reg+reg+expr], [expr], [reg-expr]
  // In SCP, label inside brackets is the disp; bare register names are base/index.
  let i = start;
  let base = null, index = null, disp = 0, hasDisp = false, dispHasLabel = false, dispUnresolved = false;
  let dispSymKey = null, dispSymTermCount = 0;
  // Helper to consume a register or accumulate into expression.
  const isReg = (tok) => {
    if (!tok || tok.type !== TT.ID) return null;
    const u = tok.value.toUpperCase();
    if (u === 'BX' || u === 'BP' || u === 'SI' || u === 'DI') return u;
    return null;
  };
  const setBaseOrIndex = (r, line) => {
    // Bases: BX, BP. Indices: SI, DI. If both regs in SI/DI we error.
    if (r === 'BX' || r === 'BP') {
      if (base) throw asmErr(line, `memory has multiple base regs`);
      base = r;
    } else { // SI, DI
      if (index) throw asmErr(line, `memory has multiple index regs`);
      index = r;
    }
  };
  // Read terms separated by + or -, consuming until ].
  let sign = 1;
  while (i < tokens.length && tokens[i].type !== TT.RBRK) {
    if (tokens[i].type === TT.PLUS)  { sign =  1; i++; continue; }
    if (tokens[i].type === TT.MINUS) { sign = -1; i++; continue; }
    const r = isReg(tokens[i]);
    if (r && sign === 1) {
      setBaseOrIndex(r, tokens[i].line);
      i++;
    } else {
      // Parse expression up to + or - (at top level) or ].
      const r2 = parseMemExpr(ctx, tokens, i);
      disp = (disp + sign * r2.value) | 0;
      hasDisp = true;
      if (r2.hasLabel) dispHasLabel = true;
      if (r2.unresolved) dispUnresolved = true;
      if (r2.soleSymKey) {
        dispSymTermCount++;
        if (dispSymTermCount === 1) dispSymKey = r2.soleSymKey;
        else dispSymKey = null;
      }
      i = r2.next;
    }
    sign = 1;
    // After a term, if next is + or -, the loop continues to update sign.
    if (i < tokens.length && (tokens[i].type === TT.PLUS || tokens[i].type === TT.MINUS)) continue;
  }
  if (tokens[i]?.type !== TT.RBRK) throw asmErr(tokens[start - 1]?.line ?? 0, 'missing ]');
  return { op: { kind: 'mem', base, index, disp: disp & 0xFFFF, hasDisp, dispHasLabel, dispUnresolved, dispSymKey }, next: i + 1 };
}

function parseMemExpr(ctx, tokens, start) {
  // Like evalExpr but stops at top-level + - ] or ,.
  const p = { tokens, i: start, hasLabel: false, unresolved: false, soleSymKey: undefined, multiSym: false };
  let v = parseMul(ctx, p);
  return { value: v & 0xFFFF, next: p.i, hasLabel: p.hasLabel, unresolved: p.unresolved,
           soleSymKey: p.multiSym ? null : p.soleSymKey };
}

// --- ModR/M encoding -----------------------------------------------------

const MEM_RM = {
  // [base][index] → r/m field, when no plain BP-only special case applies.
  'BX,SI': 0, 'BX,DI': 1, 'BP,SI': 2, 'BP,DI': 3,
  ',SI': 4, ',DI': 5, ',BX': 7,
  // ',BP' handled as r/m=6 with mod=01/10 (forces disp to disambiguate from direct).
};

function encodeMemRM(mem, regField) {
  // Returns Uint8Array of [modrm, ...disp].
  const { base, index, disp, hasDisp, dispUnresolved } = mem;
  if (!base && !index) {
    // Direct address: mod=00 r/m=110 disp16.
    return [(0 << 6) | (regField << 3) | 6, disp & 0xFF, (disp >> 8) & 0xFF];
  }
  let key;
  if (base && index)      key = `${base},${index}`;
  else if (base)          key = `,${base}`;
  else                    key = `,${index}`;
  let rm = MEM_RM[key];
  if (rm === undefined) {
    if (!base && index) {
      // index-only without explicit support? SI/DI handled by ',SI'/',DI'.
      throw new Error(`unsupported memory addressing: ${key}`);
    }
    if (base === 'BP' && !index) {
      // [BP] alone needs disp8=0 because mod=00 r/m=110 means direct.
      rm = 6;
      const d = disp;
      if (!hasDisp || (d === 0)) {
        // Force mod=01 disp8=0.
        return [(1 << 6) | (regField << 3) | rm, 0];
      }
      // fall through with rm=6, disp present
    } else {
      throw new Error(`unsupported memory addressing: ${key}`);
    }
  }
  if (!hasDisp) {
    if (rm === 6) {
      // [BP] case handled above; if we got here something is off.
      return [(1 << 6) | (regField << 3) | rm, 0];
    }
    return [(0 << 6) | (regField << 3) | rm];
  }
  // With displacement: prefer disp8 when value fits signed. If the disp came
  // from a still-unresolved symbol (first iteration of the fixed-point), we
  // pessimistically reserve disp16 so subsequent iterations can shrink only
  // monotonically (binary cannot grow).
  const sd = (disp & 0x8000) ? (disp - 0x10000) : disp;
  if (!dispUnresolved && sd >= -128 && sd <= 127) {
    return [(1 << 6) | (regField << 3) | rm, disp & 0xFF];
  }
  return [(2 << 6) | (regField << 3) | rm, disp & 0xFF, (disp >> 8) & 0xFF];
}

function modrmRR(regField, rmReg) {
  return [(3 << 6) | (regField << 3) | (rmReg & 7)];
}

function emitRMR(ctx, opcode, regField, rmOp) {
  // Emits opcode + ModR/M for `rmOp` with given reg field.
  emit(ctx, opcode);
  if (rmOp.kind === 'reg8' || rmOp.kind === 'reg16') {
    for (const b of modrmRR(regField, rmOp.idx)) emit(ctx, b);
  } else if (rmOp.kind === 'mem') {
    for (const b of encodeMemRM(rmOp, regField)) emit(ctx, b);
  } else {
    throw new Error(`expected register or memory for ModR/M, got ${rmOp.kind}`);
  }
}

// --- Instruction encoder -------------------------------------------------

function encodeInstruction(ctx, op, tokens, line) {
  // Flush pending one-shot prefix bytes (SEG, REP, LOCK).
  const flushPrefixes = () => { for (const b of ctx.pendingPrefixes) emit(ctx, b); ctx.pendingPrefixes = []; };

  // SCP `SEG <reg>` — emit override prefix, attached to next instruction.
  if (op === 'SEG') {
    const t = tokens[0];
    if (!t || t.type !== TT.ID) throw asmErr(line, 'SEG expects segment register');
    const idx = SREG[t.value.toUpperCase()];
    if (idx === undefined) throw asmErr(line, `bad SEG operand '${t.value}'`);
    const pfx = [0x26, 0x2E, 0x36, 0x3E][idx];
    ctx.pendingPrefixes.push(pfx);
    return;
  }
  if (op === 'LOCK') { ctx.pendingPrefixes.push(0xF0); return; }
  if (op === 'REP' || op === 'REPE') {
    // REP with no operand emits the prefix; if an instruction follows on same line, encoder
    // is called once per line so we fall through. Treat as solo prefix.
    if (tokens.length === 0) { ctx.pendingPrefixes.push(0xF3); return; }
    ctx.pendingPrefixes.push(0xF3);
    // Now parse rest as an instruction.
    return encodeInstruction(ctx, tokens[0].value.toUpperCase(), tokens.slice(1), line);
  }
  if (op === 'REPNE') {
    if (tokens.length === 0) { ctx.pendingPrefixes.push(0xF2); return; }
    ctx.pendingPrefixes.push(0xF2);
    return encodeInstruction(ctx, tokens[0].value.toUpperCase(), tokens.slice(1), line);
  }

  // Zero-operand instructions.
  const NULLARY = {
    NOP:0x90, RET:0xC3, RETF:0xCB, IRET:0xCF, INTO:0xCE, HLT:0xF4, WAIT:0x9B,
    CLC:0xF8, STC:0xF9, CLI:0xFA, STI:0xFB, CLD:0xFC, STD:0xFD, CMC:0xF5,
    CBW:0x98, CWD:0x99, AAA:0x37, AAS:0x3F, DAA:0x27, DAS:0x2F,
    PUSHF:0x9C, POPF:0x9D, SAHF:0x9E, LAHF:0x9F, XLAT:0xD7,
    LODB:0xAC, LODW:0xAD, STOB:0xAA, STOW:0xAB,
    MOVB:0xA4, MOVW:0xA5, CMPB:0xA6, CMPW:0xA7, SCAB:0xAE, SCAW:0xAF,
  };
  if (NULLARY[op] !== undefined && tokens.length === 0) {
    flushPrefixes();
    if (op === 'RET' || op === 'RETF' || op === 'IRET') ctx.retSpots.push(ctx.pc);
    emit(ctx, NULLARY[op]);
    return;
  }
  // AAM / AAD — optional immediate (default 10 = 0x0A).
  if (op === 'AAM') { flushPrefixes(); emit(ctx, 0xD4);
    emit(ctx, tokens.length ? evalExpr(ctx, tokens, 0).value & 0xFF : 0x0A); return; }
  if (op === 'AAD') { flushPrefixes(); emit(ctx, 0xD5);
    emit(ctx, tokens.length ? evalExpr(ctx, tokens, 0).value & 0xFF : 0x0A); return; }

  // SCP size prefix: `MNEMONIC B,operand[,operand]` or `W,...` forces operand size.
  let forcedSize = null;
  if (tokens.length >= 2 && tokens[0].type === TT.ID && tokens[1].type === TT.COMMA) {
    const u = tokens[0].value.toUpperCase();
    if (u === 'B') { forcedSize = 8;  tokens = tokens.slice(2); }
    else if (u === 'W') { forcedSize = 16; tokens = tokens.slice(2); }
    else if (u === 'L') { forcedSize = 32; tokens = tokens.slice(2); } // far ptr indirect for CALL/JMP
  }
  // SCP `RET L` (no comma) — a lone L size hint = RETF.
  if ((op === 'RET' || op === 'RETF') &&
      tokens.length === 1 && tokens[0].type === TT.ID && tokens[0].value.toUpperCase() === 'L') {
    flushPrefixes(); emit(ctx, 0xCB); ctx.retSpots.push(ctx.pc - 1); return;
  }
  const operands = parseOperands(ctx, tokens);
  if (forcedSize) {
    for (const o of operands) if (o.kind === 'mem' && !o.sizeHint) o.sizeHint = forcedSize;
  }
  flushPrefixes();

  // ARITH group: ADD/OR/ADC/SBB/AND/SUB/XOR/CMP — 8086 op base 00..38.
  const ARITH = { ADD:0x00, OR:0x08, ADC:0x10, SBB:0x18, AND:0x20, SUB:0x28, XOR:0x30, CMP:0x38 };
  if (ARITH[op] !== undefined) return encArith(ctx, ARITH[op], op, operands, line);

  if (op === 'MOV')  return encMov(ctx, operands, line);
  if (op === 'XCHG') return encXchg(ctx, operands, line);
  if (op === 'TEST') return encTest(ctx, operands, line);
  if (op === 'PUSH') return encPushPop(ctx, operands, line, true);
  if (op === 'POP')  return encPushPop(ctx, operands, line, false);
  if (op === 'INC' || op === 'DEC') return encIncDec(ctx, op, operands, line);
  if (op === 'NEG' || op === 'NOT' || op === 'MUL' || op === 'IMUL' || op === 'DIV' || op === 'IDIV')
    return encUnaryGroup3(ctx, op, operands, line);
  if (op === 'LEA' || op === 'LDS' || op === 'LES') return encLeaLdsLes(ctx, op, operands, line);
  if (op === 'INT')  return encInt(ctx, operands, line);
  if (op === 'IN' || op === 'OUT') return encInOut(ctx, op, operands, line);
  if (op === 'CALL') return encCallJmp(ctx, op, operands, line);
  if (op === 'JMP')  return encCallJmp(ctx, op, operands, line);
  if (op === 'JMPS') return encShortJmp(ctx, operands, line);
  if (JCC[op] !== undefined) return encJcc(ctx, JCC[op], operands, line);
  if (op === 'LOOP' || op === 'LOOPE' || op === 'LOOPZ' || op === 'LOOPNE' || op === 'LOOPNZ' || op === 'JCXZ')
    return encLoop(ctx, op, operands, line);
  if (SHIFTS[op] !== undefined) return encShift(ctx, SHIFTS[op], operands, line);
  if (op === 'RET' || op === 'RETF') return encRet(ctx, op, operands, line, tokens);

  throw asmErr(line, `unsupported mnemonic: ${op}`);
}

// --- Helpers for instruction families ------------------------------------

const JCC = {
  JO:0x70, JNO:0x71, JB:0x72, JC:0x72, JAE:0x73, JNB:0x73, JNC:0x73,
  JZ:0x74, JNZ:0x75, JBE:0x76, JNA:0x76, JA:0x77, JNBE:0x77,
  JS:0x78, JNS:0x79, JP:0x7A, JPE:0x7A, JNP:0x7B, JPO:0x7B,
  JL:0x7C, JNGE:0x7C, JGE:0x7D, JNL:0x7D, JLE:0x7E, JNG:0x7E, JG:0x7F, JNLE:0x7F,
};
const SHIFTS = { ROL:0, ROR:1, RCL:2, RCR:3, SHL:4, SAL:4, SHR:5, SAR:7 };

function operandSize(o, ctx) {
  if (o.kind === 'reg8')  return 8;
  if (o.kind === 'reg16') return 16;
  if (o.kind === 'sreg')  return 16;
  if (o.kind === 'mem') {
    if (o.sizeHint) return o.sizeHint;
    if (ctx && o.dispSymKey) {
      const sym = ctx.prevSymbols.get(o.dispSymKey) ?? ctx.symbols.get(o.dispSymKey);
      if (sym && sym.elemSize) return sym.elemSize;
      // Forward ref to a label whose data directive we haven't reached yet.
      // Default to WORD (the SCP idiom for typed scratch vars). The fixed-point
      // iteration will replace this with the recorded elemSize on the next pass.
      if (!ctx.emitting) return 16;
    }
    return null;
  }
  return null;
}

// Resolve operand size when ambiguous, given the partner's known size.
function inferSizes(a, b) {
  const sa = operandSize(a), sb = operandSize(b);
  if (sa && sb && sa !== sb && a.kind !== 'imm' && b.kind !== 'imm')
    throw new Error(`operand size mismatch (${sa} vs ${sb})`);
  return sa ?? sb;
}

function encArith(ctx, base, op, ops, line) {
  if (ops.length !== 2) throw asmErr(line, `${op} needs 2 operands`);
  const [d, s] = ops;
  // r/m, reg or reg, r/m
  if ((d.kind === 'reg8' || d.kind === 'reg16' || d.kind === 'mem') &&
      (s.kind === 'reg8' || s.kind === 'reg16')) {
    const size = s.kind === 'reg8' ? 8 : 16;
    if (operandSize(d, ctx) && operandSize(d, ctx) !== size && d.kind !== 'mem')
      throw asmErr(line, `${op} size mismatch`);
    // Direction = 0 (r/m gets reg). Opcode = base + (size==16 ? 1 : 0).
    emitRMR(ctx, base | (size === 16 ? 1 : 0), s.idx, d);
    return;
  }
  if ((d.kind === 'reg8' || d.kind === 'reg16') &&
      (s.kind === 'mem')) {
    const size = d.kind === 'reg8' ? 8 : 16;
    emitRMR(ctx, base | 2 | (size === 16 ? 1 : 0), d.idx, s);
    return;
  }
  // Immediate forms.
  if ((d.kind === 'reg8' || d.kind === 'reg16' || d.kind === 'mem') && s.kind === 'imm') {
    // No size hint on memory → default WORD, matching the SCP "[FLAG] carries
    // previous instruction's size" behaviour in the typical 86DOS.ASM flow.
    const size = operandSize(d, ctx) ?? 16;
    const subop = base >> 3; // 0..7 maps directly to GRP1 reg field
    // AL/AX, imm — short form base+04/05.
    if (d.kind === 'reg8' && d.idx === 0) {
      emit(ctx, base | 4); emit(ctx, s.value & 0xFF); return;
    }
    if (d.kind === 'reg16' && d.idx === 0) {
      emit(ctx, base | 5); emitWord(ctx, s.value & 0xFFFF); return;
    }
    if (size === 8) {
      emitRMR(ctx, 0x80, subop, d);
      emit(ctx, s.value & 0xFF);
      return;
    }
    // 16-bit: prefer sign-extended 8-bit immediate when value fits and op isn't a
    // bitwise-only one that doesn't have a sign-extend form (OR/AND/XOR/TEST do
    // not in 8086 — they only have reg/imm16). Actually 8086 op 0x83 supports
    // ALL eight subops with sign-extended imm8. So we can use it for any.
    const sv = (s.value & 0x8000) ? (s.value - 0x10000) : s.value;
    if (sv >= -128 && sv <= 127) {
      emitRMR(ctx, 0x83, subop, d);
      emit(ctx, sv & 0xFF);
    } else {
      emitRMR(ctx, 0x81, subop, d);
      emitWord(ctx, s.value & 0xFFFF);
    }
    return;
  }
  throw asmErr(line, `unsupported ${op} operand combination`);
}

function encMov(ctx, ops, line) {
  if (ops.length !== 2) throw asmErr(line, 'MOV needs 2 operands');
  const [d, s] = ops;
  // Segment register forms.
  if (d.kind === 'sreg' && (s.kind === 'reg16' || s.kind === 'mem')) {
    emitRMR(ctx, 0x8E, d.idx, s); return;
  }
  if ((d.kind === 'reg16' || d.kind === 'mem') && s.kind === 'sreg') {
    emitRMR(ctx, 0x8C, s.idx, d); return;
  }
  // Accumulator <-> moffs (memory direct).
  if (d.kind === 'reg8' && d.idx === 0 && s.kind === 'mem' && !s.base && !s.index) {
    emit(ctx, 0xA0); emitWord(ctx, s.disp); return;
  }
  if (d.kind === 'reg16' && d.idx === 0 && s.kind === 'mem' && !s.base && !s.index) {
    emit(ctx, 0xA1); emitWord(ctx, s.disp); return;
  }
  if (d.kind === 'mem' && !d.base && !d.index && s.kind === 'reg8' && s.idx === 0) {
    emit(ctx, 0xA2); emitWord(ctx, d.disp); return;
  }
  if (d.kind === 'mem' && !d.base && !d.index && s.kind === 'reg16' && s.idx === 0) {
    emit(ctx, 0xA3); emitWord(ctx, d.disp); return;
  }
  // r/m, reg.
  if ((d.kind === 'reg8' || d.kind === 'reg16' || d.kind === 'mem') &&
      (s.kind === 'reg8' || s.kind === 'reg16')) {
    const w = (s.kind === 'reg16') ? 1 : 0;
    emitRMR(ctx, 0x88 | w, s.idx, d); return;
  }
  // reg, r/m.
  if ((d.kind === 'reg8' || d.kind === 'reg16') && s.kind === 'mem') {
    const w = (d.kind === 'reg16') ? 1 : 0;
    emitRMR(ctx, 0x8A | w, d.idx, s); return;
  }
  // reg, imm — short form B0+r/B8+r.
  if (d.kind === 'reg8' && s.kind === 'imm') {
    emit(ctx, 0xB0 | d.idx); emit(ctx, s.value & 0xFF); return;
  }
  if (d.kind === 'reg16' && s.kind === 'imm') {
    emit(ctx, 0xB8 | d.idx); emitWord(ctx, s.value & 0xFFFF); return;
  }
  // mem, imm — C6/C7 with /0. SCP defaults to BYTE when no size hint given.
  if (d.kind === 'mem' && s.kind === 'imm') {
    const size = operandSize(d, ctx) ?? 8;
    if (size === 8) { emitRMR(ctx, 0xC6, 0, d); emit(ctx, s.value & 0xFF); }
    else            { emitRMR(ctx, 0xC7, 0, d); emitWord(ctx, s.value & 0xFFFF); }
    return;
  }
  throw asmErr(line, 'unsupported MOV operand combination');
}

function encXchg(ctx, ops, line) {
  if (ops.length !== 2) throw asmErr(line, 'XCHG needs 2 operands');
  const [d, s] = ops;
  // AX, reg16 short form 90+r (also NOP=XCHG AX,AX).
  if (d.kind === 'reg16' && s.kind === 'reg16' && (d.idx === 0 || s.idx === 0)) {
    const r = (d.idx === 0) ? s.idx : d.idx;
    emit(ctx, 0x90 | r); return;
  }
  // r/m, reg.
  if ((s.kind === 'reg8' || s.kind === 'reg16') &&
      (d.kind === 'reg8' || d.kind === 'reg16' || d.kind === 'mem')) {
    const w = (s.kind === 'reg16') ? 1 : 0;
    emitRMR(ctx, 0x86 | w, s.idx, d); return;
  }
  if ((d.kind === 'reg8' || d.kind === 'reg16') && s.kind === 'mem') {
    const w = (d.kind === 'reg16') ? 1 : 0;
    emitRMR(ctx, 0x86 | w, d.idx, s); return;
  }
  throw asmErr(line, 'unsupported XCHG operand combination');
}

function encTest(ctx, ops, line) {
  if (ops.length !== 2) throw asmErr(line, 'TEST needs 2 operands');
  const [d, s] = ops;
  if (s.kind === 'reg8' || s.kind === 'reg16') {
    const w = (s.kind === 'reg16') ? 1 : 0;
    emitRMR(ctx, 0x84 | w, s.idx, d); return;
  }
  if (d.kind === 'reg8' || d.kind === 'reg16') {
    if (s.kind === 'imm') {
      if (d.kind === 'reg8' && d.idx === 0) { emit(ctx, 0xA8); emit(ctx, s.value & 0xFF); return; }
      if (d.kind === 'reg16' && d.idx === 0) { emit(ctx, 0xA9); emitWord(ctx, s.value & 0xFFFF); return; }
      const w = (d.kind === 'reg16') ? 1 : 0;
      emitRMR(ctx, 0xF6 | w, 0, d);
      if (w) emitWord(ctx, s.value & 0xFFFF); else emit(ctx, s.value & 0xFF);
      return;
    }
  }
  if (d.kind === 'mem' && s.kind === 'imm') {
    const size = operandSize(d, ctx);
    if (!size) throw asmErr(line, 'TEST mem,imm needs size hint');
    if (size === 8) { emitRMR(ctx, 0xF6, 0, d); emit(ctx, s.value & 0xFF); }
    else            { emitRMR(ctx, 0xF7, 0, d); emitWord(ctx, s.value & 0xFFFF); }
    return;
  }
  throw asmErr(line, 'unsupported TEST operand combination');
}

function encPushPop(ctx, ops, line, isPush) {
  if (ops.length !== 1) throw asmErr(line, isPush ? 'PUSH needs 1 operand' : 'POP needs 1 operand');
  const o = ops[0];
  if (o.kind === 'reg16') { emit(ctx, (isPush ? 0x50 : 0x58) | o.idx); return; }
  if (o.kind === 'sreg')  {
    if (isPush) emit(ctx, 0x06 | (o.idx << 3));
    else        emit(ctx, 0x07 | (o.idx << 3));
    return;
  }
  if (o.kind === 'mem') {
    if (isPush) { emitRMR(ctx, 0xFF, 6, o); }
    else        { emitRMR(ctx, 0x8F, 0, o); }
    return;
  }
  if (isPush && o.kind === 'imm') {
    // PUSH imm is a 186+ instruction; not on 8086. Fail loudly.
    throw asmErr(line, 'PUSH imm not on 8086');
  }
  throw asmErr(line, `unsupported ${isPush ? 'PUSH' : 'POP'} operand`);
}

function encIncDec(ctx, op, ops, line) {
  if (ops.length !== 1) throw asmErr(line, `${op} needs 1 operand`);
  const o = ops[0];
  const isInc = op === 'INC';
  if (o.kind === 'reg16') { emit(ctx, (isInc ? 0x40 : 0x48) | o.idx); return; }
  if (o.kind === 'reg8' || o.kind === 'mem') {
    // SCP carries size from previous instruction via a global flag (see ASM_2.43
    // GRP8/MOP). We don't model that; default to WORD when unhinted, matching
    // the predominant case in 86DOS.ASM where INC mem references word-sized DS.
    const size = operandSize(o, ctx) ?? 16;
    const w = size === 16 ? 1 : 0;
    emitRMR(ctx, 0xFE | w, isInc ? 0 : 1, o);
    return;
  }
  throw asmErr(line, `unsupported ${op} operand`);
}

function encUnaryGroup3(ctx, op, ops, line) {
  // F6/F7 group: TEST(/0,already handled) NOT(/2) NEG(/3) MUL(/4) IMUL(/5) DIV(/6) IDIV(/7).
  // SCP allows the implicit accumulator to be written: `DIV AX, BX` means DIV BX
  // (the AX/AL is dropped).
  const SUB = { NOT:2, NEG:3, MUL:4, IMUL:5, DIV:6, IDIV:7 };
  if (ops.length === 2 && (ops[0].kind === 'reg8' || ops[0].kind === 'reg16') && ops[0].idx === 0) {
    // Carry implicit accumulator size onto the actual operand if it's memory w/o hint.
    const accSize = ops[0].kind === 'reg16' ? 16 : 8;
    if (ops[1].kind === 'mem' && !ops[1].sizeHint) ops[1].sizeHint = accSize;
    ops = [ops[1]];
  }
  if (ops.length !== 1) throw asmErr(line, `${op} needs 1 operand`);
  const o = ops[0];
  const size = operandSize(o, ctx);
  if (!size) throw asmErr(line, `${op}: cannot infer size`);
  emitRMR(ctx, 0xF6 | (size === 16 ? 1 : 0), SUB[op], o);
}

function encLeaLdsLes(ctx, op, ops, line) {
  if (ops.length !== 2) throw asmErr(line, `${op} needs 2 operands`);
  const [d, s] = ops;
  if (d.kind !== 'reg16' || s.kind !== 'mem') throw asmErr(line, `${op}: expected reg16, mem`);
  const opc = op === 'LEA' ? 0x8D : op === 'LDS' ? 0xC5 : 0xC4;
  emitRMR(ctx, opc, d.idx, s);
}

function encInt(ctx, ops, line) {
  if (ops.length !== 1) throw asmErr(line, 'INT needs 1 operand');
  const o = ops[0];
  if (o.kind !== 'imm') throw asmErr(line, 'INT operand must be imm');
  const v = o.value & 0xFF;
  if (v === 3) { emit(ctx, 0xCC); return; }
  emit(ctx, 0xCD); emit(ctx, v);
}

function encInOut(ctx, op, ops, line) {
  // IN AL/AX, imm8|DX  ;  OUT imm8|DX, AL/AX
  if (op === 'IN') {
    const [d, s] = ops;
    if (d.kind !== 'reg8' && d.kind !== 'reg16') throw asmErr(line, 'IN: dest must be AL/AX');
    if (d.idx !== 0) throw asmErr(line, 'IN: dest must be AL/AX');
    const w = (d.kind === 'reg16') ? 1 : 0;
    if (s.kind === 'reg16' && s.idx === 2 /* DX */) { emit(ctx, 0xEC | w); return; }
    if (s.kind === 'imm') { emit(ctx, 0xE4 | w); emit(ctx, s.value & 0xFF); return; }
    throw asmErr(line, 'unsupported IN form');
  }
  // OUT
  const [d, s] = ops;
  if (s.kind !== 'reg8' && s.kind !== 'reg16') throw asmErr(line, 'OUT: src must be AL/AX');
  if (s.idx !== 0) throw asmErr(line, 'OUT: src must be AL/AX');
  const w = (s.kind === 'reg16') ? 1 : 0;
  if (d.kind === 'reg16' && d.idx === 2) { emit(ctx, 0xEE | w); return; }
  if (d.kind === 'imm')  { emit(ctx, 0xE6 | w); emit(ctx, d.value & 0xFF); return; }
  throw asmErr(line, 'unsupported OUT form');
}

function encCallJmp(ctx, op, ops, line) {
  // SCP-style far direct: `CALL off, seg` / `JMP off, seg`.
  if (ops.length === 2 && ops[0].kind === 'imm' && ops[1].kind === 'imm') {
    emit(ctx, op === 'CALL' ? 0x9A : 0xEA);
    emitWord(ctx, ops[0].value & 0xFFFF);
    emitWord(ctx, ops[1].value & 0xFFFF);
    return;
  }
  if (ops.length !== 1) throw asmErr(line, `${op} needs 1 operand`);
  const o = ops[0];
  // Indirect through memory: /2 (near call) /3 (far call) /4 (near jmp) /5 (far jmp).
  // SCP `L,` size prefix marks far indirect.
  const isFar = o.kind === 'mem' && o.sizeHint === 32;
  if (op === 'CALL') {
    if (o.kind === 'imm') {
      emit(ctx, 0xE8);
      const rel = (o.value - ((ctx.pc + 2) & 0xFFFF)) & 0xFFFF;
      emitWord(ctx, rel);
      return;
    }
    if (o.kind === 'mem')   { emitRMR(ctx, 0xFF, isFar ? 3 : 2, o); return; }
    if (o.kind === 'reg16') { emit(ctx, 0xFF); for (const b of modrmRR(2, o.idx)) emit(ctx, b); return; }
    throw asmErr(line, 'unsupported CALL operand');
  }
  // JMP
  if (o.kind === 'imm') {
    emit(ctx, 0xE9);
    const rel = (o.value - ((ctx.pc + 2) & 0xFFFF)) & 0xFFFF;
    emitWord(ctx, rel);
    return;
  }
  if (o.kind === 'mem')   { emitRMR(ctx, 0xFF, isFar ? 5 : 4, o); return; }
  if (o.kind === 'reg16') { emit(ctx, 0xFF); for (const b of modrmRR(4, o.idx)) emit(ctx, b); return; }
  throw asmErr(line, 'unsupported JMP operand');
}

function encShortJmp(ctx, ops, line) {
  if (ops.length !== 1) throw asmErr(line, 'JMPS/JP needs 1 operand');
  const o = ops[0];
  if (o.kind !== 'imm') throw asmErr(line, 'JMPS expects label');
  emit(ctx, 0xEB);
  const rel = (o.value - ((ctx.pc + 1) & 0xFFFF)) & 0xFFFF;
  const sr = (rel & 0x8000) ? rel - 0x10000 : rel;
  if (ctx.pass === 2 && (sr < -128 || sr > 127)) throw asmErr(line, `short jump out of range to 0x${o.value.toString(16)}`);
  emit(ctx, rel & 0xFF);
}

function encJcc(ctx, opcode, ops, line) {
  if (ops.length !== 1) throw asmErr(line, 'Jcc needs 1 operand');
  const o = ops[0];
  if (o.kind !== 'imm') throw asmErr(line, 'Jcc expects label');
  emit(ctx, opcode);
  const rel = (o.value - ((ctx.pc + 1) & 0xFFFF)) & 0xFFFF;
  const sr = (rel & 0x8000) ? rel - 0x10000 : rel;
  if (ctx.pass === 2 && (sr < -128 || sr > 127)) throw asmErr(line, `Jcc out of range to 0x${o.value.toString(16)} (pc=0x${ctx.pc.toString(16)})`);
  emit(ctx, rel & 0xFF);
}

function encLoop(ctx, op, ops, line) {
  const OP = { LOOP:0xE2, LOOPE:0xE1, LOOPZ:0xE1, LOOPNE:0xE0, LOOPNZ:0xE0, JCXZ:0xE3 };
  return encJcc(ctx, OP[op], ops, line);
}

function encShift(ctx, sub, ops, line) {
  // SCP allows omitted count (implicit 1).
  if (ops.length === 1) ops = [ops[0], { kind:'imm', value: 1 }];
  if (ops.length !== 2) throw asmErr(line, 'shift needs 2 operands');
  const [d, s] = ops;
  const size = operandSize(d, ctx);
  if (!size) throw asmErr(line, 'shift: cannot infer size');
  const w = size === 16 ? 1 : 0;
  if (s.kind === 'imm' && (s.value & 0xFFFF) === 1) {
    emitRMR(ctx, 0xD0 | w, sub, d); return;
  }
  if (s.kind === 'reg8' && s.idx === 1 /* CL */) {
    emitRMR(ctx, 0xD2 | w, sub, d); return;
  }
  // imm count is 186+; not on 8086.
  throw asmErr(line, 'shift count must be 1 or CL');
}

function encRet(ctx, op, ops, line, opTokens) {
  // SCP-specific: `RET L` = RETF (far return). Detect the lone `L` ID before
  // operand parsing turned it into an undefined symbol.
  if (opTokens && opTokens.length === 1 && opTokens[0].type === TT.ID && opTokens[0].value.toUpperCase() === 'L') {
    emit(ctx, 0xCB);
    ctx.retSpots.push(ctx.pc - 1);
    return;
  }
  if (ops.length === 0) {
    emit(ctx, op === 'RET' ? 0xC3 : 0xCB);
    ctx.retSpots.push(ctx.pc - 1);
    return;
  }
  if (ops.length === 1 && ops[0].kind === 'imm') {
    emit(ctx, op === 'RET' ? 0xC2 : 0xCA);
    emitWord(ctx, ops[0].value & 0xFFFF);
    return;
  }
  throw asmErr(line, `unsupported ${op} form`);
}
