// Smoke tests for scpasm. Encoding expectations cross-checked against ndisasm
// or known opcode tables. Run with: node test/scpasm_smoke.js
import { assemble } from '../tools/scpasm.js';

// hex helper
const H = (b) => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');

const cases = [
  // --- nullary ---
  [`	NOP\n	NOP\n	RET\n`, '9090c3'],
  [`	CLC\n	STC\n	CLI\n	STI\n	CLD\n	STD\n	CMC\n`, 'f8f9fafbfcfdf5'],
  [`	DI\n	EI\n	UP\n	DOWN\n	IRET\n	INTO\n`, 'fafbfcfdcfce'],
  [`	LODB\n	LODW\n	STOB\n	STOW\n	MOVB\n	MOVW\n	CMPB\n	CMPW\n	SCAB\n	SCAW\n`, 'acadaaaba4a5a6a7aeaf'],
  // INT
  [`	INT	33\n	INT	3\n`, 'cd21cc'],
  // MOV reg, imm
  [`	MOV	AL,5\n	MOV	AX,1234H\n`, 'b005b83412'],
  // MOV reg, reg
  [`	MOV	AX,BX\n	MOV	BL,AH\n`, '89d888e3'],
  // MOV reg, [direct] / [direct], reg via accumulator short forms
  [`	ORG 100H\nFOO:	MOV	AL,[FOO]\n`, 'a00001'], // mov al, [0x100]
  // MOV with ModR/M memory: [BX], [BP+disp]
  [`	MOV	AX,[BX]\n	MOV	[BP+4],CX\n	MOV	AL,[SI]\n	MOV	[BP],AL\n`,
    '8b07' + '894e04' + '8a04' + '884600'],
  // MOV sreg
  [`	MOV	DS,AX\n	MOV	AX,ES\n`, '8ed88cc0'],
  // ADD/SUB/CMP
  // AL/AX,imm short forms (04/05) are preferred over the sign-extend GRP1 form.
  [`	ADD	AL,5\n	ADD	AX,5\n	ADD	AX,1000H\n`, '0405' + '050500' + '050010'],
  [`	CMP	BX,CX\n	CMP	[BX],SI\n`, '39cb' + '3937'],
  // PUSH/POP
  [`	PUSH	AX\n	PUSH	BP\n	PUSH	DS\n	POP	ES\n`, '5055' + '1e07'],
  // INC/DEC reg
  [`	INC	AX\n	INC	DI\n	DEC	BX\n`, '40474b'],
  // INT 21h via SCP-style INT 33
  [`	MOV	AH,9\n	INT	33\n`, 'b409cd21'],
  // Conditional jumps
  [`L1:	NOP\n	JZ	L1\n	JNZ	L1\n	JC	L1\n`, '9074fd75fb72f9'],
  // LOOP / JCXZ
  [`L1:	NOP\n	LOOP	L1\n	JCXZ	L1\n`, '90e2fde3fb'],
  // CALL / RET (near direct)
  [`	CALL	FOO\nFOO:	RET\n`, 'e80000c3'],
  // JMPS / JP (short)
  [`L1:	NOP\n	JMPS	L1\n	JP	L1\n`, '90ebfdebfb'],
  // SEG override
  [`	SEG	ES\n	MOV	AL,[BX]\n`, '268a07'],
  // REP STOSW
  [`	REP\n	STOW\n`, 'f3ab'],
  // XCHG AX, reg
  [`	XCHG	AX,DX\n	XCHG	AX,BP\n`, '92' + '95'],
  // LEA
  [`	LEA	AX,[BX+10]\n`, '8d470a'],
  // shift
  [`	SHL	AX,1\n	SHR	BL,CL\n`, 'd1e0' + 'd2eb'],
  // forward-ref label (DW)
  [`	ORG 0\n	DW	END\n	NOP\nEND:\n`, '030090'],
  // EQU and IF
  [`F: EQU 0\n	IF	F\n	NOP\n	ENDIF\n	RET\n`, 'c3'],
  [`F: EQU 1\n	IF	F\n	NOP\n	ENDIF\n	RET\n`, '90c3'],
];

let pass = 0, fail = 0;
for (const [src, expect] of cases) {
  try {
    const r = assemble(src);
    const got = H(r.bytes);
    if (got === expect) { pass++; }
    else {
      fail++;
      console.error('FAIL', JSON.stringify(src));
      console.error('  expected:', expect);
      console.error('  got:     ', got);
    }
  } catch (e) {
    fail++;
    console.error('FAIL (threw)', JSON.stringify(src));
    console.error(' ', e.message);
  }
}
console.log(`scpasm smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
