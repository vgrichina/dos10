# dos10 — open-source DOS in the browser

Build [86-DOS 1.00](https://github.com/DOS-History/Paterson-Listings) (the genuine ancestor of MS-DOS 1.0, the source of which Microsoft released April 28, 2026) from source, with a JS-native re-implementation of Tim Paterson's SCP 8086 Assembler, and run it in a browser-based 8086 emulator.

## Layout

- `paterson/` — vendored Paterson-Listings repo (86-DOS 1.00, PC-DOS 1.00 dev, SCP ASM source).
- `msdos-src/` — vendored microsoft/MS-DOS repo (v1.25 source for cross-reference).
- `tools/scpasm.js` — JS implementation of SCP ASM 2.43 dialect.
- `tools/core/` — 8086 CPU + memory + minimal SCP BIOS for runtime (ported from neighboring 8086-mph-demo, cycle counters stripped).
- `web/` — browser shell.
- `build/` — generated binaries (gitignored).

## Build flow

```
86DOS.ASM  --(scpasm.js)-->  build/MSDOS.BIN
ASM_2.43.ASM --(scpasm.js)-->  build/ASM.COM   # self-host validation
```

Then `web/main.js` loads `MSDOS.BIN` into the emulator and boots it.

## Status

Work in progress. See git log.
