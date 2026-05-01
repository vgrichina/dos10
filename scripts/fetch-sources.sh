#!/usr/bin/env bash
# Fetch upstream open-source DOS materials. Both repos are MIT-licensed.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -d paterson ]]; then
  git clone --depth 1 https://github.com/DOS-History/Paterson-Listings.git paterson
fi

if [[ ! -d msdos-src ]]; then
  git clone --depth 1 https://github.com/microsoft/MS-DOS.git msdos-src
fi

echo "Sources ready:"
echo "  paterson/3_source_code/86-DOS_1.00/86DOS.ASM      ($(wc -l < paterson/3_source_code/86-DOS_1.00/86DOS.ASM) lines)"
echo "  paterson/3_source_code/SCP_ASM/ASM_2.43.ASM       ($(wc -l < paterson/3_source_code/SCP_ASM/ASM_2.43.ASM) lines)"
