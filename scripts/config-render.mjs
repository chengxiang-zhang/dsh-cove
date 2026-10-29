// Render config templates into build outputs. Run before building, testing, or packing:
// the repository commits the template, the machine supplies the values.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadDeploymentConfig, renderTemplate, repoRoot } from './lib/deployment-config.mjs';

const RENDERS = [
  {
    template: join(repoRoot, 'config', 'templates', 'hiopen.patch.yml.tmpl'),
    output: join(repoRoot, 'packages', 'dsh-web-all', 'presets', 'hiopen.patch.yml'),
  },
];

const config = loadDeploymentConfig();
for (const { template, output } of RENDERS) {
  const body = renderTemplate(readFileSync(template, 'utf8'), config, template);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, body);
  console.log(`config-render: ${output} <- ${template} (${config.source} values)`);
}
