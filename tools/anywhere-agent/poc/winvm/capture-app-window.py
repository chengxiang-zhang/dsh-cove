#!/usr/bin/env python3
"""Capture the guest's desktop while the acceptance script has the app open.

The acceptance script starts the app, waits 25 seconds and checks the window title; that
window is also the visual half of the evidence, and it only exists for those seconds. This
watches the serial transcript for the moment the app is launched and takes a screenshot
then, so the picture is of the real window rather than of a desktop that happens to be
running.
"""
import socket
import sys
import time

MONITOR = "mon.sock"
TRANSCRIPT = "serial.log"
MARKER = "app pid="
SETTLE_SECONDS = 8


def dismiss_overlays(monitor_path):
    """Clear whatever is on top of the window this is meant to show.

    A fresh unattended Windows can leave the Start menu open, and Escape only reaches the
    focused window - which is the console running the acceptance script, not the menu. The
    Windows key toggles it, so it is pressed and then Escape is sent for anything else.
    """
    try:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(5)
        client.connect(monitor_path)
        time.sleep(0.2)
        client.recv(65536)
        for keys in (b"sendkey meta_l\n", b"sendkey esc\n"):
            client.sendall(keys)
            time.sleep(1.0)
            try:
                client.recv(65536)
            except socket.timeout:
                pass
        client.close()
    except (FileNotFoundError, ConnectionRefusedError, socket.timeout):
        pass


def screendump(monitor_path, out_path):
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(5)
    client.connect(monitor_path)
    time.sleep(0.3)
    client.recv(65536)
    client.sendall(f"screendump {out_path}\n".encode())
    time.sleep(3)
    try:
        client.recv(65536)
    except socket.timeout:
        pass
    client.close()


def main():
    output = sys.argv[1] if len(sys.argv) > 1 else "app-window.ppm"
    budget = int(sys.argv[2]) if len(sys.argv) > 2 else 2400
    deadline = time.time() + budget

    while time.time() < deadline:
        try:
            with open(TRANSCRIPT, errors="replace") as handle:
                text = handle.read()
        except FileNotFoundError:
            text = ""
        if MARKER in text:
            time.sleep(SETTLE_SECONDS)
            dismiss_overlays(MONITOR)
            time.sleep(1)
            screendump(MONITOR, output)
            print(f"captured {output} while the app was starting")
            return 0
        time.sleep(2)

    print("no app launch appeared within the window", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())