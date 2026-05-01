// Build driver: assemble a SCP-dialect .ASM file to a flat binary.
// Usage: node tools/build.js <input.asm> <output.bin>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { assemble } from './scpasm.js';

const [,, inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: node tools/build.js <input.asm> <output.bin>');
  process.exit(2);
}
const src = readFileSync(inPath, 'utf8');
const { bytes, base, symbols } = assemble(src);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, bytes);
console.error(`assembled ${inPath} -> ${outPath}`);
console.error(`  ${bytes.length} bytes, base = 0x${base.toString(16)}, ${symbols.size} symbols`);
