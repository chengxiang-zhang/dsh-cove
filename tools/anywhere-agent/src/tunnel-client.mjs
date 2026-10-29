/**
 * Client for the tunnel helper's JSON-lines protocol.
 *
 * The helper owns the overlay engine; this owns the conversation with it. Every
 * response is matched to its request id, and a helper that dies or answers
 * nothing fails the pending request instead of hanging the agent.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** Thrown when the helper answers with ok:false. */
export class TunnelError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TunnelError';
  }
}

export class TunnelClient {
  /**
   * @param {{ binary: string, env?: Record<string, string>, requestTimeoutMs?: number, stopTimeoutMs?: number, onStderr?: (line: string) => void, onExit?: (info: { code: number|null, signal: string|null }) => void }} options
   */
  constructor(options) {
    this.binary = options.binary;
    this.env = options.env ?? {};
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    /**
     * How long the engine gets to acknowledge a stop.
     *
     * Shorter than every other command on purpose: the process is terminated right after
     * the acknowledgement times out, and an engine that is mid-sign-in has no reason to
     * answer quickly. Waiting the full request timeout here is what made "暂不登录" look
     * like a button that does nothing.
     */
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
    this.onStderr = options.onStderr ?? (() => {});
    /**
     * Called when the helper exits without being asked to.
     *
     * A helper that dies takes the whole overlay with it, and the supervisor's last
     * snapshot still says "connected": without this the window keeps claiming a network
     * it no longer has, and every request fails against a process that is gone.
     */
    this.onExit = options.onExit ?? (() => {});
    /** Set while this client is stopping a helper on purpose, so its exit is not a crash. */
    this.expectedExit = false;
    this.nextId = 1;
    this.pending = new Map();
    this.child = null;
  }

  start() {
    if (this.child) {
      return;
    }
    this.expectedExit = false;
    this.child = spawn(this.binary, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.env },
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => this.handleLine(line));
    createInterface({ input: this.child.stderr }).on('line', (line) => this.onStderr(line));
    this.child.on('exit', (code, signal) => {
      const reason = `helper exited (code=${code}, signal=${signal})`;
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new TunnelError(reason));
      }
      this.pending.clear();
      this.child = null;
      const expected = this.expectedExit;
      this.expectedExit = false;
      if (!expected) {
        // Reported after the bookkeeping: the handler may restart this client, and it
        // must see a client with no child rather than one that pretends to have it.
        this.onExit({ code: code ?? null, signal: signal ?? null });
      }
    });
  }

  handleLine(line) {
    const trimmed = line.trim();
    if (trimmed === '') {
      return;
    }
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      this.onStderr(`unparsable helper line: ${trimmed.slice(0, 200)}`);
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) {
      entry.resolve(message.result);
    } else {
      entry.reject(new TunnelError(String(message.error ?? 'helper reported failure')));
    }
  }

  /**
   * Sends one command and resolves with its result.
   *
   * @param {string} cmd
   * @param {Record<string, unknown>} [fields]
   * @param {number} [timeoutMs] a deadline of its own, for commands whose answer is optional
   * @returns {Promise<unknown>}
   */
  request(cmd, fields = {}, timeoutMs = this.requestTimeoutMs) {
    if (!this.child) {
      return Promise.reject(new TunnelError('helper is not running'));
    }
    const id = this.nextId;
    this.nextId += 1;
    const payload = { id, cmd, ...fields };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TunnelError(`helper timed out on ${cmd}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  /** Engine build identity: protocol, helper, netbird, embedded dependencies. */
  version() {
    return this.request('version');
  }

  /** Asks the helper to stop, and terminates it whatever the answer.
   *
   * The acknowledgement is optional: a helper that is mid-sign-in may never reply, and the
   * caller - the window the user just left - must not be held by it. The short deadline is
   * what keeps a restart from running two engines at once.
   */
  stop() {
    if (!this.child) {
      return Promise.resolve();
    }
    // This exit is the answer to a request, not a crash: the caller is stopping the
    // engine on purpose (app quit, the user turning the network off, a fresh engine for a
    // hand-off), so it must not trigger the crash handler that restarts it.
    this.expectedExit = true;
    const child = this.child;
    // The exit event is what clears `child`, and a restart must not spawn the replacement
    // before that happened: `start()` would see a child that is already dead and skip it.
    const gone = new Promise((resolve) => child.once('close', resolve));
    return this.request('stop', {}, this.stopTimeoutMs)
      .catch(() => undefined)
      .then(() => {
        child.stdin.end();
        child.kill('SIGTERM');
      })
      .then(() => Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 3_000))]));
  }

  /**
   * Replaces the helper process with a fresh one.
   *
   * The engine holds things a process owns and cannot hand back: the sign-in callback
   * listener binds one port for the whole life of the process, so once a hand-off has been
   * issued, every later one fails with "no available port" until the engine is gone. A
   * person who did not finish a sign-in therefore gets a button that works again, because
   * the only way to give the port back is to start over.
   *
   * @returns {Promise<void>}
   */
  async restart() {
    await this.stop();
    this.start();
  }
}