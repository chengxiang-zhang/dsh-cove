import test from 'node:test'
import assert from 'node:assert/strict'
import {
  fleetZoneFromPattern,
  isNamespaceUser,
  namespaceNames,
  parseArgs,
  planNamespaces,
  policyMatchesSelf,
  renderPlan,
} from './dsh-netbird-user-namespace.mjs'

const member = { id: 'user-1', name: 'alice', role: 'user', status: 'active', is_service_user: false, pending_approval: false, auto_groups: [] }
const selfGroup = { id: 'group-a', name: 'u-alice' }
const opsGroup = { id: 'ops-1', name: 'ops' }
const fleetZone = { id: 'zone-1', name: 'netbird services', domain: 'netbird', enabled: true, enable_search_domain: true, distribution_groups: ['ops-1'], records: [{ id: 'r1', name: 'dsh.alice-mac.netbird', type: 'A', content: '100.64.1.1', ttl: 300 }] }
const selfPolicy = {
  id: 'policy-a',
  name: 'self-alice',
  enabled: true,
  rules: [{ enabled: true, action: 'accept', protocol: 'all', bidirectional: true, sources: ['group-a'], destinations: ['group-a'] }],
}

test('plans a private group, membership and self policy for a new member', () => {
  const plan = planNamespaces({ users: [member], groups: [], policies: [] })
  assert.deepEqual(plan.actions.map((action) => action.kind), ['create-group', 'assign-group', 'create-policy'])
  assert.deepEqual(plan.actions[1].autoGroups, ['u-alice'])
  assert.equal(plan.users[0].upToDate, false)
})

test('is idempotent once the group, membership and policy exist', () => {
  const plan = planNamespaces({
    users: [{ ...member, auto_groups: ['group-a'] }],
    groups: [selfGroup],
    policies: [selfPolicy],
  })
  assert.deepEqual(plan.actions, [])
  assert.equal(plan.users[0].upToDate, true)
})

test('keeps pre-existing auto groups when assigning the namespace group', () => {
  const plan = planNamespaces({
    users: [{ ...member, auto_groups: ['other-group'] }],
    groups: [selfGroup],
    policies: [selfPolicy],
  })
  assert.deepEqual(plan.actions, [{ kind: 'assign-group', user: 'alice', group: 'u-alice', autoGroups: ['other-group', 'u-alice'] }])
})

test('skips service users, admins, blocked and pending members by default', () => {
  const users = [
    member,
    { ...member, id: 'u2', name: 'svc', is_service_user: true },
    { ...member, id: 'u3', name: 'boss', role: 'admin' },
    { ...member, id: 'u4', name: 'blocked', status: 'blocked' },
    { ...member, id: 'u5', name: 'pending', pending_approval: true },
  ]
  assert.deepEqual(planNamespaces({ users, groups: [], policies: [] }).users.map((entry) => entry.user), ['alice'])
  assert.deepEqual(
    planNamespaces({ users, groups: [], policies: [], includePending: true, includeAdmins: true }).users.map((entry) => entry.user),
    ['alice', 'boss', 'blocked', 'pending'],
  )
})

test('only selects one member and reports group propagation state', () => {
  const users = [member, { ...member, id: 'u2', name: 'bob' }]
  const plan = planNamespaces({ users, groups: [], policies: [], only: 'bob', groupsPropagationEnabled: false })
  assert.deepEqual(plan.users.map((entry) => entry.user), ['bob'])
  assert.match(plan.warning, /group propagation is disabled/)
})

test('repairs a self policy whose rules no longer point at the member group', () => {
  const drifted = { ...selfPolicy, rules: [{ enabled: true, action: 'accept', bidirectional: false, sources: ['group-a'], destinations: ['group-a'] }] }
  const plan = planNamespaces({ users: [{ ...member, auto_groups: ['group-a'] }], groups: [selfGroup], policies: [drifted] })
  assert.deepEqual(plan.actions.map((action) => action.kind), ['fix-policy'])
})

test('namespace names are lowercase prefixed slugs', () => {
  assert.deepEqual(namespaceNames({ name: 'Alice.Q' }), { group: 'u-alice.q', policy: 'self-alice.q' })
})

test('policyMatchesSelf only accepts an enabled bidirectional self rule', () => {
  assert.equal(policyMatchesSelf(selfPolicy, 'group-a'), true)
  assert.equal(policyMatchesSelf(selfPolicy, 'group-b'), false)
  assert.equal(policyMatchesSelf({ rules: [{ ...selfPolicy.rules[0], bidirectional: false }] }, 'group-a'), false)
  assert.equal(policyMatchesSelf({ rules: [{ ...selfPolicy.rules[0], enabled: false }] }, 'group-a'), false)
  assert.equal(policyMatchesSelf({ rules: [{ ...selfPolicy.rules[0], sources: [{ id: 'group-a' }], destinations: [{ id: 'group-a' }] }] }, 'group-a'), true)
})

test('parses flags and rejects unknown ones', () => {
  assert.deepEqual(parseArgs(['--apply', '--only', 'alice']), { apply: true, includePending: false, includeAdmins: false, only: 'alice', json: false, help: false, withOpsAccess: false, revokeOpsAccess: false, zoneAccess: true, revokeZoneAccess: false })
  assert.equal(parseArgs(['--with-ops-access']).withOpsAccess, true)
  assert.equal(parseArgs(['--revoke-ops-access']).revokeOpsAccess, true)
  assert.equal(parseArgs(['--no-zone-access']).zoneAccess, false)
  assert.equal(parseArgs(['--revoke-zone-access']).revokeZoneAccess, true)
  assert.throws(() => parseArgs(['--nope']), /unknown argument/)
})

test('derives the fleet DNS zone from the machine inventory pattern', () => {
  assert.equal(fleetZoneFromPattern('dsh.<netbird-machine-name>.netbird'), 'netbird')
  assert.throws(() => fleetZoneFromPattern('dsh.<machine>'), /domainPattern/)
})

test('keeps IT access off by default and only plans it on request', () => {
  const users = [{ ...member, auto_groups: ['group-a'] }]
  const groups = [selfGroup, { id: 'ops-1', name: 'ops' }]
  const off = planNamespaces({ users, groups, policies: [selfPolicy] })
  assert.deepEqual(off.actions, [])
  const on = planNamespaces({ users, groups, policies: [selfPolicy], withOpsAccess: true })
  assert.deepEqual(on.actions, [{ kind: 'create-ops-policy', policy: 'ops-manage-alice', group: 'u-alice' }])
  assert.match(on.warning, /IT access exposes/)
})

test('does not plan IT access without an ops group', () => {
  const on = planNamespaces({ users: [{ ...member, auto_groups: ['group-a'] }], groups: [selfGroup], policies: [selfPolicy], withOpsAccess: true })
  assert.deepEqual(on.actions, [])
  assert.match(on.warning, /no "ops" group found/)
})

test('revoke lists every ops access policy for deletion', () => {
  const plan = planNamespaces({
    users: [],
    groups: [],
    policies: [{ id: 'p1', name: 'ops-manage-alice' }, { id: 'p2', name: 'self-alice' }],
    revokeOpsAccess: true,
  })
  assert.deepEqual(plan.actions, [{ kind: 'delete-ops-policy', policy: 'ops-manage-alice', id: 'p1' }])
})

test('joins the member group to the fleet DNS zone so its own entry resolves', () => {
  const plan = planNamespaces({
    users: [{ ...member, auto_groups: ['group-a'] }],
    groups: [selfGroup, opsGroup],
    policies: [selfPolicy],
    zones: [fleetZone],
    fleetZone: 'netbird',
  })
  assert.deepEqual(plan.actions, [{ kind: 'distribute-zone', zone: 'netbird', zoneId: 'zone-1', group: 'u-alice', groupId: 'group-a' }])
  assert.equal(plan.users[0].upToDate, false)
  assert.match(plan.warning, /every name in zone "netbird"/)
})

test('is idempotent once the member group is already a distribution group', () => {
  const plan = planNamespaces({
    users: [{ ...member, auto_groups: ['group-a'] }],
    groups: [selfGroup, opsGroup],
    policies: [selfPolicy],
    zones: [{ ...fleetZone, distribution_groups: ['ops-1', 'group-a'] }],
    fleetZone: 'netbird',
  })
  assert.deepEqual(plan.actions, [])
  assert.equal(plan.users[0].upToDate, true)
})

test('leaves the zone alone with --no-zone-access', () => {
  const plan = planNamespaces({
    users: [{ ...member, auto_groups: ['group-a'] }],
    groups: [selfGroup, opsGroup],
    policies: [selfPolicy],
    zones: [fleetZone],
    fleetZone: 'netbird',
    zoneAccess: false,
  })
  assert.deepEqual(plan.actions, [])
  assert.equal(plan.warning, null)
})

test('warns instead of silently skipping when the fleet zone is absent', () => {
  const plan = planNamespaces({ users: [member], groups: [], policies: [], zones: [], fleetZone: 'netbird' })
  assert.deepEqual(plan.actions.map((action) => action.kind), ['create-group', 'assign-group', 'create-policy'])
  assert.match(plan.warning, /no DNS zone with domain netbird/)
})

test('revoke-zone-access removes member groups and keeps the fleet group', () => {
  const plan = planNamespaces({
    users: [],
    groups: [selfGroup, opsGroup],
    policies: [],
    zones: [{ ...fleetZone, distribution_groups: ['ops-1', 'group-a'] }],
    fleetZone: 'netbird',
    revokeZoneAccess: true,
  })
  assert.deepEqual(plan.actions, [{ kind: 'undistribute-zone', zone: 'netbird', zoneId: 'zone-1', group: 'u-alice', groupId: 'group-a' }])
})

test('a revoke pass removes access instead of handing it out', () => {
  const plan = planNamespaces({
    users: [{ ...member, auto_groups: ['group-a'] }],
    groups: [selfGroup, opsGroup],
    policies: [selfPolicy],
    zones: [fleetZone],
    fleetZone: 'netbird',
    revokeZoneAccess: true,
  })
  assert.deepEqual(plan.actions, [])
  assert.equal(plan.warning, null)
})

test('renders a dry-run plan that never claims an apply', () => {
  const plan = planNamespaces({ users: [member], groups: [], policies: [] })
  const text = renderPlan(plan, { apply: false })
  assert.match(text, /dry-run/)
  assert.match(text, /3 action\(s\)/)
})

test('isNamespaceUser requires a named non-service member', () => {
  assert.equal(isNamespaceUser(member), true)
  assert.equal(isNamespaceUser({ role: 'user', status: 'active' }), false)
})