#!/usr/bin/env node
// The runtime manifest owns the supported host floor; automation must not carry
// an independent DSH pin that can drift behind the package it is testing.
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

export function hostVersion(manifest = JSON.parse(readFileSync(resolve(root, 'packages/dsh-web-all/package.json'), 'utf8'))) {
  const match = /^>=(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(manifest.dsh?.engines?.dsh || '')
  if (!match) throw new Error('runtime dsh.engines.dsh must declare one explicit >= host version')
  return match[1]
}

export function compareVersions(a, b) {
  const left = versionPattern.exec(a)
  const right = versionPattern.exec(b)
  if (!left || !right) throw new Error('invalid DSH version')
  for (let i = 1; i <= 3; i++) {
    const delta = Number(left[i]) - Number(right[i])
    if (delta) return Math.sign(delta)
  }
  if (left[4] === right[4]) return 0
  if (!left[4]) return 1
  if (!right[4]) return -1
  const x = left[4].split('.')
  const y = right[4].split('.')
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === y[i]) continue
    if (x[i] === undefined) return -1
    if (y[i] === undefined) return 1
    const xn = /^\d+$/.test(x[i])
    const yn = /^\d+$/.test(y[i])
    if (xn && yn) return Math.sign(Number(x[i]) - Number(y[i]))
    if (xn !== yn) return xn ? -1 : 1
    return x[i] < y[i] ? -1 : 1
  }
  return 0
}

export function assertHostVersion(output, minimum = hostVersion()) {
  // Official installed `dsh --version` emits one bare version line. Accept an
  // explicit dsh prefix too, never an unrelated wrapper/warning's first semver.
  const actual = String(output).trim().match(/^(?:dsh )?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/)?.[1]
  if (!actual || compareVersions(actual, minimum) < 0) {
    throw new Error(`DSH host ${actual || '(unknown)'} does not satisfy >=${minimum}`)
  }
  return actual
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--check') assertHostVersion(process.argv[3])
    else console.log(hostVersion())
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
