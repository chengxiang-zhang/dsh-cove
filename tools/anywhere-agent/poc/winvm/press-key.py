#!/usr/bin/env python3
"""Answer the installer's own boot prompt.

A Windows ISO prints "Press any key to boot from CD or DVD" and, if nobody answers within
a few seconds, falls through to network boot. There is no key on a headless run, so the
keypress goes in over the QEMU monitor socket while the prompt is up.
"""
import socket
import sys
import time

MONITOR = "mon.sock"
WINDOW_SECONDS = 60
INTERVAL = 2


def press(monitor_path, timeout=2.0):
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(timeout)
    client.connect(monitor_path)
    time.sleep(0.2)
    try:
        client.recv(65536)
    except socket.timeout:
        pass
    client.sendall(b"sendkey spc\n")
    time.sleep(0.2)
    try:
        client.recv(65536)
    except socket.timeout:
        pass
    client.close()


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else MONITOR
    deadline = time.time() + WINDOW_SECONDS
    presses = 0
    while time.time() < deadline:
        try:
            press(path)
            presses += 1
        except (FileNotFoundError, ConnectionRefusedError):
            # QEMU creates the socket a moment after it is started; giving up here is how
            # a run ends with nobody answering the installer's boot prompt.
            time.sleep(INTERVAL)
            continue
        time.sleep(INTERVAL)
    print(f"sent {presses} keypresses to {path}")
    return 0 if presses else 1


if __name__ == "__main__":
    sys.exit(main())