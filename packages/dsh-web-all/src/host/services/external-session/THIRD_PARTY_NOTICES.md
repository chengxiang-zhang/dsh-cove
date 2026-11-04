# Third-party notices: external-session service domain

This service domain implements its own external CLI session model. Two MIT-licensed
upstream packages were read while writing it, and the root `NOTICE` registers that reading.

## Referenced works

- `@deepseek-ai/dsh-subagent-claude-code` 0.2.1-rc.5 — MIT, DeepSeek.
  Installed under `~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-subagent-claude-code`.
- `@deepseek-ai/dsh-subagent-codex` 0.2.1-rc.5 — MIT, DeepSeek.
  Installed under `~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-subagent-codex`.

## What was taken, and what was not

Referenced, not copied: the shape of the Claude Code `stream-json` event frames and the
position of `session_id`, `usage` and `total_cost_usd` within them; the argument order the
CLI is launched with; and the practice of classifying a `Not logged in` message as a
credential failure rather than a task failure.

Not taken: no file, function or module of either package is reproduced here. The adapters in
`providers/` own their own process lifecycle, event decoding, error mapping and cancellation
handling, because the upstream providers are one-shot by construction and this capability is
built around a resumable session instead. Nothing under this directory is derived code
requiring the upstream license to be carried in the source tree.

## License text

```
MIT License

Copyright (c) 2025 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```