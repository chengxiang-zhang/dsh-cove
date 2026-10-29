#!/usr/bin/env node
/**
 * Per-employee namespace for the self-hosted NetBird account.
 *
 * The account is single-tenant (NetBird self-hosted has no multi-tenancy), so
 * "each employee only reaches their own machines" is expressed as one private
 * group per user plus one self-referencing policy per group:
 *
 *   1. group   `u-<username>`  - the member's own namespace.
 *   2. user    `auto_groups`   - carries that group; with user group
 *                                propagation enabled every peer the user owns
 *                                inherits it automatically.
 *   3. policy  `self-<username>` - sources = destinations = that group, so the
 *                                member reaches their own machines and nothing
 *                                else (NetBird denies by default).
 *   4. DNS     the member's group joins the fleet zone's distribution, so
 *                                `dsh.<machine>.netbird` resolves on that
 *                                member's machines. Without it the member
 *                                cannot open their own machine's entry at all:
 *                                measured on 2026-10-14, a peer in a `u-` group
 *                                gets NXDOMAIN for `dsh.<machine>.netbird`
 *                                until its group is a distribution group.
 *
 * Everything else in the account is reached through the `ops` group, which is
 * deliberately NOT granted by this script.
 *
 * A zone is distributed as a whole, so a member that needs the fleet's DSH
 * names also receives the zone's other names. Those targets stay unreachable
 * (no policy names the member group), but the names become visible; pass
 * `--no-zone-access` when that trade is not wanted, or narrow the zone as
 * described in `tools/dsh-netbird/netbird-management.md`.
 *
 * The default run is a dry-run that prints the plan. `--apply` performs it.
 * The token comes from `NETBIRD_MGMT_TOKEN` or `~/.dsh/netbird-mgmt-token` and
 * is never printed.
 *
 *   node scripts/dsh-netbird-user-namespace.mjs [--apply] [--only <name>]
 *        [--include-pending] [--include-admins] [--no-zone-access]
 *        [--revoke-zone-access] [--json]
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULT_MANAGEMENT_URL = 'https://netbird.example.com'
export const USER_GROUP_PREFIX = 'u-'
export const USER_POLICY_PREFIX = 'self-'
export const OPS_GROUP_NAME = 'ops'
export const OPS_POLICY_PREFIX = 'ops-manage-'
export const INVENTORY_PATH = new URL('../tools/dsh-netbird/machines.json', import.meta.url)

/**
 * The shared zone that carries the fleet's `dsh.<machine>` records: the
 * `domainPattern` in the machine inventory minus the machine placeholder. One
 * source of truth, so a rename cannot leave this script pointing at a retired
 * zone.
 */
export function fleetZoneFromPattern(pattern) {
  const placeholder = '<netbird-machine-name>'
  if (typeof pattern !== 'string' || !pattern.includes(placeholder)) {
    throw new Error(`domainPattern must contain ${placeholder}`)
  }
  const zone = pattern.slice(pattern.lastIndexOf(placeholder) + placeholder.length)
  return zone.startsWith('.') ? zone.slice(1) : zone
}

/** Reads the zone name out of the machine inventory used by the fleet tools. */
export async function readFleetZone(inventoryPath = INVENTORY_PATH) {
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'))
  return fleetZoneFromPattern(inventory.domainPattern)
}

/** Users that own machines and therefore need a namespace. */
export function isNamespaceUser(user, { includePending = false, includeAdmins = false } = {}) {
  if (!user || !user.name) return false
  if (user.is_service_user) return false
  if (!includeAdmins && user.role !== 'user') return false
  if (!includePending && (user.status === 'blocked' || user.pending_approval)) return false
  return true
}

/** Usernames may not carry characters that would make group names ambiguous. */
export function namespaceNames(user) {
  const slug = String(user.name).trim().toLowerCase()
  return { group: `${USER_GROUP_PREFIX}${slug}`, policy: `${USER_POLICY_PREFIX}${slug}` }
}

/**
 * Pure planner: turns the live account state into the list of writes needed to
 * give every namespace user a private group and a self policy. Idempotent, so a
 * repeated run over the resulting state yields no actions.
 */
export function planNamespaces({ users = [], groups = [], policies = [], zones = [], fleetZone = null, groupsPropagationEnabled = true, includePending = false, includeAdmins = false, only = null, withOpsAccess = false, revokeOpsAccess = false, zoneAccess = true, revokeZoneAccess = false } = {}) {
  const groupByName = new Map(groups.map((group) => [group.name, group]))
  const policyByName = new Map(policies.map((policy) => [policy.name, policy]))
  const opsGroup = groupByName.get(OPS_GROUP_NAME)
  const zone = fleetZone ? zones.find((candidate) => candidate.domain === fleetZone) : null
  const zoneGroups = new Set(zone?.distribution_groups ?? [])
  /** A revoke pass only ever removes access; it never hands out what it is undoing. */
  const grantZoneAccess = zoneAccess && !revokeZoneAccess
  const actions = []
  const usersOut = []

  for (const user of users) {
    if (only && user.name !== only) continue
    if (!isNamespaceUser(user, { includePending, includeAdmins })) continue
    const { group: groupName, policy: policyName } = namespaceNames(user)
    const group = groupByName.get(groupName)
    const autoGroups = Array.isArray(user.auto_groups) ? user.auto_groups : []
    const hasGroup = Boolean(group)
    const hasMembership = hasGroup && autoGroups.includes(group.id)
    const policy = policyByName.get(policyName)
    const groupId = group ? group.id : `pending:${groupName}`

    const steps = []
    if (!hasGroup) steps.push({ kind: 'create-group', group: groupName })
    if (!hasMembership) steps.push({ kind: 'assign-group', user: user.name, group: groupName, autoGroups: [...autoGroups, groupName] })
    if (!policy) {
      steps.push({ kind: 'create-policy', policy: policyName, group: groupName })
    } else if (!policyMatchesSelf(policy, groupId)) {
      steps.push({ kind: 'fix-policy', policy: policyName, group: groupName })
    }
    if (grantZoneAccess && zone && group && !zoneGroups.has(group.id)) {
      steps.push({ kind: 'distribute-zone', zone: zone.domain, zoneId: zone.id, group: groupName, groupId: group.id })
      zoneGroups.add(group.id)
    }
    for (const step of steps) actions.push(step)
    usersOut.push({ user: user.name, group: groupName, policy: policyName, upToDate: steps.length === 0, steps: steps.map((step) => step.kind) })
    if (withOpsAccess && opsGroup && group) {
      const opsPolicyName = `${OPS_POLICY_PREFIX}${groupName.slice(USER_GROUP_PREFIX.length)}`
      if (!policyByName.has(opsPolicyName)) actions.push({ kind: 'create-ops-policy', policy: opsPolicyName, group: groupName })
    }
  }

  if (revokeOpsAccess) {
    for (const policy of policies) {
      if (policy.name.startsWith(OPS_POLICY_PREFIX)) actions.push({ kind: 'delete-ops-policy', policy: policy.name, id: policy.id })
    }
  }

  if (revokeZoneAccess && zone) {
    for (const groupId of zone.distribution_groups ?? []) {
      const member = groups.find((candidate) => candidate.id === groupId)
      if (member && member.name.startsWith(USER_GROUP_PREFIX)) {
        actions.push({ kind: 'undistribute-zone', zone: zone.domain, zoneId: zone.id, group: member.name, groupId: member.id })
      }
    }
  }

  const warnings = []
  if (!groupsPropagationEnabled) {
    warnings.push('user group propagation is disabled: assigning auto_groups will not reach the machines already registered by that user')
  }
  if (grantZoneAccess && !zone) {
    warnings.push(`no DNS zone with domain ${fleetZone ?? '(unset)'} found: the members cannot resolve the fleet's dsh.<machine> entry by name`)
  }
  if (grantZoneAccess && zone) {
    warnings.push(`DNS access hands members every name in zone "${zone.domain}" (unreachable, but listed); machines already connected need netbird down && netbird up to receive it`)
  }
  if (revokeZoneAccess && !zone) {
    warnings.push(`no DNS zone with domain ${fleetZone ?? '(unset)'} found: nothing to revoke`)
  }
  if (withOpsAccess && !opsGroup) warnings.push(`no "${OPS_GROUP_NAME}" group found: IT access policies were not planned`)
  if (withOpsAccess && opsGroup) {
    warnings.push(`IT access exposes every "${OPS_GROUP_NAME}" machine to that member's client (unreachable, but listed); it is off unless --with-ops-access is passed`)
  }

  return { actions, users: usersOut, groupsPropagationEnabled, warning: warnings.length ? warnings.join('; ') : null }
}

/** A self policy accepts its own group as both source and destination. */
export function policyMatchesSelf(policy, groupId) {
  const rules = Array.isArray(policy.rules) ? policy.rules : []
  return rules.some((rule) => {
    if (!rule.enabled) return false
    if (rule.action !== 'accept') return false
    if (!rule.bidirectional) return false
    const sources = (rule.sources ?? []).map((entry) => (typeof entry === 'string' ? entry : entry.id))
    const destinations = (rule.destinations ?? []).map((entry) => (typeof entry === 'string' ? entry : entry.id))
    return sources.length === 1 && destinations.length === 1 && sources[0] === groupId && destinations[0] === groupId
  })
}

export function parseArgs(argv) {
  const options = { apply: false, includePending: false, includeAdmins: false, only: null, json: false, help: false, withOpsAccess: false, revokeOpsAccess: false, zoneAccess: true, revokeZoneAccess: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') options.apply = true
    else if (arg === '--include-pending') options.includePending = true
    else if (arg === '--include-admins') options.includeAdmins = true
    else if (arg === '--json') options.json = true
    else if (arg === '--with-ops-access') options.withOpsAccess = true
    else if (arg === '--revoke-ops-access') options.revokeOpsAccess = true
    else if (arg === '--no-zone-access') options.zoneAccess = false
    else if (arg === '--revoke-zone-access') options.revokeZoneAccess = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--only') options.only = argv[++index] ?? null
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

async function resolveToken() {
  const fromEnv = process.env.NETBIRD_MGMT_TOKEN
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  return (await readFile(join(homedir(), '.dsh', 'netbird-mgmt-token'), 'utf8')).trim()
}

/** Minimal management API client; never logs the token. */
export function createClient({ baseUrl, token, fetchImpl = fetch }) {
  const root = `${baseUrl.replace(/\/$/, '')}/api`
  const call = async (method, path, body) => {
    const response = await fetchImpl(`${root}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 200)}`)
    return text ? JSON.parse(text) : null
  }
  return {
    listUsers: () => call('GET', '/users'),
    listGroups: () => call('GET', '/groups'),
    listPolicies: () => call('GET', '/policies'),
    listZones: () => call('GET', '/dns/zones'),
    getAccount: () => call('GET', '/accounts'),
    createGroup: (name) => call('POST', '/groups', { name, peers: [] }),
    assignAutoGroups: (userId, autoGroups) => call('PUT', `/users/${userId}`, { role: 'user', auto_groups: autoGroups, is_blocked: false }),
    /**
     * Zone distribution is replaced as a whole and the server drops records it
     * is not sent, so the existing records travel back unchanged.
     */
    updateZoneDistribution: (zone, distributionGroups) => call('PUT', `/dns/zones/${zone.id}`, {
      name: zone.name,
      domain: zone.domain,
      enabled: zone.enabled,
      enable_search_domain: zone.enable_search_domain,
      distribution_groups: distributionGroups,
      records: (zone.records ?? []).map((record) => ({ id: record.id, name: record.name, type: record.type, content: record.content, ttl: record.ttl })),
    }),
    createSelfPolicy: (policyName, groupId) => call('POST', '/policies', {
      name: policyName,
      description: 'Member reaches only their own machines',
      enabled: true,
      rules: [{
        name: 'self',
        enabled: true,
        action: 'accept',
        protocol: 'all',
        bidirectional: true,
        sources: [groupId],
        destinations: [groupId],
      }],
    }),
    replacePolicy: (policyId, policy, groupId) => call('PUT', `/policies/${policyId}`, {
      name: policy.name,
      description: policy.description ?? '',
      enabled: policy.enabled,
      rules: [{
        name: 'self',
        enabled: true,
        action: 'accept',
        protocol: 'all',
        bidirectional: true,
        sources: [groupId],
        destinations: [groupId],
      }],
    }),
    createOpsPolicy: (policyName, opsGroupId, groupId) => call('POST', '/policies', {
      name: policyName,
      description: 'IT support access to this member namespace (unidirectional)',
      enabled: true,
      rules: [{
        name: 'ops to member',
        enabled: true,
        action: 'accept',
        protocol: 'all',
        bidirectional: false,
        sources: [opsGroupId],
        destinations: [groupId],
      }],
    }),
    deletePolicy: (policyId) => call('DELETE', `/policies/${policyId}`),
  }
}

export async function readState(client) {
  const [users, groups, policies, zones, accounts] = await Promise.all([
    client.listUsers(),
    client.listGroups(),
    client.listPolicies(),
    client.listZones(),
    client.getAccount(),
  ])
  const settings = Array.isArray(accounts) ? accounts[0]?.settings : accounts?.settings
  return { users, groups, policies, zones, groupsPropagationEnabled: settings?.groups_propagation_enabled ?? true }
}

export async function applyPlan(client, plan, state) {
  const groupByName = new Map(state.groups.map((group) => [group.name, group]))
  const userByName = new Map(state.users.map((user) => [user.name, user]))
  const policyByName = new Map(state.policies.map((policy) => [policy.name, policy]))
  const zoneById = new Map((state.zones ?? []).map((zone) => [zone.id, { ...zone, distribution_groups: [...(zone.distribution_groups ?? [])] }]))
  const done = []
  for (const action of plan.actions) {
    if (action.kind === 'create-group') {
      const group = await client.createGroup(action.group)
      groupByName.set(group.name, group)
      done.push(`created group ${action.group}`)
    } else if (action.kind === 'assign-group') {
      const group = groupByName.get(action.group)
      const user = userByName.get(action.user)
      if (!group || !user) throw new Error(`missing state for ${action.user}/${action.group}`)
      const autoGroups = Array.from(new Set([...(user.auto_groups ?? []), group.id]))
      await client.assignAutoGroups(user.id, autoGroups)
      done.push(`assigned ${action.group} to ${action.user}`)
    } else if (action.kind === 'create-policy') {
      const group = groupByName.get(action.group)
      const policy = await client.createSelfPolicy(action.policy, group.id)
      policyByName.set(policy.name, policy)
      done.push(`created policy ${action.policy}`)
    } else if (action.kind === 'fix-policy') {
      const group = groupByName.get(action.group)
      const policy = policyByName.get(action.policy)
      await client.replacePolicy(policy.id, policy, group.id)
      done.push(`fixed policy ${action.policy}`)
    } else if (action.kind === 'distribute-zone' || action.kind === 'undistribute-zone') {
      const zone = zoneById.get(action.zoneId)
      if (!zone) throw new Error(`missing state for zone ${action.zone}`)
      if (action.kind === 'distribute-zone' && !zone.distribution_groups.includes(action.groupId)) zone.distribution_groups.push(action.groupId)
      if (action.kind === 'undistribute-zone') zone.distribution_groups = zone.distribution_groups.filter((id) => id !== action.groupId)
      await client.updateZoneDistribution(zone, zone.distribution_groups)
      done.push(`${action.kind === 'distribute-zone' ? 'distributed' : 'undistributed'} zone ${action.zone} ${action.kind === 'distribute-zone' ? 'to' : 'from'} ${action.group}`)
    } else if (action.kind === 'create-ops-policy') {
      const opsGroup = state.groups.find((group) => group.name === OPS_GROUP_NAME)
      const group = groupByName.get(action.group)
      if (!opsGroup || !group) throw new Error(`missing state for ${action.policy}`)
      await client.createOpsPolicy(action.policy, opsGroup.id, group.id)
      done.push(`created policy ${action.policy} (IT access, visible to that member)`)
    } else if (action.kind === 'delete-ops-policy') {
      await client.deletePolicy(action.id)
      done.push(`deleted policy ${action.policy}`)
    }
  }
  return done
}

export function renderPlan(plan, { apply }) {
  const lines = []
  const mode = apply ? 'apply' : 'dry-run'
  lines.push(`netbird user namespace (${mode})`)
  if (plan.warning) lines.push(`WARNING: ${plan.warning}`)
  if (plan.users.length === 0) lines.push('no namespace users found')
  for (const entry of plan.users) {
    lines.push(entry.upToDate ? `= ${entry.user}: up to date` : `~ ${entry.user}: ${entry.steps.join(', ')}`)
  }
  lines.push(`${plan.actions.length} action(s)`)
  return lines.join('\n')
}

export const HELP = `netbird user namespace

Gives every approved member one private group, one self policy and the fleet
DNS access their own machine's entry needs. Dry-run unless --apply is passed.

  --apply                  write the plan (default: print it)
  --only <name>            plan one member
  --include-pending        include members still waiting for approval
  --include-admins         include non-"user" roles
  --no-zone-access         do not join members to the fleet DNS zone
  --revoke-zone-access     remove every member group from that zone
  --with-ops-access        add an opt-in IT access policy per member
  --revoke-ops-access      delete every IT access policy
  --json                   machine-readable plan
  --help                   this text`

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    process.stdout.write(`${HELP}\n`)
    return 0
  }
  const baseUrl = process.env.NETBIRD_MGMT_URL || DEFAULT_MANAGEMENT_URL
  const client = createClient({ baseUrl, token: await resolveToken() })
  const state = await readState(client)
  let fleetZone = null
  if (options.zoneAccess || options.revokeZoneAccess) {
    try {
      fleetZone = await readFleetZone()
    } catch (error) {
      process.stderr.write(`could not derive the fleet DNS zone: ${error.message}\n`)
    }
  }
  const plan = planNamespaces({ ...state, fleetZone, includePending: options.includePending, includeAdmins: options.includeAdmins, only: options.only, withOpsAccess: options.withOpsAccess, revokeOpsAccess: options.revokeOpsAccess, zoneAccess: options.zoneAccess, revokeZoneAccess: options.revokeZoneAccess })
  if (options.json) process.stdout.write(`${JSON.stringify({ plan, target: baseUrl }, null, 2)}\n`)
  else process.stdout.write(`${renderPlan(plan, { apply: options.apply })}\n`)
  if (!options.apply || plan.actions.length === 0) return 0
  const done = await applyPlan(client, plan, state)
  for (const line of done) process.stdout.write(`${line}\n`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}