# dos10 — open-source DOS in the browser

Build [86-DOS 1.00](https://github.com/DOS-History/Paterson-Listings) (the genuine ancestor of MS-DOS 1.0, the source of which Microsoft released April 28, 2026) from source, with a JS-native re-implementation of Tim Paterson's SCP 8086 Assembler, and run it in a browser-based 8086 emulator.

## Upstream sources (gitignored — fetch with `scripts/fetch-sources.sh`)

- [DOS-History/Paterson-Listings](https://github.com/DOS-History/Paterson-Listings) — 86-DOS 1.00 source, PC-DOS 1.00 dev snapshots, SCP ASM 2.43 source. Released by Microsoft 2026-04-28, MIT-licensed.
- [microsoft/MS-DOS](https://github.com/microsoft/MS-DOS) — v1.25 / 2.0 source for cross-reference. MIT.

## Layout

- `tools/scpasm.js` — JS implementation of the SCP ASM 2.43 dialect.
- `tools/core/` — 8086 CPU + memory + IMD disk + nine-vector SCP BIOS shim
  (`STAT/IN/OUT/PRINT/AUXIN/AUXOUT/READ/WRITE/DSKCHG`).
- `test/boot_smoke.js` — Node harness; boots the disk image headlessly and
  asserts COMMAND.COM reaches its date prompt.
- `web/` — browser shell. `index.html` + `main.js` wire the CPU+BIOS to a
  canvas-backed glass-TTY (`glass_tty.js`) modeling an SCP-era serial VDU
  (80×24, BS/HT/LF/FF/CR/BEL, blinking block cursor).
- `assets/86dos114-tarbell-dd.imd` — 86-DOS 1.14 disk image (Tarbell DD).
- `build/` — generated binaries (gitignored).
- `scripts/fetch-sources.sh` — clones the upstream repos into `paterson/`
  and `msdos-src/`.

## Build / run

```
npm run build:asm    # ASM_2.43.ASM  -> build/ASM.COM       (self-host check)
npm run build:dos    # 86DOS.ASM     -> build/MSDOS.BIN
npm run boot:smoke   # node test/boot_smoke.js              (headless boot)
npm run web          # python3 -m http.server 8000          (open /web/)
```

The web shell currently boots the on-disk 86-DOS 1.14 image directly
(loader + BIOS read off cyl 0–1; INT 0xE0+idx trampolines patched over
the nine BIOS entry points), not the freshly-assembled `MSDOS.BIN` —
that's the next milestone.

## Hardware target

Seattle Computer Products S-100 8086 system: serial console, 8" floppy.
No video card, no IBM-PC BIOS — that's why the BIOS shim is nine
character/disk vectors and the terminal is a glass-TTY rather than a
framebuffer. PC-DOS 1.0 was Microsoft's port of this code to the IBM PC
hardware in 1981.

## Status

Boots to `COMMAND v. 1.10` date prompt; line input works. Disk writes,
file commands, and assemble-then-boot loop are TODO. See git log.
