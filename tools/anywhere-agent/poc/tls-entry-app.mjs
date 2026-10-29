/**
 * The page probe behind `poc/tls-entry.mjs`.
 *
 * It is one Electron window that trusts exactly the fleet CA - the same runtime the
 * packaged app ships - and one reading of what the browser exposes to the page it
 * loaded. The certificate hook stands in for the trust store: on a real client the
 * CA is installed in the keychain (README.md, "TLS entry") and Chromium validates
 * the leaf itself, so the hook is harness only, never product code.
 *
 *   Electron tls-entry-app.mjs --ca <ca.crt> --url <entry url>
 *   FACTS {"origin":...,"isSecureContext":...,"mediaDevices":...}
 */
import { app, BrowserWindow, session } from 'electron'
import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'

function flag(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? '' : String(process.argv[index + 1] ?? '')
}

const caPath = flag('--ca')
const url = flag('--url')
const host = new URL(url).hostname
const ca = new X509Certificate(readFileSync(caPath))

/** The facts the voice-input plugin's own precondition is written in terms of. */
const READING = `({
  origin: location.origin,
  isSecureContext: window.isSecureContext,
  mediaDevices: typeof navigator.mediaDevices,
  MediaRecorder: typeof MediaRecorder,
  getUserMedia: typeof (navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
  protocol: location.protocol,
})`

app.whenReady().then(async () => {
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    let trusted = false
    try {
      const leaf = new X509Certificate(Buffer.from(request.certificate.data))
      trusted = request.hostname === host && leaf.checkIssued(ca) && leaf.verify(ca.publicKey)
    } catch {
      trusted = false
    }
    callback(trusted ? 0 : -2)
  })

  const win = new BrowserWindow({ show: false, width: 1200, height: 800 })
  try {
    await win.loadURL(url)
    const facts = await win.webContents.executeJavaScript(READING)
    process.stdout.write(`FACTS ${JSON.stringify(facts)}\n`)
  } catch (error) {
    process.stdout.write(`FACTS_ERROR ${String(error?.message ?? error)}\n`)
  }
  app.exit(0)
})