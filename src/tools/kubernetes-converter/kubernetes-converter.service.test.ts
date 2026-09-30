import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import harborManifest from '../../../fixtures/harbor/rendered.yaml?raw';
import { type ConversionTarget, convertKubernetes, exportKubernetesSecrets } from './kubernetes-converter.service';
import { exampleManifest, multiContainerExample } from './kubernetes-converter.examples';

const targets: ConversionTarget[] = ['compose', 'quadlet', 'docker-run', 'podman-run'];
const pod = (spec: object, name = 'test', namespace = 'default') => JSON.stringify({ apiVersion: 'v1', kind: 'Pod', metadata: { name, namespace }, spec });
const simple = (extra: object = {}) => pod({ containers: [{ name: 'app', image: 'docker.io/library/nginx:alpine', ...extra }] });
function content(input: string, target: ConversionTarget, filename?: string) {
  const result = convertKubernetes(input, target);
  expect(result.errors).toEqual([]);
  return filename ? result.files.find(file => file.name === filename)!.content : result.files[0].content;
}

describe('Kubernetes manifest conversion', () => {
  it.each(targets)('converts a Deployment and a named Service port to %s', (target) => {
    const result = convertKubernetes(exampleManifest, target);
    expect(result.errors).toEqual([]);
    expect(result.files.map(file => file.content).join('\n')).toContain('127.0.0.1');
    expect(result.warnings).toEqual([]);
  });

  it.each(targets)('includes ConfigMap companion files for %s', (target) => {
    const result = convertKubernetes(multiContainerExample, target);
    expect(result.errors).toEqual([]);
    expect(result.files.find(file => file.name === 'config/demo-nginx-config/default.conf')?.content).toContain('listen 80;');
    expect(result.warnings.some(warning => warning.includes('emptyDir'))).toBe(true);
  });

  it('preserves pod networking, resource limits and environment values in Compose', () => {
    const compose = parse(content(multiContainerExample, 'compose'));
    expect(compose.services['demo-app-writer'].network_mode).toBe('service:demo-app-web');
    expect(compose.services['demo-app-writer'].depends_on).toEqual(['demo-app-web']);
    expect(compose.services['demo-app-writer'].ports).toBeUndefined();
    expect(compose.services['demo-app-web'].ports[0].published).toBe('8080');
    expect(compose.services['demo-app-web'].volumes[0]).toMatchObject({ type: 'bind', read_only: true, bind: { create_host_path: false } });
    const simpleCompose = parse(content(exampleManifest, 'compose'));
    expect(simpleCompose.services['default-web']).toMatchObject({ mem_limit: 134217728, cpus: 0.5 });
  });

  it('generates Podman pod, network, volume and container units', () => {
    const result = convertKubernetes(multiContainerExample, 'quadlet');
    expect(result.files.map(file => file.name)).toEqual(expect.arrayContaining(['demo-app.pod', 'demo-app-content.volume', 'demo-app-web.container', 'demo-app-writer.container', 'kubernetes-local.network']));
    const unit = result.files.find(file => file.name === 'demo-app-writer.container')!.content;
    expect(unit).toContain('Pod=demo-app.pod');
    expect(unit).toContain('demo-app-content.volume:/content');
    expect(unit).toContain('Entrypoint=');
    expect(unit).not.toContain('Network=');
    expect(result.files.find(file => file.name === 'demo-app.pod')!.content).toContain('PublishPort=127.0.0.1:8080:80/tcp');
  });

  it('generates shared-network Docker commands and Podman pod commands', () => {
    expect(content(multiContainerExample, 'docker-run')).toContain('\'container:demo-app-web\'');
    const podman = content(multiContainerExample, 'podman-run');
    expect(podman).toContain('podman pod create --name \'demo-app\'');
    expect(podman.match(/--pod/g)).toHaveLength(2);
    expect(podman).toContain('"$bundle_dir"/');
  });

  it('supports a kubectl List and preserves namespace identity', () => {
    const input = JSON.stringify({ apiVersion: 'v1', kind: 'List', items: [JSON.parse(simple()), JSON.parse(pod({ containers: [{ name: 'app', image: 'nginx' }] }, 'test', 'other'))] });
    expect(Object.keys(parse(content(input, 'compose')).services)).toEqual(['default-test', 'other-test']);
  });

  it('resolves ConfigMap envFrom and explicit values with Kubernetes precedence', () => {
    const config = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'config' }, data: { MODE: 'old', OTHER: 'yes' } };
    const manifest = `${simple({ envFrom: [{ configMapRef: { name: 'config' }, prefix: 'APP_' }], env: [{ name: 'APP_MODE', value: 'new' }, { name: 'DIRECT', valueFrom: { configMapKeyRef: { name: 'config', key: 'OTHER' } } }] })}\n---\n${JSON.stringify(config)}`;
    expect(parse(content(manifest, 'compose')).services['default-test'].environment).toEqual({ APP_MODE: 'new', APP_OTHER: 'yes', DIRECT: 'yes' });
  });

  it('keeps Secret contents out of every output, including envFrom', () => {
    const secret = { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'secret' }, data: { PASSWORD: 'c2VjcmV0' }, stringData: { TOKEN: 'secret-token' } };
    const input = `${simple({ envFrom: [{ secretRef: { name: 'secret' } }], env: [{ name: 'EXPLICIT', valueFrom: { secretKeyRef: { name: 'secret', key: 'PASSWORD' } } }] })}\n---\n${JSON.stringify(secret)}`;
    for (const target of targets) {
      const result = convertKubernetes(input, target);
      expect(result.errors).toEqual([]);
      expect(JSON.stringify(result)).not.toContain('c2VjcmV0');
      expect(JSON.stringify(result)).not.toContain('secret-token');
      expect(result.warnings.length).toBeGreaterThan(0);
    }
    expect(parse(content(input, 'compose')).services['default-test'].environment).toEqual({ PASSWORD: null, TOKEN: null, EXPLICIT: null });
  });

  it('escapes Compose interpolation and shell metacharacters', () => {
    // eslint-disable-next-line no-template-curly-in-string -- Literal interpolation syntax is intentional test data.
    const input = simple({ env: [{ name: 'VALUE', value: '$HOME ${HOME} $(touch /tmp/nope) \'quoted\'' }], command: ['sh', '-c'], args: ['printf "%s" "$VALUE"'] });
    // eslint-disable-next-line no-template-curly-in-string -- Literal interpolation syntax is intentional test data.
    expect(parse(content(input, 'compose')).services['default-test'].environment.VALUE).toBe('$$HOME $${HOME} $$(touch /tmp/nope) \'quoted\'');
    expect(content(input, 'docker-run')).toContain('\'"\'"\'');
    expect(content(input, 'quadlet', 'default-test.container')).toContain('Environment=');
  });

  it('escapes systemd percent specifiers and multiline environment values', () => {
    const unit = content(simple({ env: [{ name: 'VALUE', value: '100% %h\n[Service]\nExecStart=/bad' }] }), 'quadlet', 'default-test.container');
    expect(unit).toContain('100%% %%h\\n[Service]\\nExecStart=/bad');
    expect(unit.split('\n').filter(line => line.startsWith('ExecStart='))).toEqual([]);
  });

  it('maps PVC and StatefulSet claim templates to empty named volumes', () => {
    const input = JSON.stringify({ apiVersion: 'apps/v1', kind: 'StatefulSet', metadata: { name: 'db' }, spec: { replicas: 2, template: { spec: { containers: [{ name: 'db', image: 'postgres', volumeMounts: [{ name: 'data', mountPath: '/data' }] }] } }, volumeClaimTemplates: [{ metadata: { name: 'data' }, spec: { storageClassName: 'ceph' } }] } });
    const result = convertKubernetes(input, 'compose');
    expect(result.errors).toEqual([]);
    expect(parse(result.files[0].content).volumes).toHaveProperty('default-db-data');
    expect(result.warnings.some(warning => warning.includes('replicas=2'))).toBe(true);
  });

  it('applies UID/GID, capabilities, read-only filesystems and no-new-privileges', () => {
    const input = pod({ securityContext: { runAsUser: 1000, runAsGroup: 1000 }, containers: [{ name: 'app', image: 'nginx', securityContext: { readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } } }] });
    const compose = parse(content(input, 'compose')).services['default-test'];
    expect(compose).toMatchObject({ user: '1000:1000', read_only: true, cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'] });
    expect(content(input, 'quadlet', 'default-test.container')).toContain('ReadOnlyTmpfs=false');
    expect(content(input, 'docker-run')).toContain('--read-only');
  });

  it('retains host networking and suppresses conflicting publishing and aliases', () => {
    const input = pod({ hostNetwork: true, containers: [{ name: 'app', image: 'nginx', ports: [{ containerPort: 80, hostPort: 80 }] }] });
    const service = parse(content(input, 'compose')).services['default-test'];
    expect(service.network_mode).toBe('host');
    expect(service.ports).toBeUndefined();
    expect(content(input, 'quadlet', 'default-test.pod')).toContain('Network=host');
  });

  it('reports unsupported policies, replicas, probes and mounts instead of guessing', () => {
    const input = `${simple({ livenessProbe: { httpGet: { path: '/', port: 80 } }, volumeMounts: [{ name: 'secret', mountPath: '/secret' }] }).replace('"spec":{', '"spec":{"volumes":[{"name":"secret","secret":{"secretName":"missing"}}],')}\n---\napiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: denied\n`;
    const result = convertKubernetes(input, 'compose');
    expect(result.errors).toEqual([]);
    expect(result.warnings.join('\n')).toContain('livenessProbe');
    expect(result.warnings.join('\n')).toContain('unsupported source');
    expect(result.warnings.join('\n')).toContain('NetworkPolicy');
  });

  it.each(['', '\n'])('handles empty input without errors', (input) => {
    expect(convertKubernetes(input, 'compose')).toEqual({ files: [], warnings: [], errors: [] });
  });

  it.each([
    'not: [valid',
    'kind: Pod\napiVersion: v1\nmetadata: {name: test}\nspec: {containers: []}',
    'apiVersion: v1\nkind: ConfigMap\nmetadata: {name: test}',
    `${simple()}\n---\n${simple()}`,
    simple({ image: '' }),
    simple({ resources: { limits: { memory: 'banana' } } }),
    simple({ command: 'sh -c' }),
    simple({ ports: [{ containerPort: 80, hostPort: 70000 }] }),
  ])('returns actionable errors and no partial files for invalid input', (input) => {
    const result = convertKubernetes(input, 'compose');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.files).toEqual([]);
  });

  it('rejects traversal in ConfigMap companion files', () => {
    const input = `${pod({ containers: [{ name: 'app', image: 'nginx', volumeMounts: [{ name: 'config', mountPath: '/config' }] }], volumes: [{ name: 'config', configMap: { name: 'config', items: [{ key: 'ok', path: '../../outside' }] } }] })}\n---\napiVersion: v1\nkind: ConfigMap\nmetadata: {name: config}\ndata: {ok: value}`;
    expect(convertKubernetes(input, 'quadlet').errors[0]).toContain('Unsafe ConfigMap item path');
  });

  it('rejects duplicate host bindings across workloads', () => {
    const input = [pod({ containers: [{ name: 'app', image: 'nginx', ports: [{ hostPort: 8080, containerPort: 80 }] }] }, 'one'), pod({ containers: [{ name: 'app', image: 'nginx', ports: [{ hostPort: 8080, containerPort: 80 }] }] }, 'two')].join('\n---\n');
    expect(convertKubernetes(input, 'compose').errors[0]).toContain('Host port collision');
  });
});

describe('Podman Secret references', () => {
  const secret = (name: string, data: object, namespace = 'default') => JSON.stringify({ apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace }, stringData: data });

  it('keeps identities when two Secrets use the same key and one key has multiple consumers', () => {
    const input = [simple({ env: [{ name: 'FIRST', valueFrom: { secretKeyRef: { name: 'first', key: 'password' } } }, { name: 'SECOND', valueFrom: { secretKeyRef: { name: 'second', key: 'password' } } }, { name: 'SHARED', valueFrom: { secretKeyRef: { name: 'first', key: 'password' } } }] }), secret('first', { password: 'never-output-first' }), secret('second', { password: 'never-output-second' })].join('\n---\n');
    const result = convertKubernetes(input, 'quadlet');
    expect(result.errors).toEqual([]);
    expect(result.secretReferences).toHaveLength(2);
    const unit = result.files.find(file => file.name.endsWith('.container'))!.content;
    expect(unit).toContain('Secret=k8s-7-default-5-first-password,type=env,target=FIRST');
    expect(unit).toContain('Secret=k8s-7-default-6-second-password,type=env,target=SECOND');
    expect(unit).toContain('Secret=k8s-7-default-5-first-password,type=env,target=SHARED');
    expect(JSON.stringify(result)).not.toContain('never-output');
  });

  it('preserves env precedence and imports only the surviving Secret references', () => {
    const input = [simple({ envFrom: [{ secretRef: { name: 'config' }, prefix: 'APP_' }], env: [{ name: 'APP_PASSWORD', value: 'literal' }] }), secret('config', { PASSWORD: 'never-output', OTHER: 'required' })].join('\n---\n');
    const result = convertKubernetes(input, 'quadlet');
    expect(result.secretReferences?.map(ref => ref.key)).toEqual(['OTHER']);
    expect(result.files.find(file => file.name.endsWith('.container'))!.content).toContain('Environment="APP_PASSWORD=literal"');
  });

  it('mounts selected Secret keys with their paths, modes and ownership', () => {
    const input = [pod({ securityContext: { runAsUser: 10000, fsGroup: 10000 }, containers: [{ name: 'app', image: 'nginx', volumeMounts: [{ name: 'key', mountPath: '/etc/app/private.pem', subPath: 'key.pem' }] }], volumes: [{ name: 'key', secret: { secretName: 'signing', items: [{ key: 'tls.key', path: 'key.pem', mode: 0o400 }] } }] }), secret('signing', { 'tls.key': 'never-output-private-key', 'ignored': 'unused' })].join('\n---\n');
    const result = convertKubernetes(input, 'quadlet');
    expect(result.errors).toEqual([]);
    expect(result.secretReferences).toHaveLength(1);
    expect(result.files.find(file => file.name.endsWith('.container'))!.content).toContain('type=mount,target=/etc/app/private.pem,uid=10000,gid=10000,mode=0400');
    expect(JSON.stringify(result)).not.toContain('never-output');
  });

  it('retains empty env values without creating zero-byte Podman secrets', () => {
    const input = [simple({ envFrom: [{ secretRef: { name: 'config' } }] }), secret('config', { EMPTY: '', OTHER: 'value' })].join('\n---\n');
    const result = convertKubernetes(input, 'quadlet');
    expect(result.secretReferences?.map(ref => ref.key)).toEqual(['OTHER']);
    expect(result.files.find(file => file.name.endsWith('.container'))!.content).toContain('Environment="EMPTY="');
  });

  it('requires missing envFrom key inventories and rejects path traversal', () => {
    expect(convertKubernetes(simple({ envFrom: [{ secretRef: { name: 'absent' } }] }), 'quadlet').errors[0]).toContain('include Secret absent');
    const input = pod({ containers: [{ name: 'app', image: 'nginx', volumeMounts: [{ name: 'secret', mountPath: '/secret' }] }], volumes: [{ name: 'secret', secret: { secretName: 'external', items: [{ key: 'password', path: '../escape' }] } }] });
    expect(convertKubernetes(input, 'quadlet').errors[0]).toContain('Unsafe Secret item path');
  });
});

describe('Harbor chart compatibility', () => {
  it('converts the complete upstream fixture without losing required mounts', () => {
    const result = convertKubernetes(harborManifest, 'quadlet');
    expect(result.errors).toEqual([]);
    expect(result.files.filter(file => file.name.endsWith('.container'))).toHaveLength(13);
    expect(result.files.filter(file => file.name.endsWith('.pod'))).toHaveLength(11);
    expect(result.secretReferences).toHaveLength(13);
    const core = result.files.find(file => file.name === 'harbor-harbor-core.container')!.content;
    expect(core).toContain('type=mount,target=/etc/core/key');
    expect(core).toContain('type=mount,target=/etc/core/private_key.pem');
    expect(result.files.find(file => file.name === 'harbor-harbor-registry-registry.container')!.content).toContain('type=mount,target=/etc/registry/passwd');
    expect(result.files.find(file => file.name === 'harbor-harbor-database.container')!.content).toContain('Requires=harbor-harbor-database-init-data-permissions-ensurer.container');
    expect(result.files.find(file => file.name.includes('-init-') && file.name.endsWith('.container'))!.content).toContain('Type=oneshot');
    expect(result.warnings.join('\n')).not.toContain('subPath on volume');
    expect(result.warnings.join('\n')).not.toContain('initContainers is not converted');
    expect(JSON.stringify(result)).not.toContain('harbor-test-');
    expect(result.files.find(file => file.name === 'config/harbor-service-harbor-core/haproxy.cfg')!.content).toContain('harbor-harbor-core:8080');
    expect(result.files.find(file => file.name === 'harbor-service-harbor-core.pod')!.content).toContain('NetworkAlias=harbor-core');
    expect(result.files.find(file => file.name === 'harbor-harbor-database.pod')!.content).toContain('ExitPolicy=continue');
    expect(result.files.find(file => file.name === 'harbor-service-harbor-core.container')!.content).toContain('AddCapability="NET_BIND_SERVICE"');
    expect(result.files.find(file => file.name === 'start-quadlets.sh')!.content).not.toContain('-init-');
  });

  it('keeps the separate Secret export outside normal files', () => {
    expect(exportKubernetesSecrets(harborManifest)).toContain('aGFyYm9yLXRlc3Qt');
    expect(convertKubernetes(harborManifest, 'quadlet').files.map(file => file.name)).not.toContain('secrets.json');
  });
});
