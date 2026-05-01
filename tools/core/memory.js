// 1 MB real-mode address space. Browser-safe.
//
// Optional `accessHook` lets higher layers charge cycle penalties on specific
// address ranges — today used only for the CGA B8000 bus-stall model.
// The hook returns CPU cycles to add to `stall.acc`; callers (e.g. cpu.step)
// read and clear the accumulator between instructions.

export const MEM_SIZE = 1 << 20; // 1 MiB

export function createMemory(size = MEM_SIZE) {
  const buf = new Uint8Array(size);
  let accessHook = null;
  const stall = { acc: 0 };
  const hit = (seg, off, sz, w) => {
    if (!accessHook) return;
    const lin = ((seg << 4) + off) & 0xFFFFF;
    if (lin >= 0xB8000 && lin < 0xC0000) {
      stall.acc += accessHook(seg, off, sz, w) | 0;
    }
  };
  return {
    buf,
    size,
    stall,
    setAccessHook(fn) { accessHook = fn; },
    linear(seg, off) { return ((seg << 4) + off) & 0xFFFFF; },
    read8 (seg, off) { hit(seg, off, 1, false); return buf[((seg << 4) + off) & 0xFFFFF]; },
    read16(seg, off) {
      hit(seg, off, 2, false);
      const a = ((seg << 4) + off) & 0xFFFFF;
      return buf[a] | (buf[(a + 1) & 0xFFFFF] << 8);
    },
    write8 (seg, off, v) { hit(seg, off, 1, true); buf[((seg << 4) + off) & 0xFFFFF] = v & 0xFF; },
    write16(seg, off, v) {
      hit(seg, off, 2, true);
      const a = ((seg << 4) + off) & 0xFFFFF;
      buf[a] = v & 0xFF;
      buf[(a + 1) & 0xFFFFF] = (v >> 8) & 0xFF;
    },
    load(seg, off, bytes) {
      const a = ((seg << 4) + off) & 0xFFFFF;
      for (let i = 0; i < bytes.length; i++) buf[(a + i) & 0xFFFFF] = bytes[i];
    },
  };
}
