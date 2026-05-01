// SCP 8086 Assembler (Tim Paterson dialect, version 2.43) — JS implementation.
//
// Targets the source files in DOS-History/Paterson-Listings:
//   - 86-DOS_1.00/86DOS.ASM
//   - SCP_ASM/ASM_2.43.ASM (self-host)
//
// Dialect summary:
//   - Numbers default decimal; H-suffix for hex; B-suffix for binary; O/Q for octal.
//   - Strings: single-quoted, used inside DB.
//   - Labels: NAME: at start of line. Optional whitespace.
//   - Directives: ORG <expr>, PUT <expr>, EQU/= for symbols, DB/DW/DS for data.
//                 IF <expr> ... ELSE ... ENDIF (nested allowed). END terminates.
//   - Expressions: + - * / ( ), unary -, $ = current PC, decimal/hex/char literals.
//   - SCP-specific mnemonics: JMPS (short jmp), LODB/LODW/STOB/STOW/MOVB/MOVW/
//                              CMPB/CMPW/SCAB/SCAW (string ops, byte/word).
//   - Output: flat binary at PUT address (defaults to 0; .COM files use 100H).
//
// Two-pass: pass 1 collects symbol table by tracking sizes; pass 2 emits bytes.
// Some instruction sizes depend on operand magnitude (e.g. ADD reg,imm — sign-extend
// short form vs full-word). We resolve these by assuming the longest legal form in
// pass 1 and shrinking only when it would not change later label addresses.
// (86DOS.ASM doesn't actually need shrinking — verified by inspection — so for now
// we always pick the canonical form deterministically.)

'use strict';

// --- Lexer ---------------------------------------------------------------

const TT = {
  EOL: 'eol', EOF: 'eof', ID: 'id', NUM: 'num', STR: 'str',
  COLON: ':', COMMA: ',', LBRK: '[', RBRK: ']', LPAREN: '(', RPAREN: ')',
  PLUS: '+', MINUS: '-', STAR: '*', SLASH: '/', DOLLAR: '$', EQ: '=',
};

class Lexer {
  constructor(src) {
    // Normalise line endings; keep tabs (SCP uses them heavily).
    this.src = src.replace(/\r\n?/g, '\n');
    this.i = 0;
    this.line = 1;
  }
  // Peek byte without consuming.
  _peek(o = 0) { return this.src.charCodeAt(this.i + o); }
  _at(s) { return this.src.startsWith(s, this.i); }
  _isAlpha(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95; }
  _isDigit(c) { return c >= 48 && c <= 57; }
  _isAlnum(c) { return this._isAlpha(c) || this._isDigit(c); }

  // Skip spaces/tabs and ;-comments to end of line. Newlines are tokens.
  _skipWS() {
    for (;;) {
      const c = this._peek();
      if (c === 32 || c === 9) { this.i++; continue; }
      if (c === 59 /* ; */) { while (this.i < this.src.length && this.src.charCodeAt(this.i) !== 10) this.i++; continue; }
      return;
    }
  }

  // Tokenise one line at a time. Returns array of tokens ending with EOL or EOF.
  // Identifiers preserve original case but compare case-insensitively elsewhere.
  next() {
    this._skipWS();
    if (this.i >= this.src.length) return { type: TT.EOF, line: this.line };
    const c = this._peek();
    const startLine = this.line;
    if (c === 10) { this.i++; this.line++; return { type: TT.EOL, line: startLine }; }
    if (this._isAlpha(c)) {
      const s = this.i;
      while (this._isAlnum(this._peek())) this.i++;
      return { type: TT.ID, value: this.src.slice(s, this.i), line: startLine };
    }
    if (this._isDigit(c)) {
      // Read maximal alnum run; classify by suffix. Hex digits OK only if H suffix.
      const s = this.i;
      while (this._isAlnum(this._peek())) this.i++;
      const raw = this.src.slice(s, this.i);
      return { type: TT.NUM, value: parseNumber(raw, startLine), raw, line: startLine };
    }
    if (c === 39 /* ' */) {
      // String literal; SCP allows '' as escape for ' (rare in these sources).
      this.i++;
      const out = [];
      while (this.i < this.src.length) {
        const ch = this._peek();
        if (ch === 39) {
          if (this._peek(1) === 39) { out.push(39); this.i += 2; continue; }
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
  // SCP format: trailing letter selects base. Default decimal.
  // H = hex, B = binary, O/Q = octal, D = decimal.
  const last = raw[raw.length - 1].toUpperCase();
  let base = 10, body = raw;
  if (last === 'H') { base = 16; body = raw.slice(0, -1); }
  else if (last === 'B' && /^[01]+B$/i.test(raw)) { base = 2; body = raw.slice(0, -1); }
  else if (last === 'O' || last === 'Q') { base = 8; body = raw.slice(0, -1); }
  else if (last === 'D' && /^[0-9]+D$/i.test(raw)) { base = 10; body = raw.slice(0, -1); }
  if (!body.length) throw asmErr(line, `bad number '${raw}'`);
  const n = parseInt(body, base);
  if (Number.isNaN(n) || !new RegExp(`^[0-9a-f]+$`, 'i').test(body)) throw asmErr(line, `bad number '${raw}'`);
  // Validate digits actually fit chosen base.
  for (const d of body) {
    const v = parseInt(d, base);
    if (Number.isNaN(v)) throw asmErr(line, `bad digit '${d}' in '${raw}'`);
  }
  return n;
}

function asmErr(line, msg) {
  const e = new Error(`scpasm: line ${line}: ${msg}`);
  e.line = line;
  return e;
}

// --- Public API ----------------------------------------------------------

export function assemble(source, opts = {}) {
  const lx = new Lexer(source);
  // Drain into an array of token-runs, one per line, for easier pass replay.
  const lines = tokenize(lx);
  const ctx = {
    symbols: new Map(), // upper-case name -> { value, kind }
    pc: 0, // logical address (reflects ORG)
    putBase: null, // PUT directive — load address; null means "use first ORG"
    output: [], // bytes
    pass: 1,
    skipStack: [], // IF nesting; entry = { taken, sawElse, parentSkip }
    skipping: false,
    end: false,
    opts,
  };
  // Pass 1: collect symbols + sizes.
  runPass(ctx, lines, 1);
  // Pass 2: emit.
  runPass(ctx, lines, 2);
  // Determine load address.
  const base = ctx.putBase ?? 0;
  return { bytes: new Uint8Array(ctx.output), base, symbols: ctx.symbols };
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
  ctx.skipStack = [];
  ctx.skipping = false;
  ctx.end = false;
  for (const row of lines) {
    if (ctx.end) break;
    assembleLine(ctx, row);
  }
}

// Stub line handler — extended in subsequent commits.
function assembleLine(ctx, tokens) {
  // Strip leading label "NAME:" or "NAME =/EQU expr" definitions.
  let i = 0;
  // Forms:
  //   LABEL:                   plain label (value = pc)
  //   LABEL: EQU expr  /  LABEL: = expr     (label colon is decorative; value = expr)
  //   LABEL EQU expr   /  LABEL = expr      (no colon; value = expr)
  if (tokens[i]?.type === TT.ID && tokens[i+1]?.type === TT.COLON) {
    const j = i + 2;
    const isEqu = tokens[j]?.type === TT.EQ ||
                  (tokens[j]?.type === TT.ID && tokens[j].value.toUpperCase() === 'EQU');
    if (isEqu) {
      const name = tokens[i].value;
      const rest = tokens.slice(j + 1);
      if (!ctx.skipping) {
        const v = evalExpr(ctx, rest, 0).value;
        defineSymbol(ctx, name, v, 'equ');
      }
      return;
    }
    defineLabel(ctx, tokens[i].value, ctx.pc);
    i += 2;
  } else if (tokens[i]?.type === TT.ID && (tokens[i+1]?.type === TT.EQ ||
             (tokens[i+1]?.type === TT.ID && tokens[i+1].value.toUpperCase() === 'EQU'))) {
    const name = tokens[i].value;
    const rest = tokens.slice(i + 2);
    if (!ctx.skipping) {
      const v = evalExpr(ctx, rest, 0).value;
      defineSymbol(ctx, name, v, 'equ');
    }
    return;
  }
  // After label, look for directive or instruction.
  if (i >= tokens.length) return;
  const tok = tokens[i];
  if (tok.type !== TT.ID) throw asmErr(tok.line, `expected directive or mnemonic, got ${tok.type}`);
  const op = tok.value.toUpperCase();
  // IF/ELSE/ENDIF must execute even while skipping (to track nesting).
  if (op === 'IF') { handleIf(ctx, tokens.slice(i + 1), tok.line); return; }
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
  if (op === 'DB') { dataBytes(ctx, tokens.slice(i + 1), 1, tok.line); return; }
  if (op === 'DW') { dataBytes(ctx, tokens.slice(i + 1), 2, tok.line); return; }
  if (op === 'DS') {
    const v = evalExpr(ctx, tokens.slice(i + 1), 0).value & 0xFFFF;
    for (let k = 0; k < v; k++) emit(ctx, 0);
    return;
  }
  // Instructions — encoder added in later commits.
  encodeInstruction(ctx, op, tokens.slice(i + 1), tok.line);
}

function defineLabel(ctx, name, value) {
  if (ctx.pass === 1) defineSymbol(ctx, name, value, 'label');
}
function defineSymbol(ctx, name, value, kind) {
  const key = name.toUpperCase();
  if (ctx.pass === 1) {
    if (ctx.symbols.has(key)) throw new Error(`duplicate symbol ${name}`);
    ctx.symbols.set(key, { value, kind, name });
  } else {
    // Allow redefinition only for EQUs whose value matches pass 1.
    const cur = ctx.symbols.get(key);
    if (cur && cur.value !== value && kind === 'equ') {
      // SCP allows redefinition; keep latest. Not exercised by 86DOS.ASM.
      ctx.symbols.set(key, { value, kind, name });
    }
  }
}

function handleIf(ctx, rest, line) {
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
  ctx.skipping = top.taken; // flip
}
function handleEndif(ctx, line) {
  const top = ctx.skipStack.pop();
  if (!top) throw asmErr(line, 'ENDIF without IF');
  // Recompute skipping by walking remaining stack.
  ctx.skipping = ctx.skipStack.some(f => f.parentSkip) ||
                 ctx.skipStack.some(f => !f.parentSkip && (f.sawElse ? f.taken : !f.taken));
}

function dataBytes(ctx, tokens, size, line) {
  // Comma-separated list of expressions or strings.
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

// --- Expression evaluator ------------------------------------------------
// Grammar (precedence low → high):
//   expr   := term (('+' | '-') term)*
//   term   := unary (('*' | '/') unary)*
//   unary  := '-' unary | atom
//   atom   := NUM | '$' | ID | '(' expr ')'
// On undefined symbol in pass 1 we return 0 (later resolved); in pass 2 we throw.

function evalExpr(ctx, tokens, start) {
  const p = { tokens, i: start };
  const v = parseAdd(ctx, p);
  return { value: v & 0xFFFF, next: p.i };
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
  if (!t) throw new Error('unexpected end of expression');
  if (t.type === TT.NUM)    { p.i++; return t.value | 0; }
  if (t.type === TT.DOLLAR) { p.i++; return ctx.pc | 0; }
  if (t.type === TT.LPAREN) { p.i++; const v = parseAdd(ctx, p);
                              if (p.tokens[p.i]?.type !== TT.RPAREN) throw asmErr(t.line, 'missing )');
                              p.i++; return v; }
  if (t.type === TT.ID) {
    p.i++;
    const key = t.value.toUpperCase();
    const sym = ctx.symbols.get(key);
    if (sym) return sym.value | 0;
    if (ctx.pass === 1) return 0; // forward reference
    throw asmErr(t.line, `undefined symbol '${t.value}'`);
  }
  // Char literal as part of expression: 'A' inside DW for example.
  if (t.type === TT.STR) {
    p.i++;
    if (t.value.length === 0) return 0;
    if (t.value.length === 1) return t.value[0];
    if (t.value.length === 2) return t.value[0] | (t.value[1] << 8);
    throw asmErr(t.line, 'string too long for expression');
  }
  throw asmErr(t.line ?? 0, `unexpected token in expression: ${t.type}`);
}

// --- Instruction encoder -------------------------------------------------
// Tiny bootstrap covering only what's needed for the smoke test in
// test/scpasm_smoke.js. Real encoder lands in subsequent commits.

function encodeInstruction(ctx, op, tokens, line) {
  switch (op) {
    case 'NOP': emit(ctx, 0x90); return;
    case 'RET': emit(ctx, 0xC3); return;
    case 'CLC': emit(ctx, 0xF8); return;
    case 'STC': emit(ctx, 0xF9); return;
    case 'CLI': emit(ctx, 0xFA); return;
    case 'STI': emit(ctx, 0xFB); return;
    case 'CLD': emit(ctx, 0xFC); return;
    case 'STD': emit(ctx, 0xFD); return;
    case 'INT': {
      const v = evalExpr(ctx, tokens, 0).value & 0xFF;
      if (v === 3) { emit(ctx, 0xCC); return; }
      emit(ctx, 0xCD); emit(ctx, v); return;
    }
    case 'IRET': emit(ctx, 0xCF); return;
    case 'LODB': emit(ctx, 0xAC); return;
    case 'LODW': emit(ctx, 0xAD); return;
    case 'STOB': emit(ctx, 0xAA); return;
    case 'STOW': emit(ctx, 0xAB); return;
    case 'MOVB': emit(ctx, 0xA4); return;
    case 'MOVW': emit(ctx, 0xA5); return;
    case 'CMPB': emit(ctx, 0xA6); return;
    case 'CMPW': emit(ctx, 0xA7); return;
    case 'SCAB': emit(ctx, 0xAE); return;
    case 'SCAW': emit(ctx, 0xAF); return;
  }
  throw asmErr(line, `instruction not yet supported: ${op}`);
}
