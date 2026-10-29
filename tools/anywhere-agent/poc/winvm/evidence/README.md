# Windows acceptance evidence (2026-10-23)

Two runs of `../aw-test.ps1` on Windows 11 (10.0.26100) in the KVM guest described in
`../README.md`, against installers built from the repository at commit counts 83 and 86.

| File | What it is |
| --- | --- |
| `installing-windows.png` | The guest mid-install ("Installing Windows 11 - 19% complete"), taken from QEMU's monitor socket. |
| `desktop-during-app-launch.png` | The desktop while the acceptance script had the app open: the console carries the app's own stderr (`shell: packaged=true defaultApp=undefined argv=[]`, `shell: update none (no update channel configured)`), so what is running is the product and not a stub. The app's window sits behind that console, and the window itself is asserted by the transcript: `app pid=8184 alive=True window="Anywhere Work"`. |

The transcripts are not files here because they are the guest's serial output; the
acceptance script writes every line to COM1 and the harness keeps `serial.log` next to
the VM. The second run ended with:

```
AW-TEST: RESULT PASS every assertion held
```
