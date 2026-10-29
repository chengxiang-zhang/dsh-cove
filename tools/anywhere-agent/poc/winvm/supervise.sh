#!/bin/sh
# Keep the guest installed across the reboots Windows Setup performs, and stop as soon as
# the acceptance script has reported.
#
# Setup boots from the CD first (and asks for a keypress, which a headless run has to
# supply over the monitor), then restarts into the disk to finish. Without this loop a
# guest that reboots either stops (a QEMU started with -no-reboot exits) or starts the
# installation again from the CD.
cd "$(dirname "$0")"

attempt=0
while [ "$attempt" -lt 8 ]; do
  attempt=$((attempt + 1))

  if ! pgrep -f "^qemu-system" > /dev/null; then
    if [ "$attempt" -eq 1 ]; then ORDER=d; else ORDER=c; fi
    echo "starting the guest (attempt $attempt, boot order $ORDER)"
    BOOT_ORDER=$ORDER sh run-vm.sh
    if [ "$ORDER" = "d" ]; then
      # The Windows ISO prints "Press any key to boot from CD or DVD" and falls through to
      # network boot when nobody answers; the monitor socket answers for us.
      python3 press-key.py || true
    fi
  fi

  i=0
  while [ "$i" -lt 400 ]; do
    i=$((i + 1))
    if grep -q "AW-TEST: ALL-RESULTS" serial.log 2>/dev/null; then
      grep "AW-TEST:" serial.log > aw-test.txt
      echo "verdict reached on attempt $attempt"
      exit 0
    fi
    pgrep -f "^qemu-system" > /dev/null || break
    sleep 15
  done

  [ -f win11.qcow2 ] || break
done

echo "supervisor gave up after $attempt attempts"