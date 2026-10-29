export const name = 'code-vibe-roster-probe'
export const inject = ['agentPresets', 'skills']

export function apply(ctx) {
  setTimeout(async () => {
    const inventory = await ctx.agentPresets.compositionInventory()
    const composition = inventory.find(item => item.id === 'code-vibe')
    const scope = await ctx.agentPresets.acquireScope('code-vibe')
    try {
      const skills = await ctx.skills.list({ scope: scope.key, cwd: process.cwd() })
      const bundled = skills
        .filter(item => ['wish-programming', 'agent-operation', 'quality-review', 'frontend-design'].includes(item.name))
        .map(item => item.name)
        .sort()
      console.log('[CODE_VIBE_RUNTIME]', JSON.stringify({ composition, skills: bundled }))
    } finally {
      await scope[Symbol.asyncDispose]()
    }
  }, 1_500)
}
