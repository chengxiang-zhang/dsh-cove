#!/bin/sh
# Boot the unattended Windows guest headless.
#
# The console is a serial file and the monitor is a socket, so the verdict and a desktop
# screenshot are both readable from the host. Nothing here touches the machine the guest
# runs on beyond the files in this directory.
#
# BOOT_ORDER controls the firmware's order: `d` (the default) boots the installer's CD,
# which Windows asks a keypress for; `c` boots the disk, which is what continues the
# installation after setup's own reboots.
set -e
cd "$(dirname "$0")"

[ -f win11.iso ] || { echo "no win11.iso yet (see README.md step 1)"; exit 1; }
[ -f aw-unattend.iso ] || { echo "no aw-unattend.iso yet (see README.md step 3)"; exit 1; }
[ -f OVMF_VARS.fd ] || cp /usr/share/OVMF/OVMF_VARS_4M.fd OVMF_VARS.fd
[ -f win11.qcow2 ] || qemu-img create -f qcow2 win11.qcow2 60G > /dev/null

rm -f serial.log mon.sock qemu.out
setsid nohup qemu-system-x86_64 \
  -enable-kvm -M pc -cpu host -m 8192 -smp 8 -boot order="${BOOT_ORDER:-d}" \
  -drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd \
  -drive if=pflash,format=raw,file=./OVMF_VARS.fd \
  -drive file=win11.qcow2,format=qcow2,if=ide,index=0,media=disk \
  -drive file=win11.iso,media=cdrom,readonly=on \
  -drive file=aw-unattend.iso,media=cdrom,readonly=on \
  -vga std -display none \
  -serial file:serial.log \
  -monitor unix:mon.sock,server,nowait \
  > qemu.out 2>&1 < /dev/null &
echo "qemu started: $!"