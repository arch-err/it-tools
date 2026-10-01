import { parseAllDocuments, stringify } from 'yaml';
import secretBootstrap from './secret-bootstrap.py?raw';

export type ConversionTarget = 'compose' | 'quadlet' | 'docker-run' | 'podman-run';
export interface QuadletOptions {
  description: string;
  after: string[];
  wants: string[];
  restart: 'manifest' | 'no' | 'always' | 'on-failure';
  wantedBy: string[];
}
export const defaultQuadletOptions: QuadletOptions = {
  description: '',
  after: ['network-online.target'],
  wants: ['network-online.target'],
  restart: 'manifest',
  wantedBy: ['default.target'],
};
export interface OutputFile {
  name: string;
  content: string;
}
export interface SecretReference {
  namespace: string;
  name: string;
  key: string;
  podmanName: string;
}
export interface ConversionResult {
  files: OutputFile[];
  warnings: string[];
  errors: string[];
  secretReferences?: SecretReference[];
}
interface SecretMount {
  reference: SecretReference;
  target: string;
  mode: number;
  uid: number;
  gid: number;
}
type ObjectValue = Record<string, unknown>;
interface Mount {
  type: 'bind' | 'volume';
  source: string;
  target: string;
  readOnly: boolean;
}
interface Container {
  id: string;
  image: string;
  environment: Record<string, string | null>;
  secretEnvironment: Record<string, SecretReference>;
  secretMounts: SecretMount[];
  init: boolean;
  chownVolumes: boolean;
  entrypoint?: string[];
  command?: string[];
  workingDir?: string;
  mounts: Mount[];
  security: ObjectValue;
  user?: string;
  memory?: number;
  cpus?: number;
}
interface PublishedPort {
  host: number;
  target: number;
  protocol: string;
  hostIP: string;
}
interface Workload {
  id: string;
  name: string;
  namespace: string;
  labels: ObjectValue;
  containers: Container[];
  aliases: string[];
  ports: PublishedPort[];
  declaredPorts: ObjectValue[];
  restart: string;
  hostNetwork: boolean;
}

const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {};
const items = (value: unknown): ObjectValue[] => (Array.isArray(value) ? value.map(object) : []);
const namespace = (resource: ObjectValue) => String(object(resource.metadata).namespace ?? 'default');
const name = (resource: ObjectValue) => text(object(resource.metadata).name, `${resource.kind} metadata.name`);
const identity = (ns: string, value: string) => `${ns}-${value}`;

function text(value: unknown, context: string): string {
  if (typeof value !== 'string' || !value.length || /[\r\n]/.test(value) || value.includes('\0')) {
    throw new Error(`${context} must be a nonempty string on one line.`);
  }
  return value;
}
function safeName(value: string): string {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(value)) {
    throw new Error(`Invalid Kubernetes name: ${value}.`);
  }
  return value;
}
function safePath(value: unknown): string {
  const path = text(value, 'Mount path');
  if (!path.startsWith('/') || /[,:]/.test(path) || path.split('/').includes('..')) {
    throw new Error(`Unsupported mount path: ${path}.`);
  }
  return path;
}
function args(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((arg) => typeof arg !== 'string')) {
    throw new Error('Container command and args must be arrays of strings.');
  }
  return value as string[];
}
function port(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error(`Invalid port: ${String(value)}.`);
  }
  return Number(value);
}
function quantity(value: unknown, cpu = false): number {
  const match = String(value).match(/^(\d+(?:\.\d+)?)([KMGTPE]i|[kKMGTPE]|m)?$/);
  if (!match) {
    throw new Error(`Unsupported resource quantity: ${String(value)}.`);
  }
  const suffix = match[2] ?? '';
  if (cpu) {
    if (suffix && suffix !== 'm') {
      throw new Error(`Unsupported CPU quantity: ${String(value)}.`);
    }
    return Number(match[1]) / (suffix === 'm' ? 1000 : 1);
  }
  const power = suffix ? 'kMGTPE'.toLowerCase().indexOf(suffix[0].toLowerCase()) + 1 : 0;
  return Math.ceil(Number(match[1]) * (suffix === 'm' ? 0.001 : (suffix.endsWith('i') ? 1024 : 1000) ** power));
}

// Compose interpolates dollar signs in YAML values, even when they are quoted.
function composeLiteral(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$/g, '$$$$');
  }
  if (Array.isArray(value)) {
    return value.map(composeLiteral);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, composeLiteral(item)]));
  }
  return value;
}

// Quote systemd words and prevent manifest contents from becoming specifiers.
function unitWord(value: string): string {
  return JSON.stringify(value.replace(/%/g, '%%')).replace(/\\u0000/g, '\\x00');
}

export function convertKubernetes(
  input: string,
  target: ConversionTarget,
  quadletOptions: Partial<QuadletOptions> = {},
): ConversionResult {
  const warnings = new Set<string>();
  const files: OutputFile[] = [];
  const volumes = new Set<string>();
  const secretReferences = new Map<string, SecretReference>();
  const podmanTarget = target === 'quadlet' || target === 'podman-run';
  const warn = (message: string) => warnings.add(message);
  try {
    if (!input.trim()) {
      return { files: [], warnings: [], errors: [] };
    }
    const documents = parseAllDocuments(input, { uniqueKeys: true });
    const resources: ObjectValue[] = [];
    const addResource = (value: unknown) => {
      const resource = object(value);
      if (resource.kind === 'List') {
        items(resource.items).forEach(addResource);
      } else if (value !== null && Object.keys(resource).length === 0) {
        throw new Error('Each YAML document must be a Kubernetes resource object.');
      } else if (Object.keys(resource).length) {
        if (!resource.kind || !resource.apiVersion) {
          throw new Error('Each manifest must have apiVersion and kind. Render Helm templates before converting.');
        }
        resources.push(resource);
      }
    };
    for (const document of documents) {
      if (document.errors.length) {
        throw new Error(document.errors.map((error) => error.message).join('\n'));
      }
      addResource(document.toJS({ maxAliasCount: 100 }));
    }
    const lookup = new Map<string, ObjectValue>();
    for (const resource of resources) {
      const ns = safeName(namespace(resource));
      const resourceName = safeName(name(resource));
      const key = `${ns}/${resource.kind}/${resourceName}`;
      if (lookup.has(key)) {
        throw new Error(`Duplicate resource: ${key}.`);
      }
      lookup.set(key, resource);
    }
    const find = (ns: string, kind: string, resourceName: unknown) =>
      lookup.get(`${ns}/${kind}/${String(resourceName)}`);
    const secretRef = (ns: string, secretName: unknown, key: unknown): SecretReference => {
      const resourceName = safeName(text(secretName, 'Secret name'));
      const secretKey = text(key, 'Secret key');
      if (!/^[A-Za-z0-9._-]+$/.test(secretKey)) {
        throw new Error(`Unsupported Secret key: ${secretKey}.`);
      }
      // Length prefixes distinguish names such as a-b/c from a/b-c.
      const podmanName = `k8s-${ns.length}-${ns}-${resourceName.length}-${resourceName}-${secretKey}`;
      const reference = { namespace: ns, name: resourceName, key: secretKey, podmanName };
      secretReferences.set(podmanName, reference);
      return reference;
    };
    const emptySecretKey = (ns: string, secretName: unknown, key: unknown) => {
      const resource = find(ns, 'Secret', secretName);
      const stringData = object(resource?.stringData);
      const data = object(resource?.data);
      return Object.prototype.hasOwnProperty.call(stringData, String(key))
        ? stringData[String(key)] === ''
        : Object.prototype.hasOwnProperty.call(data, String(key)) && data[String(key)] === '';
    };
    const workloads: Workload[] = [];
    for (const resource of resources) {
      const kind = String(resource.kind);
      if (['Service', 'ConfigMap', 'Secret', 'PersistentVolumeClaim', 'Namespace'].includes(kind)) {
        continue;
      }
      if (
        ![
          'Pod',
          'Deployment',
          'StatefulSet',
          'DaemonSet',
          'Job',
          'CronJob',
          'ReplicaSet',
          'ReplicationController',
        ].includes(kind)
      ) {
        warn(`${kind}/${name(resource)} is not converted.`);
        continue;
      }
      const ns = namespace(resource);
      const resourceName = name(resource);
      const id = identity(ns, resourceName);
      if (workloads.some((workload) => workload.id === id)) {
        throw new Error(`Workload output name collision: ${id}. Rename one workload.`);
      }
      const spec = object(resource.spec);
      const template =
        kind === 'CronJob' ? object(object(object(spec.jobTemplate).spec).template) : object(spec.template);
      const pod = kind === 'Pod' ? spec : object(template.spec);
      const labels = object(object(kind === 'Pod' ? resource.metadata : template.metadata).labels);
      if (!Array.isArray(pod.containers) || !pod.containers.length) {
        throw new Error(`${kind}/${resourceName} has no containers.`);
      }
      if (spec.replicas !== undefined && spec.replicas !== 1) {
        warn(`${id}: replicas=${String(spec.replicas)} becomes one local Pod instance.`);
      }
      if (['StatefulSet', 'DaemonSet', 'Job', 'CronJob'].includes(kind)) {
        warn(`${id}: ${kind} scheduling, controller identity and lifecycle are not reproduced.`);
      }
      const supportedPodFields = new Set([
        'containers',
        'initContainers',
        'volumes',
        'securityContext',
        'restartPolicy',
        'hostNetwork',
      ]);
      for (const key of Object.keys(pod)) {
        if (!supportedPodFields.has(key)) {
          warn(`${id}: ${key} is not converted.`);
        }
      }
      const podSecurity = object(pod.securityContext);
      if (podmanTarget && podSecurity.fsGroup !== undefined) {
        warn(
          `${id}: fsGroup is approximated with the container group and :U ownership on local named volumes; this changes local volume ownership and does not reproduce Kubernetes recursive group permissions.`,
        );
      }
      for (const key of [
        'fsGroup',
        'fsGroupChangePolicy',
        'supplementalGroups',
        'sysctls',
        'seLinuxOptions',
        'seccompProfile',
        'runAsNonRoot',
      ]) {
        if (podSecurity[key] !== undefined && !(podmanTarget && ['fsGroup', 'fsGroupChangePolicy'].includes(key))) {
          warn(`${id}: Pod securityContext.${key} is not converted.`);
        }
      }
      const restart = String(pod.restartPolicy ?? 'Always');
      if (!['Always', 'OnFailure', 'Never'].includes(restart)) {
        throw new Error(`${id}: invalid restartPolicy ${restart}.`);
      }
      const workload: Workload = {
        id,
        name: resourceName,
        namespace: ns,
        labels,
        containers: [],
        aliases: [],
        ports: [],
        declaredPorts: [],
        restart,
        hostNetwork: pod.hostNetwork === true,
      };
      if (workload.hostNetwork) {
        warn(`${id}: hostNetwork is retained; published ports and network aliases are omitted.`);
      }
      const podVolumes = items(pod.volumes);
      for (const claim of items(spec.volumeClaimTemplates)) {
        podVolumes.push({ name: name(claim), persistentVolumeClaim: { claimName: `${resourceName}-${name(claim)}` } });
        warn(
          `${id}: volumeClaimTemplate ${name(claim)} becomes a local named volume; storage provisioning and existing data are not migrated.`,
        );
      }
      const rawContainers = [...items(pod.initContainers), ...items(pod.containers)];
      for (const [rawIndex, raw] of rawContainers.entries()) {
        const init = rawIndex < items(pod.initContainers).length;
        if (init && raw.restartPolicy !== undefined) {
          throw new Error(`${id}: restartable init containers are not supported.`);
        }
        const containerName = safeName(text(raw.name, `${id} container name`));
        const containerId = init
          ? `${id}-init-${containerName}`
          : pod.containers.length === 1
            ? id
            : `${id}-${containerName}`;
        if (workload.containers.some((container) => container.id === containerId)) {
          throw new Error(`${id}: duplicate container ${containerName}.`);
        }
        const environment: Record<string, string | null> = Object.create(null);
        const secretEnvironment: Record<string, SecretReference> = Object.create(null);
        const secretMounts: SecretMount[] = [];
        for (const source of items(raw.envFrom)) {
          const config = object(source.configMapRef);
          const secret = object(source.secretRef);
          const isSecret = Boolean(secret.name);
          const referenced = find(ns, isSecret ? 'Secret' : 'ConfigMap', isSecret ? secret.name : config.name);
          if (!referenced) {
            if (isSecret && podmanTarget && secret.optional !== true) {
              throw new Error(`${containerId}: include Secret ${String(secret.name)} to resolve envFrom keys.`);
            }
            warn(
              `${containerId}: envFrom ${String(secret.name ?? config.name)} is missing; its environment variables are omitted.`,
            );
            continue;
          }
          const data = { ...object(referenced.data), ...(isSecret ? object(referenced.stringData) : {}) };
          for (const [key, value] of Object.entries(data)) {
            const envKey = `${String(source.prefix ?? '')}${key}`;
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey)) {
              warn(`${containerId}: envFrom key ${envKey} is not a portable environment name and is skipped.`);
              continue;
            }
            environment[envKey] = isSecret ? null : String(value);
            delete secretEnvironment[envKey];
            if (isSecret) {
              if (emptySecretKey(ns, secret.name, key)) {
                environment[envKey] = '';
              } else {
                secretEnvironment[envKey] = secretRef(ns, secret.name, key);
              }
            }
          }
        }
        for (const variable of items(raw.env)) {
          const variableName = text(variable.name, 'Environment variable name');
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variableName)) {
            throw new Error(`Unsupported environment variable name: ${variableName}.`);
          }
          delete secretEnvironment[variableName];
          if (variable.value !== undefined) {
            environment[variableName] = String(variable.value);
          } else {
            const reference = object(variable.valueFrom);
            const config = object(reference.configMapKeyRef);
            const secret = object(reference.secretKeyRef);
            if (secret.name) {
              if (emptySecretKey(ns, secret.name, secret.key)) {
                environment[variableName] = '';
              } else {
                secretEnvironment[variableName] = secretRef(ns, secret.name, secret.key);
                environment[variableName] = null;
              }
              continue;
            }
            const data = object(find(ns, 'ConfigMap', config.name)?.data);
            const value = data[String(config.key)];
            environment[variableName] = config.name && value !== undefined ? String(value) : null;
            if (environment[variableName] === null) {
              warn(
                `${containerId}: ${variableName} has an unresolved valueFrom reference; supply it through the host environment.`,
              );
            }
          }
        }
        const security = { ...podSecurity, ...object(raw.securityContext) };
        for (const key of ['runAsUser', 'runAsGroup']) {
          if (security[key] !== undefined && (!Number.isInteger(security[key]) || Number(security[key]) < 0)) {
            throw new Error(`${containerId}: ${key} must be a nonnegative integer.`);
          }
        }
        for (const key of ['privileged', 'allowPrivilegeEscalation', 'readOnlyRootFilesystem']) {
          if (security[key] !== undefined && typeof security[key] !== 'boolean') {
            throw new Error(`${containerId}: ${key} must be a boolean.`);
          }
        }
        const group = security.runAsGroup ?? (podmanTarget ? podSecurity.fsGroup : undefined);
        const user =
          security.runAsUser === undefined
            ? undefined
            : `${String(security.runAsUser)}${group === undefined ? '' : `:${String(group)}`}`;
        for (const key of ['runAsNonRoot', 'seccompProfile', 'seLinuxOptions', 'procMount', 'windowsOptions']) {
          if (object(raw.securityContext)[key] !== undefined) {
            warn(`${containerId}: securityContext.${key} is not converted.`);
          }
        }
        if (!user && security.runAsGroup !== undefined) {
          warn(`${containerId}: runAsGroup without runAsUser is not converted.`);
        }
        const supportedContainerFields = new Set([
          'name',
          'image',
          'env',
          'envFrom',
          'command',
          'args',
          'workingDir',
          'ports',
          'resources',
          'securityContext',
          'volumeMounts',
        ]);
        for (const key of Object.keys(raw)) {
          if (!supportedContainerFields.has(key)) {
            warn(`${containerId}: ${key} is not converted.`);
          }
        }
        const limits = object(object(raw.resources).limits);
        if (Object.keys(object(object(raw.resources).requests)).length) {
          warn(`${containerId}: resource requests have no equivalent local scheduling guarantee.`);
        }
        for (const key of Object.keys(limits)) {
          if (!['memory', 'cpu'].includes(key)) {
            warn(`${containerId}: resource limit ${key} is not converted.`);
          }
        }
        const mounts: Mount[] = [];
        for (const mount of items(raw.volumeMounts)) {
          const volume = podVolumes.find((volume) => volume.name === mount.name);
          if (!volume) {
            throw new Error(`${containerId}: volume ${String(mount.name)} is missing.`);
          }
          const mountPath = safePath(mount.mountPath);
          if (mount.subPathExpr !== undefined || mount.mountPropagation !== undefined) {
            warn(
              `${containerId}: volume ${String(mount.name)} has unsupported subPathExpr or mountPropagation and is omitted.`,
            );
            continue;
          }
          const claim = object(volume.persistentVolumeClaim);
          const host = object(volume.hostPath);
          const config = object(volume.configMap);
          if (claim.claimName || volume.emptyDir !== undefined) {
            if (mount.subPath) {
              warn(`${containerId}: subPath on volume ${String(mount.name)} is not converted; the mount is omitted.`);
              continue;
            }
            const volumeId = claim.claimName
              ? identity(ns, safeName(String(claim.claimName)))
              : `${id}-${safeName(String(mount.name))}`;
            volumes.add(volumeId);
            mounts.push({ type: 'volume', source: volumeId, target: mountPath, readOnly: mount.readOnly === true });
            warn(
              claim.claimName
                ? `${volumeId}: local named volume is initially empty; PVC data, storage class and capacity are not migrated.`
                : `${volumeId}: emptyDir becomes a shared named volume; it persists until explicitly removed, and memory/size settings are not retained.`,
            );
          } else if (host.path) {
            const path = safePath(host.path);
            if (mount.subPath) {
              warn(`${containerId}: hostPath subPath is not converted; the mount is omitted.`);
              continue;
            }
            mounts.push({ type: 'bind', source: path, target: mountPath, readOnly: mount.readOnly === true });
            warn(
              `${containerId}: hostPath ${path} now refers to the local host; hostPath type checks are not reproduced.`,
            );
          } else if (config.name) {
            const referenced = find(ns, 'ConfigMap', config.name);
            if (!referenced) {
              throw new Error(`${containerId}: ConfigMap ${String(config.name)} required by a mount is missing.`);
            }
            const data = object(referenced.data);
            const selected =
              config.items === undefined ? Object.keys(data).map((key) => ({ key, path: key })) : items(config.items);
            const root = `config/${identity(ns, safeName(String(config.name)))}`;
            for (const item of selected) {
              const path = text(item.path, 'ConfigMap item path');
              if (
                path.startsWith('/') ||
                path.split('/').some((part) => ['..', '.', ''].includes(part)) ||
                /[,\\]/.test(path)
              ) {
                throw new Error(`Unsafe ConfigMap item path: ${path}.`);
              }
              if (data[String(item.key)] === undefined) {
                throw new Error(`ConfigMap ${String(config.name)} key ${String(item.key)} is missing.`);
              }
              const filename = `${root}/${path}`;
              const content = String(data[String(item.key)]);
              const previous = files.find((file) => file.name === filename);
              if (previous && previous.content !== content) {
                throw new Error(`Conflicting ConfigMap file: ${filename}.`);
              }
              if (!previous) {
                files.push({ name: filename, content });
              }
            }
            const subPath = mount.subPath ? text(mount.subPath, 'ConfigMap subPath') : '';
            if (subPath && !selected.some((item) => item.path === subPath)) {
              throw new Error(`ConfigMap subPath ${subPath} is not a selected file.`);
            }
            // Separate files avoid unrelated ConfigMap keys leaking through directory mounts.
            const selectedFiles = subPath ? selected.filter((item) => item.path === subPath) : selected;
            for (const item of selectedFiles) {
              mounts.push({
                type: 'bind',
                source: `./${root}/${String(item.path)}`,
                target: subPath ? mountPath : `${mountPath.replace(/\/$/, '')}/${String(item.path)}`,
                readOnly: true,
              });
            }
            if (
              config.defaultMode !== undefined ||
              selected.some((item) => item.mode !== undefined) ||
              referenced.binaryData !== undefined
            ) {
              warn(`${containerId}: ConfigMap file modes and binaryData are not converted.`);
            }
          } else if (object(volume.secret).secretName && podmanTarget) {
            const secret = object(volume.secret);
            const referenced = find(ns, 'Secret', secret.secretName);
            const keys = Object.keys({ ...object(referenced?.data), ...object(referenced?.stringData) });
            if (!referenced && secret.items === undefined) {
              throw new Error(
                `${containerId}: include Secret ${String(secret.secretName)} or list its volume items to resolve mounted keys.`,
              );
            }
            const selected: ObjectValue[] =
              secret.items === undefined ? keys.map((key) => ({ key, path: key })) : items(secret.items);
            const subPath = mount.subPath ? text(mount.subPath, 'Secret subPath') : '';
            if (subPath && !selected.some((item) => item.path === subPath)) {
              throw new Error(`Secret subPath ${subPath} is not a selected file.`);
            }
            for (const item of selected.filter((item) => !subPath || item.path === subPath)) {
              const path = text(item.path, 'Secret item path');
              if (
                path.startsWith('/') ||
                path.split('/').some((part) => ['..', '.', ''].includes(part)) ||
                /[,\\]/.test(path)
              ) {
                throw new Error(`Unsafe Secret item path: ${path}.`);
              }
              const mode = Number(item.mode ?? secret.defaultMode ?? 0o644);
              if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
                throw new Error('Secret file mode must be between 0000 and 0777.');
              }
              secretMounts.push({
                reference: secretRef(ns, secret.secretName, item.key),
                target: subPath ? mountPath : `${mountPath.replace(/\/$/, '')}/${path}`,
                mode,
                uid: Number(security.runAsUser ?? 0),
                gid: Number(security.runAsGroup ?? podSecurity.fsGroup ?? 0),
              });
            }
          } else {
            warn(
              `${containerId}: volume ${String(mount.name)} uses an unsupported source (such as Secret, projected or CSI); the mount is omitted.`,
            );
          }
        }
        for (const key of Object.keys(environment)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
            throw new Error(`Unsupported environment variable name: ${key}.`);
          }
        }
        const image = text(raw.image, `${containerId} image`);
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@+-]*$/.test(image)) {
          throw new Error(`${containerId}: invalid image reference.`);
        }
        const entrypoint = args(raw.command);
        const command = args(raw.args);
        if (
          [...Object.values(environment), ...(entrypoint ?? []), ...(command ?? [])].some((value) =>
            value?.includes('$('),
          )
        ) {
          warn(`${containerId}: Kubernetes $(VAR) expansion is not performed; review environment values and commands.`);
        }
        workload.containers.push({
          id: containerId,
          image,
          environment,
          secretEnvironment,
          secretMounts,
          init,
          chownVolumes: podmanTarget && podSecurity.fsGroup !== undefined,
          entrypoint,
          command,
          mounts,
          security,
          user,
          workingDir: raw.workingDir === undefined ? undefined : safePath(raw.workingDir),
          memory: limits.memory === undefined ? undefined : quantity(limits.memory),
          cpus: limits.cpu === undefined ? undefined : quantity(limits.cpu, true),
        });
        workload.declaredPorts.push(...items(raw.ports));
        for (const containerPort of items(raw.ports)) {
          if (containerPort.hostPort !== undefined) {
            workload.ports.push({
              host: port(containerPort.hostPort),
              target: port(containerPort.containerPort),
              protocol: String(containerPort.protocol ?? 'TCP').toLowerCase(),
              hostIP: String(containerPort.hostIP ?? '127.0.0.1'),
            });
          }
        }
      }
      workloads.push(workload);
    }
    if (!workloads.length) {
      throw new Error(
        'No supported workloads found. Include a Pod, Deployment, StatefulSet, DaemonSet, Job or CronJob.',
      );
    }
    for (const service of resources.filter((resource) => resource.kind === 'Service')) {
      const spec = object(service.spec);
      const selector = object(spec.selector);
      const matched = workloads.filter(
        (workload) =>
          workload.namespace === namespace(service) &&
          Object.keys(selector).length &&
          Object.entries(selector).every(([key, value]) => workload.labels[key] === value),
      );
      if (!matched.length) {
        warn(`Service/${name(service)} has no matching local workload; it is omitted.`);
        continue;
      }
      if (matched.length > 1) {
        warn(
          `Service/${name(service)} selects multiple workloads; DNS aliases do not reproduce Kubernetes load balancing.`,
        );
      }
      const servicePorts = items(spec.ports).map((servicePort) => {
        const targets = matched.map((workload) => {
          const targetPort = servicePort.targetPort ?? servicePort.port;
          const namedPort = workload.declaredPorts.find((containerPort) => containerPort.name === targetPort);
          if (typeof targetPort === 'string' && !namedPort) {
            throw new Error(`Service/${name(service)} targetPort ${targetPort} is unresolved.`);
          }
          return { workload, port: port(typeof targetPort === 'string' ? namedPort?.containerPort : targetPort) };
        });
        return {
          source: port(servicePort.port),
          protocol: String(servicePort.protocol ?? 'TCP').toLowerCase(),
          nodePort: servicePort.nodePort,
          targets,
        };
      });
      const remapped = servicePorts.some((servicePort) =>
        servicePort.targets.some((target) => target.port !== servicePort.source),
      );
      let endpoints = matched;
      if (
        remapped &&
        servicePorts.every((servicePort) => servicePort.protocol === 'tcp') &&
        matched.every((workload) => !workload.hostNetwork)
      ) {
        const proxyId = identity(namespace(service), `service-${name(service)}`);
        if (workloads.some((workload) => workload.id === proxyId)) {
          throw new Error(`Service proxy name collision: ${proxyId}.`);
        }
        const configPath = `config/${proxyId}/haproxy.cfg`;
        const config = [
          'global',
          '  log stdout format raw local0',
          'defaults',
          '  mode tcp',
          '  timeout connect 5s',
          '  timeout client 1h',
          '  timeout server 1h',
          'resolvers localdns',
          '  parse-resolv-conf',
          '  hold valid 5s',
        ];
        for (const servicePort of servicePorts) {
          config.push(`listen port-${servicePort.source}`, `  bind :${servicePort.source}`);
          for (const [index, endpoint] of servicePort.targets.entries()) {
            endpoint.workload.aliases.push(endpoint.workload.id);
            config.push(
              `  server backend-${index} ${endpoint.workload.id}:${endpoint.port} resolvers localdns resolve-prefer ipv4 init-addr last,libc,none`,
            );
          }
        }
        files.push({ name: configPath, content: `${config.join('\n')}\n` });
        const proxy: Workload = {
          id: proxyId,
          name: `service-${name(service)}`,
          namespace: namespace(service),
          labels: {},
          containers: [
            {
              id: proxyId,
              image: 'docker.io/library/haproxy:3.2-alpine',
              environment: {},
              secretEnvironment: {},
              secretMounts: [],
              init: false,
              chownVolumes: false,
              mounts: [
                {
                  type: 'bind',
                  source: `./${configPath}`,
                  target: '/usr/local/etc/haproxy/haproxy.cfg',
                  readOnly: true,
                },
              ],
              user: '0',
              security: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'], add: ['NET_BIND_SERVICE'] } },
            },
          ],
          aliases: [],
          ports: [],
          declaredPorts: [],
          restart: 'Always',
          hostNetwork: false,
        };
        workloads.push(proxy);
        endpoints = [proxy];
        warn(
          `Service/${name(service)}: a local HAProxy TCP service preserves Service ports and DNS; Kubernetes readiness and load-balancing policies are not reproduced.`,
        );
      } else if (remapped) {
        warn(
          `Service/${name(service)}: non-TCP or host-network port translation is not supported; clients must use the target container ports.`,
        );
      }
      for (const workload of endpoints) {
        workload.aliases.push(
          name(service),
          `${name(service)}.${workload.namespace}`,
          `${name(service)}.${workload.namespace}.svc`,
          `${name(service)}.${workload.namespace}.svc.cluster.local`,
        );
        for (const servicePort of servicePorts) {
          if (servicePort.nodePort !== undefined && endpoints.length === 1) {
            workload.ports.push({
              host: port(servicePort.nodePort),
              target: endpoints === matched ? servicePort.targets[0].port : servicePort.source,
              protocol: servicePort.protocol,
              hostIP: '127.0.0.1',
            });
          }
        }
      }
      if (spec.type === 'LoadBalancer' || spec.externalIPs !== undefined) {
        warn(`Service/${name(service)}: external addresses and load-balancer provisioning are not converted.`);
      }
    }
    for (const workload of workloads) {
      workload.aliases = [...new Set(workload.aliases)];
      if (workload.hostNetwork) {
        workload.ports = [];
        workload.aliases = [];
      }
    }
    const bindings = new Set<string>();
    for (const workload of workloads) {
      workload.ports = workload.ports.filter(
        (published, index, all) =>
          index === all.findIndex((other) => JSON.stringify(other) === JSON.stringify(published)),
      );
      for (const published of workload.ports) {
        if (!['tcp', 'udp', 'sctp'].includes(published.protocol) || !/^[\da-fA-F:.]+$/.test(published.hostIP)) {
          throw new Error('Unsupported published port protocol or host IP.');
        }
        const key = `${published.hostIP}:${published.host}/${published.protocol}`;
        if (bindings.has(key)) {
          throw new Error(`Host port collision: ${key}. Change one hostPort or nodePort.`);
        }
        bindings.add(key);
      }
    }
    secretReferences.clear();
    for (const workload of workloads) {
      for (const container of workload.containers) {
        for (const ref of [
          ...Object.values(container.secretEnvironment),
          ...container.secretMounts.map((mount) => mount.reference),
        ]) {
          secretReferences.set(ref.podmanName, ref);
        }
      }
    }
    if (secretReferences.size) {
      if (podmanTarget) {
        warn(
          'Secret values are excluded from this bundle. Import the exact rendered Secret values with python3 import-secrets.py secrets.json before starting containers. Secret rotation requires recreating consumers.',
        );
        files.push(
          { name: 'secret-references.json', content: `${JSON.stringify([...secretReferences.values()], null, 2)}\n` },
          { name: 'import-secrets.py', content: secretBootstrap },
        );
      } else {
        warn(
          'Secret values are excluded. Supply Secret env values through the host environment; Secret file mounts are not supported for this output. Use Quadlet or Podman run to preserve Secret references.',
        );
        for (const workload of workloads) {
          for (const container of workload.containers) {
            for (const [envKey, ref] of Object.entries(container.secretEnvironment)) {
              warn(`${container.id}: ${envKey} refers to Secret ${ref.namespace}/${ref.name} key ${ref.key}.`);
            }
          }
        }
      }
    }
    if (target === 'compose') {
      files.unshift({ name: 'compose.yaml', content: renderCompose(workloads, volumes) });
    } else if (target === 'quadlet') {
      files.unshift(...renderQuadlet(workloads, volumes, quadletOptions));
    } else {
      files.unshift({
        name: `${target}.sh`,
        content: renderRun(workloads, volumes, target === 'podman-run' ? 'podman' : 'docker'),
      });
    }
    return { files, warnings: [...warnings], errors: [], secretReferences: [...secretReferences.values()] };
  } catch (error) {
    return { files: [], warnings: [...warnings], errors: [error instanceof Error ? error.message : String(error)] };
  }
}

function renderCompose(workloads: Workload[], volumes: Set<string>): string {
  const services: ObjectValue = Object.create(null);
  for (const workload of workloads) {
    const primary = workload.containers.find((container) => !container.init)!;
    const initializers = workload.containers.filter((container) => container.init);
    for (const container of workload.containers) {
      const security = container.security;
      const service: ObjectValue = {
        image: container.image,
        restart: container.init ? 'no' : { Always: 'always', OnFailure: 'on-failure', Never: 'no' }[workload.restart],
      };
      if (Object.keys(container.environment).length) {
        service.environment = container.environment;
      }
      if (container.entrypoint !== undefined) {
        service.entrypoint = container.entrypoint;
      }
      if (container.command !== undefined) {
        service.command = container.command;
      }
      if (container.workingDir) {
        service.working_dir = container.workingDir;
      }
      if (container.user) {
        service.user = container.user;
      }
      if (container.memory !== undefined) {
        service.mem_limit = container.memory;
      }
      if (container.cpus !== undefined) {
        service.cpus = container.cpus;
      }
      if (security.readOnlyRootFilesystem !== undefined) {
        service.read_only = security.readOnlyRootFilesystem;
      }
      if (security.privileged !== undefined) {
        service.privileged = security.privileged;
      }
      if (security.allowPrivilegeEscalation === false) {
        service.security_opt = ['no-new-privileges:true'];
      }
      const capabilities = object(security.capabilities);
      if (capabilities.add !== undefined) {
        service.cap_add = args(capabilities.add);
      }
      if (capabilities.drop !== undefined) {
        service.cap_drop = args(capabilities.drop);
      }
      if (container.mounts.length) {
        service.volumes = container.mounts.map((mount) => ({
          type: mount.type,
          source: mount.source,
          target: mount.target,
          read_only: mount.readOnly,
          ...(mount.type === 'bind'
            ? {
                bind: { create_host_path: false },
              }
            : {}),
        }));
      }
      if (!container.init && container !== primary) {
        service.network_mode = `service:${primary.id}`;
        service.depends_on = initializers.length
          ? {
              [primary.id]: { condition: 'service_started' },
              ...Object.fromEntries(
                initializers.map((init) => [init.id, { condition: 'service_completed_successfully' }]),
              ),
            }
          : [primary.id];
      } else if (workload.hostNetwork) {
        service.network_mode = 'host';
      } else {
        if (workload.declaredPorts.length) {
          service.expose = [
            ...new Set(
              workload.declaredPorts.map(
                (declared) => `${port(declared.containerPort)}/${String(declared.protocol ?? 'TCP').toLowerCase()}`,
              ),
            ),
          ];
        }
        if (workload.aliases.length) {
          service.networks = {
            default: { aliases: workload.aliases },
          };
        }
        if (workload.ports.length) {
          service.ports = workload.ports.map((published) => ({
            target: published.target,
            published: String(published.host),
            host_ip: published.hostIP,
            protocol: published.protocol,
          }));
        }
      }
      if (container.init) {
        const previous = initializers[initializers.indexOf(container) - 1];
        if (previous) {
          service.depends_on = { [previous.id]: { condition: 'service_completed_successfully' } };
        }
      } else if (container === primary && initializers.length) {
        service.depends_on = Object.fromEntries(
          initializers.map((init) => [init.id, { condition: 'service_completed_successfully' }]),
        );
      }
      services[container.id] = service;
    }
  }
  return stringify(
    composeLiteral({
      services,
      ...(volumes.size ? { volumes: Object.fromEntries([...volumes].map((volume) => [volume, {}])) } : {}),
    }),
  );
}

function renderQuadlet(workloads: Workload[], volumes: Set<string>, overrides: Partial<QuadletOptions>): OutputFile[] {
  const options = { ...defaultQuadletOptions, ...overrides };
  const description = options.description.trim()
    ? text(options.description, 'Quadlet description').replace(/\\/g, '\\\\').replace(/%/g, '%%')
    : '';
  const units = (values: string[], label: string) => [
    ...new Set(
      values.map((value) => {
        if (
          !/^[a-zA-Z0-9_.:@-]+\.(?:target|service|socket|mount|automount|path|timer|slice|scope|container|pod|network|volume)$/.test(
            value,
          )
        ) {
          throw new Error(`${label} must contain systemd unit names, such as network-online.target.`);
        }
        return value;
      }),
    ),
  ];
  const after = units(options.after, 'After targets');
  const wants = units(options.wants, 'Wants targets');
  const wantedBy = units(options.wantedBy, 'WantedBy');
  if (!['manifest', 'no', 'always', 'on-failure'].includes(options.restart)) {
    throw new Error('Unsupported Quadlet restart policy.');
  }

  const files: OutputFile[] = [{ name: 'kubernetes-local.network', content: '[Network]\n' }];
  for (const volume of volumes) {
    files.push({ name: `${volume}.volume`, content: `[Volume]\nVolumeName=${volume}\n` });
  }
  for (const workload of workloads) {
    const pod = [
      '[Pod]',
      `PodName=${workload.id}`,
      `Network=${workload.hostNetwork ? 'host' : 'kubernetes-local.network'}`,
    ];
    // Keep the network namespace alive through init completion and container restarts.
    pod.push('ExitPolicy=continue');
    pod.push(...workload.aliases.map((alias) => `NetworkAlias=${alias}`));
    pod.push(
      ...workload.ports.map(
        (published) =>
          `PublishPort=${published.hostIP.includes(':') ? `[${published.hostIP}]` : published.hostIP}:${published.host}:${published.target}/${published.protocol}`,
      ),
    );
    files.push({ name: `${workload.id}.pod`, content: `${pod.join('\n')}\n` });
    for (const container of workload.containers) {
      const initializers = workload.containers.filter((candidate) => candidate.init);
      const previous = initializers[initializers.indexOf(container) - 1];
      const dependencies = container.init ? (previous ? [previous] : []) : initializers;
      const lines = [
        '[Unit]',
        `Description=${description || `Kubernetes workload ${container.id}`}`,
        ...after.map((unit) => `After=${unit}`),
        ...wants.map((unit) => `Wants=${unit}`),
        ...dependencies.flatMap((dependency) => [
          `Requires=${dependency.id}.container`,
          `After=${dependency.id}.container`,
        ]),
        '',
        '[Container]',
        `Image=${container.image}`,
        `Pod=${workload.id}.pod`,
      ];
      for (const [key, value] of Object.entries(container.environment)) {
        if (!container.secretEnvironment[key]) {
          lines.push(
            value === null ? `PodmanArgs=--env ${unitWord(key)}` : `Environment=${unitWord(`${key}=${value}`)}`,
          );
        }
      }
      lines.push(...podmanSecrets(container).map((secret) => `Secret=${secret.replace(/%/g, '%%')}`));
      if (container.entrypoint !== undefined) {
        lines.push(`Entrypoint=${JSON.stringify(container.entrypoint).replace(/%/g, '%%')}`);
      }
      if (container.command !== undefined) {
        lines.push(`Exec=${container.command.map(unitWord).join(' ')}`);
      }
      if (container.workingDir) {
        lines.push(`WorkingDir=${container.workingDir.replace(/%/g, '%%')}`);
      }
      if (container.user) {
        const [user, group] = container.user.split(':');
        lines.push(`User=${user}`);
        if (group) {
          lines.push(`Group=${group}`);
        }
      }
      if (container.memory !== undefined) {
        lines.push(`Memory=${container.memory}`);
      }
      if (container.cpus !== undefined) {
        lines.push(`PodmanArgs=--cpus=${container.cpus}`);
      }
      if (container.security.readOnlyRootFilesystem !== undefined) {
        lines.push(`ReadOnly=${String(container.security.readOnlyRootFilesystem)}`, 'ReadOnlyTmpfs=false');
      }
      if (container.security.privileged !== undefined) {
        lines.push(`PodmanArgs=--privileged=${String(container.security.privileged)}`);
      }
      if (container.security.allowPrivilegeEscalation === false) {
        lines.push('NoNewPrivileges=true');
      }
      const capabilities = object(container.security.capabilities);
      for (const capability of args(capabilities.add) ?? []) {
        lines.push(`AddCapability=${unitWord(capability)}`);
      }
      for (const capability of args(capabilities.drop) ?? []) {
        lines.push(`DropCapability=${unitWord(capability)}`);
      }
      for (const mount of container.mounts) {
        lines.push(
          `Volume=${`${mount.source}${mount.type === 'volume' ? '.volume' : ''}:${mount.target}${mount.readOnly ? ':ro' : mount.type === 'volume' && container.chownVolumes ? ':U' : ''}`.replace(/%/g, '%%')}`,
        );
      }
      lines.push(
        '',
        '[Service]',
        ...(container.init
          ? ['Type=oneshot', 'RemainAfterExit=yes', 'Restart=no']
          : [
              `Restart=${options.restart === 'manifest' ? { Always: 'always', OnFailure: 'on-failure', Never: 'no' }[workload.restart] : options.restart}`,
            ]),
        'TimeoutStartSec=900',
      );
      if (!container.init && wantedBy.length) {
        lines.push('', '[Install]', ...wantedBy.map((unit) => `WantedBy=${unit}`));
      }
      files.push({ name: `${container.id}.container`, content: `${lines.join('\n')}\n` });
    }
  }
  const startUnits = workloads.flatMap((workload) =>
    workload.containers.filter((container) => !container.init).map((container) => `${container.id}.service`),
  );
  files.push({
    name: 'start-quadlets.sh',
    content: `#!/usr/bin/env bash\nset -euo pipefail\nsystemctl --user daemon-reload\nsystemctl --user start ${startUnits.map(shellWord).join(' ')}\n`,
  });
  return files;
}

function podmanSecrets(container: Container): string[] {
  return [
    ...Object.entries(container.secretEnvironment).map(([key, ref]) => `${ref.podmanName},type=env,target=${key}`),
    ...container.secretMounts.map(
      (mount) =>
        `${mount.reference.podmanName},type=mount,target=${mount.target},uid=${mount.uid},gid=${mount.gid},mode=${mount.mode.toString(8).padStart(4, '0')}`,
    ),
  ];
}

// Kept separate from normal conversion so values never appear in the output list or ZIP.
export function exportKubernetesSecrets(input: string): string {
  const documents = parseAllDocuments(input, { uniqueKeys: true });
  const resources: ObjectValue[] = [];
  const add = (value: unknown) => {
    const resource = object(value);
    if (resource.kind === 'List') {
      items(resource.items).forEach(add);
    } else if (resource.kind === 'Secret') {
      resources.push({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: name(resource), namespace: namespace(resource) },
        data: object(resource.data),
        stringData: object(resource.stringData),
      });
    }
  };
  for (const document of documents) {
    if (document.errors.length) {
      throw new Error('Cannot export Secrets from invalid YAML.');
    }
    add(document.toJS({ maxAliasCount: 100 }));
  }
  return `${JSON.stringify({ apiVersion: 'v1', kind: 'List', items: resources }, null, 2)}\n`;
}

function shellWord(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function renderRun(workloads: Workload[], volumes: Set<string>, runtime: 'docker' | 'podman'): string {
  const lines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    '# Run from the extracted bundle directory; bind mounts are resolved from here.',
    'cd -- "$(dirname -- "$0")"',
    'bundle_dir="$PWD"',
    '',
    `${runtime} network inspect kubernetes-local >/dev/null 2>&1 || ${runtime} network create kubernetes-local`,
  ];
  for (const volume of volumes) {
    lines.push(`${runtime} volume create ${shellWord(volume)}`);
  }
  for (const workload of workloads) {
    const published = workload.ports.map(
      (binding) =>
        `${binding.hostIP.includes(':') ? `[${binding.hostIP}]` : binding.hostIP}:${binding.host}:${binding.target}/${binding.protocol}`,
    );
    if (runtime === 'podman') {
      const podArgs = [
        'podman',
        'pod',
        'create',
        '--name',
        shellWord(workload.id),
        '--network',
        shellWord(workload.hostNetwork ? 'host' : 'kubernetes-local'),
      ];
      podArgs.push('--exit-policy=continue');
      for (const alias of workload.aliases) {
        podArgs.push('--network-alias', shellWord(alias));
      }
      for (const binding of published) {
        podArgs.push('--publish', shellWord(binding));
      }
      lines.push('', podArgs.join(' '));
    }
    for (const container of workload.containers) {
      const primary = workload.containers.find((candidate) => !candidate.init)!;
      const command = [runtime, 'run', container.init ? '--rm' : '--detach', '--name', shellWord(container.id)];
      if (!container.init) {
        command.push(
          '--restart',
          shellWord({ Always: 'always', OnFailure: 'on-failure', Never: 'no' }[workload.restart] ?? 'always'),
        );
      }
      if (runtime === 'podman') {
        command.push('--pod', shellWord(workload.id));
      } else {
        command.push(
          '--network',
          shellWord(
            !container.init && container !== primary
              ? `container:${primary.id}`
              : workload.hostNetwork
                ? 'host'
                : 'kubernetes-local',
          ),
        );
        if (container === primary) {
          for (const alias of workload.aliases) {
            command.push('--network-alias', shellWord(alias));
          }
          for (const binding of published) {
            command.push('--publish', shellWord(binding));
          }
        }
      }
      for (const [key, value] of Object.entries(container.environment)) {
        if (runtime !== 'podman' || !container.secretEnvironment[key]) {
          command.push('--env', shellWord(value === null ? key : `${key}=${value}`));
        }
      }
      if (runtime === 'podman') {
        for (const secret of podmanSecrets(container)) {
          command.push('--secret', shellWord(secret));
        }
      }
      if (container.workingDir) {
        command.push('--workdir', shellWord(container.workingDir));
      }
      if (container.user) {
        command.push('--user', shellWord(container.user));
      }
      if (container.memory !== undefined) {
        command.push('--memory', String(container.memory));
      }
      if (container.cpus !== undefined) {
        command.push('--cpus', String(container.cpus));
      }
      if (container.security.readOnlyRootFilesystem === true) {
        command.push('--read-only');
        if (runtime === 'podman') {
          command.push('--read-only-tmpfs=false');
        }
      }
      if (container.security.privileged === true) {
        command.push('--privileged');
      }
      if (container.security.allowPrivilegeEscalation === false) {
        command.push('--security-opt', shellWord('no-new-privileges'));
      }
      const capabilities = object(container.security.capabilities);
      for (const capability of args(capabilities.add) ?? []) {
        command.push('--cap-add', shellWord(capability));
      }
      for (const capability of args(capabilities.drop) ?? []) {
        command.push('--cap-drop', shellWord(capability));
      }
      for (const mount of container.mounts) {
        // Only this trusted prefix is evaluated by the shell; manifest paths stay quoted.
        const source = mount.source.startsWith('./')
          ? `"$bundle_dir"/${shellWord(mount.source.slice(2))}`
          : shellWord(mount.source);
        if (mount.type === 'bind') {
          command.push(
            '--mount',
            `${shellWord('type=bind,source=')}${source}${shellWord(`,target=${mount.target}${mount.readOnly ? ',readonly' : ''}`)}`,
          );
        } else {
          command.push(
            '--volume',
            shellWord(
              `${mount.source}:${mount.target}${mount.readOnly ? ':ro' : runtime === 'podman' && container.chownVolumes ? ':U' : ''}`,
            ),
          );
        }
      }
      const entrypoint = container.entrypoint;
      if (entrypoint !== undefined) {
        command.push('--entrypoint', shellWord(entrypoint[0] ?? ''));
      }
      command.push(shellWord(container.image));
      command.push(...[...(entrypoint?.slice(1) ?? []), ...(container.command ?? [])].map(shellWord));
      lines.push('', formatRunCommand(command));
    }
  }
  return `${lines.join('\n')}\n`;
}

function formatRunCommand(command: string[]): string {
  const lines = [command.slice(0, 3).join(' ')];
  for (let index = 3; index < command.length; index++) {
    const word = command[index];
    if (!word.startsWith('--')) {
      lines.push(command.slice(index).join(' '));
      break;
    }
    if (!word.includes('=') && !['--read-only', '--privileged', '--rm'].includes(word)) {
      lines.push(`${word} ${command[++index]}`);
    } else {
      lines.push(word);
    }
  }
  return lines.join(' \\\n  ');
}
