import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createServer } from 'vite';

const { values, positionals } = parseArgs({ options: { target: { type: 'string', default: 'quadlet' }, output: { type: 'string' }, secrets: { type: 'boolean', default: false } }, allowPositionals: true });
if (positionals.length !== 1 || !values.output || !['compose', 'quadlet', 'docker-run', 'podman-run'].includes(values.target)) {
  throw new Error('Usage: pnpm convert:kubernetes <rendered.yaml> --output <directory> [--target quadlet|compose|docker-run|podman-run] [--secrets]');
}
const server = await createServer({ root: resolve(dirname(fileURLToPath(import.meta.url)), '..'), server: { middlewareMode: true }, appType: 'custom' });
try {
  const { convertKubernetes, exportKubernetesSecrets } = await server.ssrLoadModule('/src/tools/kubernetes-converter/kubernetes-converter.service.ts');
  const input = await readFile(positionals[0], 'utf8');
  const result = convertKubernetes(input, values.target);
  if (result.errors.length) {
    throw new Error(result.errors.join('\n'));
  }
  for (const file of result.files) {
    const path = resolve(values.output, file.name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content);
  }
  await writeFile(resolve(values.output, 'README.txt'), `Conversion notes:\n${result.warnings.map(note => `- ${note}`).join('\n')}\n`);
  if (values.secrets && result.secretReferences?.length) {
    const path = resolve(values.output, 'secrets.json');
    // Exclusive creation avoids overwriting a file with existing permissive modes.
    await writeFile(path, exportKubernetesSecrets(input), { mode: 0o600, flag: 'wx' });
    console.log('Wrote separate secrets.json (mode 0600); keep it out of git.');
  }
  console.log(`Wrote ${result.files.length} ${values.target} files; ${result.secretReferences?.length ?? 0} Secret key references.`);
}
finally {
  await server.close();
}
