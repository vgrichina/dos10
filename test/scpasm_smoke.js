// Smoke test: lexer + expression eval + a few stub instructions.
// Run with: node test/scpasm_smoke.js
import { assemble } from '../tools/scpasm.js';

const cases = [
  // [source, expectedHexBytes, expectedBaseOrNull]
  [`	NOP\n	NOP\n	RET\n`, '9090c3', 0],
  [`	INT	33\n`, 'cd21', 0],
  [`	INT	3\n`, 'cc', 0],
  [`	LODB\n	STOW\n`, 'acab', 0],
  // ORG affects $; DB writes string + numeric.
  [`	ORG	100H\nMSG:	DB	'Hi',13,10,'$'\n`, '48690d0a24', null],
  // EQU + IF/ENDIF skipping.
  [`FLAG: EQU 0\n	IF FLAG\n	NOP\n	ENDIF\n	RET\n`, 'c3', 0],
  [`FLAG: EQU 1\n	IF FLAG\n	NOP\n	ENDIF\n	RET\n`, '90c3', 0],
  // Forward reference to label resolves in pass 2.
  [`	ORG 0\n	DW	FOO\n	NOP\nFOO:\n`, '030090', 0], // 03 00 = addr of FOO (after DW + NOP), then NOP, label at end emits nothing
  // PUT sets load base.
  [`	PUT	100H\n	NOP\n`, '90', 0x100],
];

let pass = 0, fail = 0;
for (const [src, expectPrefix, expectBase] of cases) {
  try {
    const r = assemble(src);
    const hex = Array.from(r.bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    const ok = hex.startsWith(expectPrefix) && (expectBase === null || r.base === expectBase);
    if (ok) { pass++; }
    else {
      fail++;
      console.error('FAIL', JSON.stringify(src));
      console.error('  expected bytes prefix:', expectPrefix, 'base:', expectBase);
      console.error('  got bytes:           ', hex,           'base:', r.base);
    }
  } catch (e) {
    fail++;
    console.error('FAIL (threw)', JSON.stringify(src));
    console.error(' ', e.message);
  }
}
console.log(`scpasm smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
