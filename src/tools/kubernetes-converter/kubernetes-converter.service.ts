import { parseAllDocuments, stringify } from 'yaml';

export type ConversionTarget = 'compose' | 'quadlet' | 'docker-run' | 'podman-run';
export interface OutputFile { name: string; content: string }
export interface ConversionResult { files: OutputFile[]; warnings: string[]; errors: string[] }
type ObjectValue = Record<string, unknown>;
interface Mount { type: 'bind' | 'volume'; source: string; target: string; readOnly: boolean }
interface Container {
  id: string
  image: string
  environment: Record<string, string | null>
  entrypoint?: string[]
  command?: string[]
  workingDir?: string
  mounts: Mount[]
  security: ObjectValue
  user?: string
  memory?: number
  cpus?: number
}
interface PublishedPort { host: number; target: number; protocol: string; hostIP: string }
interface Workload {
  id: string
  name: string
  namespace: string
  labels: ObjectValue
  containers: Container[]
  aliases: string[]
  ports: PublishedPort[]
  declaredPorts: ObjectValue[]
  restart: string
  hostNetwork: boolean
}

const object = (value: unknown): ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const items = (value: unknown): ObjectValue[] => Array.isArray(value) ? value.map(object) : [];
const namespace = (resource: ObjectValue) => String(object(resource.metadata).namespace ?? 'default');
const name = (resource: ObjectValue) => text(object(resource.metadata).name, `${resource.kind} metadata.name`);
const identity = (ns: string, value: string) => `${ns}-${value}`;

function text(value: unknown, context: string): string {
  if (typeof value !== 'string' || !value.length || /[\r\n\0]/.test(value)) {
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
  if (!Array.isArray(value) || value.some(arg => typeof arg !== 'string')) {
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

export function convertKubernetes(input: string, target: ConversionTarget): ConversionResult {
  const warnings = new Set<string>();
  const files: OutputFile[] = [];
  const volumes = new Set<string>();
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
      }
      else if (value !== null && Object.keys(resource).length === 0) {
        throw new Error('Each YAML document must be a Kubernetes resource object.');
      }
      else if (Object.keys(resource).length) {
        if (!resource.kind || !resource.apiVersion) {
          throw new Error('Each manifest must have apiVersion and kind. Render Helm templates before converting.');
        }
        resources.push(resource);
      }
    };
    for (const document of documents) {
      if (document.errors.length) {
        throw new Error(document.errors.map(error => error.message).join('\n'));
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
    const find = (ns: string, kind: string, resourceName: unknown) => lookup.get(`${ns}/${kind}/${String(resourceName)}`);
    const workloads: Workload[] = [];
    for (const resource of resources) {
      const kind = String(resource.kind);
      if (['Service', 'ConfigMap', 'Secret', 'PersistentVolumeClaim', 'Namespace'].includes(kind)) {
        if (kind === 'Secret') {
          warn('Secret values are not exported. Supply referenced environment variables and secret mounts separately.');
        }
        continue;
      }
      if (!['Pod', 'Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'ReplicaSet', 'ReplicationController'].includes(kind)) {
        warn(`${kind}/${name(resource)} is not converted.`);
        continue;
      }
      const ns = namespace(resource);
      const resourceName = name(resource);
      const id = identity(ns, resourceName);
      if (workloads.some(workload => workload.id === id)) {
        throw new Error(`Workload output name collision: ${id}. Rename one workload.`);
      }
      const spec = object(resource.spec);
      const template = kind === 'CronJob' ? object(object(object(spec.jobTemplate).spec).template) : object(spec.template);
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
      const supportedPodFields = new Set(['containers', 'volumes', 'securityContext', 'restartPolicy', 'hostNetwork']);
      for (const key of Object.keys(pod)) {
        if (!supportedPodFields.has(key)) {
          warn(`${id}: ${key} is not converted.`);
        }
      }
      const podSecurity = object(pod.securityContext);
      for (const key of ['fsGroup', 'fsGroupChangePolicy', 'supplementalGroups', 'sysctls', 'seLinuxOptions', 'seccompProfile', 'runAsNonRoot']) {
        if (podSecurity[key] !== undefined) {
          warn(`${id}: Pod securityContext.${key} is not converted.`);
        }
      }
      const restart = String(pod.restartPolicy ?? 'Always');
      if (!['Always', 'OnFailure', 'Never'].includes(restart)) {
        throw new Error(`${id}: invalid restartPolicy ${restart}.`);
      }
      const workload: Workload = { id, name: resourceName, namespace: ns, labels, containers: [], aliases: [], ports: [], declaredPorts: [], restart, hostNetwork: pod.hostNetwork === true };
      if (workload.hostNetwork) {
        warn(`${id}: hostNetwork is retained; published ports and network aliases are omitted.`);
      }
      const podVolumes = items(pod.volumes);
      for (const claim of items(spec.volumeClaimTemplates)) {
        podVolumes.push({ name: name(claim), persistentVolumeClaim: { claimName: `${resourceName}-${name(claim)}` } });
        warn(`${id}: volumeClaimTemplate ${name(claim)} becomes a local named volume; storage provisioning and existing data are not migrated.`);
      }
      for (const raw of items(pod.containers)) {
        const containerName = safeName(text(raw.name, `${id} container name`));
        const containerId = pod.containers.length === 1 ? id : `${id}-${containerName}`;
        if (workload.containers.some(container => container.id === containerId)) {
          throw new Error(`${id}: duplicate container ${containerName}.`);
        }
        const environment: Record<string, string | null> = Object.create(null);
        for (const source of items(raw.envFrom)) {
          const config = object(source.configMapRef);
          const secret = object(source.secretRef);
          const isSecret = Boolean(secret.name);
          const referenced = find(ns, isSecret ? 'Secret' : 'ConfigMap', isSecret ? secret.name : config.name);
          if (!referenced) {
            warn(`${containerId}: envFrom ${String(secret.name ?? config.name)} is missing; its environment variables are omitted.`);
            continue;
          }
          const data = { ...object(referenced.data), ...(isSecret ? object(referenced.stringData) : {}) };
          for (const [key, value] of Object.entries(data)) {
            environment[`${String(source.prefix ?? '')}${key}`] = isSecret ? null : String(value);
          }
          if (isSecret) {
            warn(`${containerId}: secret envFrom values must be supplied through the host environment.`);
          }
        }
        for (const variable of items(raw.env)) {
          const variableName = text(variable.name, 'Environment variable name');
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variableName)) {
            throw new Error(`Unsupported environment variable name: ${variableName}.`);
          }
          if (variable.value !== undefined) {
            environment[variableName] = String(variable.value);
          }
          else {
            const reference = object(variable.valueFrom);
            const config = object(reference.configMapKeyRef);
            const data = object(find(ns, 'ConfigMap', config.name)?.data);
            const value = data[String(config.key)];
            environment[variableName] = config.name && value !== undefined ? String(value) : null;
            if (environment[variableName] === null) {
              warn(`${containerId}: ${variableName} has an unresolved valueFrom reference; supply it through the host environment.`);
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
        const user = security.runAsUser === undefined ? undefined : `${String(security.runAsUser)}${security.runAsGroup === undefined ? '' : `:${String(security.runAsGroup)}`}`;
        for (const key of ['runAsNonRoot', 'seccompProfile', 'seLinuxOptions', 'procMount', 'windowsOptions']) {
          if (object(raw.securityContext)[key] !== undefined) {
            warn(`${containerId}: securityContext.${key} is not converted.`);
          }
        }
        if (!user && security.runAsGroup !== undefined) {
          warn(`${containerId}: runAsGroup without runAsUser is not converted.`);
        }
        const supportedContainerFields = new Set(['name', 'image', 'env', 'envFrom', 'command', 'args', 'workingDir', 'ports', 'resources', 'securityContext', 'volumeMounts']);
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
          const volume = podVolumes.find(volume => volume.name === mount.name);
          if (!volume) {
            throw new Error(`${containerId}: volume ${String(mount.name)} is missing.`);
          }
          const mountPath = safePath(mount.mountPath);
          if (mount.subPathExpr !== undefined || mount.mountPropagation !== undefined) {
            warn(`${containerId}: volume ${String(mount.name)} has unsupported subPathExpr or mountPropagation and is omitted.`);
            continue;
          }
          const claim = object(volume.persistentVolumeClaim);
          const host = object(volume.hostPath);
          const config = object(volume.configMap);
          if (claim.claimName || volume.emptyDir !== undefined) {
            if (mount.subPath !== undefined) {
              warn(`${containerId}: subPath on volume ${String(mount.name)} is not converted; the mount is omitted.`);
              continue;
            }
            const volumeId = claim.claimName ? identity(ns, safeName(String(claim.claimName))) : `${id}-${safeName(String(mount.name))}`;
            volumes.add(volumeId);
            mounts.push({ type: 'volume', source: volumeId, target: mountPath, readOnly: mount.readOnly === true });
            warn(claim.claimName
              ? `${volumeId}: local named volume is initially empty; PVC data, storage class and capacity are not migrated.`
              : `${volumeId}: emptyDir becomes a shared named volume; it persists until explicitly removed, and memory/size settings are not retained.`);
          }
          else if (host.path) {
            const path = safePath(host.path);
            if (mount.subPath !== undefined) {
              warn(`${containerId}: hostPath subPath is not converted; the mount is omitted.`);
              continue;
            }
            mounts.push({ type: 'bind', source: path, target: mountPath, readOnly: mount.readOnly === true });
            warn(`${containerId}: hostPath ${path} now refers to the local host; hostPath type checks are not reproduced.`);
          }
          else if (config.name) {
            const referenced = find(ns, 'ConfigMap', config.name);
            if (!referenced) {
              throw new Error(`${containerId}: ConfigMap ${String(config.name)} required by a mount is missing.`);
            }
            const data = object(referenced.data);
            const selected = config.items === undefined ? Object.keys(data).map(key => ({ key, path: key })) : items(config.items);
            const root = `config/${identity(ns, safeName(String(config.name)))}`;
            for (const item of selected) {
              const path = text(item.path, 'ConfigMap item path');
              if (path.startsWith('/') || path.split('/').some(part => ['..', '.', ''].includes(part)) || /[,\\]/.test(path)) {
                throw new Error(`Unsafe ConfigMap item path: ${path}.`);
              }
              if (data[String(item.key)] === undefined) {
                throw new Error(`ConfigMap ${String(config.name)} key ${String(item.key)} is missing.`);
              }
              const filename = `${root}/${path}`;
              const content = String(data[String(item.key)]);
              const previous = files.find(file => file.name === filename);
              if (previous && previous.content !== content) {
                throw new Error(`Conflicting ConfigMap file: ${filename}.`);
              }
              if (!previous) {
                files.push({ name: filename, content });
              }
            }
            const subPath = mount.subPath === undefined ? '' : text(mount.subPath, 'ConfigMap subPath');
            if (subPath && !selected.some(item => item.path === subPath)) {
              throw new Error(`ConfigMap subPath ${subPath} is not a selected file.`);
            }
            // Separate files avoid unrelated ConfigMap keys leaking through directory mounts.
            const selectedFiles = subPath ? selected.filter(item => item.path === subPath) : selected;
            for (const item of selectedFiles) {
              mounts.push({ type: 'bind', source: `./${root}/${String(item.path)}`, target: subPath ? mountPath : `${mountPath.replace(/\/$/, '')}/${String(item.path)}`, readOnly: true });
            }
            if (config.defaultMode !== undefined || selected.some(item => item.mode !== undefined) || referenced.binaryData !== undefined) {
              warn(`${containerId}: ConfigMap file modes and binaryData are not converted.`);
            }
          }
          else {
            warn(`${containerId}: volume ${String(mount.name)} uses an unsupported source (such as Secret, projected or CSI); the mount is omitted.`);
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
        if ([...Object.values(environment), ...(entrypoint ?? []), ...(command ?? [])].some(value => value?.includes('$('))) {
          warn(`${containerId}: Kubernetes $(VAR) expansion is not performed; review environment values and commands.`);
        }
        workload.containers.push({
          id: containerId,
          image,
          environment,
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
            workload.ports.push({ host: port(containerPort.hostPort), target: port(containerPort.containerPort), protocol: String(containerPort.protocol ?? 'TCP').toLowerCase(), hostIP: String(containerPort.hostIP ?? '127.0.0.1') });
          }
        }
      }
      workloads.push(workload);
    }
    if (!workloads.length) {
      throw new Error('No supported workloads found. Include a Pod, Deployment, StatefulSet, DaemonSet, Job or CronJob.');
    }
    for (const service of resources.filter(resource => resource.kind === 'Service')) {
      const spec = object(service.spec);
      const selector = object(spec.selector);
      const matched = workloads.filter(workload => workload.namespace === namespace(service) && Object.keys(selector).length && Object.entries(selector).every(([key, value]) => workload.labels[key] === value));
      if (!matched.length) {
        warn(`Service/${name(service)} has no matching local workload; it is omitted.`);
        continue;
      }
      if (matched.length > 1) {
        warn(`Service/${name(service)} selects multiple workloads; DNS aliases do not reproduce Kubernetes load balancing.`);
      }
      for (const workload of matched) {
        workload.aliases.push(name(service), `${name(service)}.${workload.namespace}`, `${name(service)}.${workload.namespace}.svc.cluster.local`);
        for (const servicePort of items(spec.ports)) {
          const targetPort = servicePort.targetPort ?? servicePort.port;
          const namedPort = workload.declaredPorts.find(containerPort => containerPort.name === targetPort);
          if (typeof targetPort === 'string' && !namedPort) {
            throw new Error(`Service/${name(service)} targetPort ${targetPort} is unresolved.`);
          }
          const resolved = port(typeof targetPort === 'string' ? namedPort?.containerPort : targetPort);
          if (Number(servicePort.port) !== resolved) {
            warn(`Service/${name(service)}: clients must use target port ${resolved}; service port ${String(servicePort.port)} is not remapped inside the local network.`);
          }
          if (servicePort.nodePort !== undefined && matched.length === 1) {
            workload.ports.push({ host: port(servicePort.nodePort), target: resolved, protocol: String(servicePort.protocol ?? 'TCP').toLowerCase(), hostIP: '127.0.0.1' });
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
      workload.ports = workload.ports.filter((published, index, all) => index === all.findIndex(other => JSON.stringify(other) === JSON.stringify(published)));
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
    if (target === 'compose') {
      files.unshift({ name: 'compose.yaml', content: renderCompose(workloads, volumes) });
    }
    else if (target === 'quadlet') {
      files.unshift(...renderQuadlet(workloads, volumes));
    }
    else {
      files.unshift({ name: `${target}.sh`, content: renderRun(workloads, volumes, target === 'podman-run' ? 'podman' : 'docker') });
    }
    return { files, warnings: [...warnings], errors: [] };
  }
  catch (error) {
    return { files: [], warnings: [...warnings], errors: [error instanceof Error ? error.message : String(error)] };
  }
}

function renderCompose(workloads: Workload[], volumes: Set<string>): string {
  const services: ObjectValue = Object.create(null);
  for (const workload of workloads) {
    for (const [index, container] of workload.containers.entries()) {
      const security = container.security;
      const service: ObjectValue = { image: container.image, restart: { Always: 'always', OnFailure: 'on-failure', Never: 'no' }[workload.restart] };
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
        service.volumes = container.mounts.map(mount => ({
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
      if (index > 0) {
        service.network_mode = `service:${workload.containers[0].id}`;
        service.depends_on = [workload.containers[0].id];
      }
      else if (workload.hostNetwork) {
        service.network_mode = 'host';
      }
      else {
        if (workload.declaredPorts.length) {
          service.expose = [...new Set(workload.declaredPorts.map(declared => `${port(declared.containerPort)}/${String(declared.protocol ?? 'TCP').toLowerCase()}`))];
        }
        if (workload.aliases.length) {
          service.networks = {
            default: { aliases: workload.aliases },
          };
        }
        if (workload.ports.length) {
          service.ports = workload.ports.map(published => ({ target: published.target, published: String(published.host), host_ip: published.hostIP, protocol: published.protocol }));
        }
      }
      services[container.id] = service;
    }
  }
  return stringify(composeLiteral({ services, ...(volumes.size ? { volumes: Object.fromEntries([...volumes].map(volume => [volume, {}])) } : {}) }));
}

function renderQuadlet(workloads: Workload[], volumes: Set<string>): OutputFile[] {
  const files: OutputFile[] = [{ name: 'kubernetes-local.network', content: '[Network]\n' }];
  for (const volume of volumes) {
    files.push({ name: `${volume}.volume`, content: `[Volume]\nVolumeName=${volume}\n` });
  }
  for (const workload of workloads) {
    const pod = ['[Pod]', `PodName=${workload.id}`, `Network=${workload.hostNetwork ? 'host' : 'kubernetes-local.network'}`];
    pod.push(...workload.aliases.map(alias => `NetworkAlias=${alias}`));
    pod.push(...workload.ports.map(published => `PublishPort=${published.hostIP.includes(':') ? `[${published.hostIP}]` : published.hostIP}:${published.host}:${published.target}/${published.protocol}`));
    files.push({ name: `${workload.id}.pod`, content: `${pod.join('\n')}\n` });
    for (const container of workload.containers) {
      const lines = ['[Unit]', `Description=Kubernetes workload ${container.id}`, '', '[Container]', `Image=${container.image}`, `Pod=${workload.id}.pod`];
      for (const [key, value] of Object.entries(container.environment)) {
        lines.push(`Environment=${unitWord(value === null ? key : `${key}=${value}`)}`);
      }
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
        lines.push(`Volume=${`${mount.source}${mount.type === 'volume' ? '.volume' : ''}:${mount.target}${mount.readOnly ? ':ro' : ''}`.replace(/%/g, '%%')}`);
      }
      lines.push('', '[Service]', `Restart=${{ Always: 'always', OnFailure: 'on-failure', Never: 'no' }[workload.restart]}`, 'TimeoutStartSec=900', '', '[Install]', 'WantedBy=default.target');
      files.push({ name: `${container.id}.container`, content: `${lines.join('\n')}\n` });
    }
  }
  return files;
}

function shellWord(value: string): string {
  return `'${value.replace(/'/g, '\'"\'"\'')}'`;
}

function renderRun(workloads: Workload[], volumes: Set<string>, runtime: 'docker' | 'podman'): string {
  const lines = ['#!/usr/bin/env bash', 'set -euo pipefail', '', '# Run from the extracted bundle directory; bind mounts are resolved from here.', 'cd -- "$(dirname -- "$0")"', 'bundle_dir="$PWD"', '', `${runtime} network inspect kubernetes-local >/dev/null 2>&1 || ${runtime} network create kubernetes-local`];
  for (const volume of volumes) {
    lines.push(`${runtime} volume create ${shellWord(volume)}`);
  }
  for (const workload of workloads) {
    const published = workload.ports.map(binding => `${binding.hostIP.includes(':') ? `[${binding.hostIP}]` : binding.hostIP}:${binding.host}:${binding.target}/${binding.protocol}`);
    if (runtime === 'podman') {
      const podArgs = ['podman', 'pod', 'create', '--name', shellWord(workload.id), '--network', shellWord(workload.hostNetwork ? 'host' : 'kubernetes-local')];
      for (const alias of workload.aliases) {
        podArgs.push('--network-alias', shellWord(alias));
      }
      for (const binding of published) {
        podArgs.push('--publish', shellWord(binding));
      }
      lines.push('', podArgs.join(' '));
    }
    for (const [index, container] of workload.containers.entries()) {
      const command = [runtime, 'run', '--detach', '--name', shellWord(container.id), '--restart', shellWord({ Always: 'always', OnFailure: 'on-failure', Never: 'no' }[workload.restart] ?? 'always')];
      if (runtime === 'podman') {
        command.push('--pod', shellWord(workload.id));
      }
      else {
        command.push('--network', shellWord(index > 0 ? `container:${workload.containers[0].id}` : workload.hostNetwork ? 'host' : 'kubernetes-local'));
        if (index === 0) {
          for (const alias of workload.aliases) {
            command.push('--network-alias', shellWord(alias));
          }
          for (const binding of published) {
            command.push('--publish', shellWord(binding));
          }
        }
      }
      for (const [key, value] of Object.entries(container.environment)) {
        command.push('--env', shellWord(value === null ? key : `${key}=${value}`));
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
        const source = mount.source.startsWith('./') ? `"$bundle_dir"/${shellWord(mount.source.slice(2))}` : shellWord(mount.source);
        if (mount.type === 'bind') {
          command.push('--mount', `${shellWord('type=bind,source=')}${source}${shellWord(`,target=${mount.target}${mount.readOnly ? ',readonly' : ''}`)}`);
        }
        else {
          command.push('--volume', shellWord(`${mount.source}:${mount.target}${mount.readOnly ? ':ro' : ''}`));
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
    if (!word.includes('=') && !['--read-only', '--privileged'].includes(word)) {
      lines.push(`${word} ${command[++index]}`);
    }
    else {
      lines.push(word);
    }
  }
  return lines.join(' \\\n  ');
}
