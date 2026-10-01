<script setup lang="ts">
import { strToU8, zipSync } from 'fflate';
import { refDebounced } from '@vueuse/core';
import { type ConversionTarget, convertKubernetes, exportKubernetesSecrets } from './kubernetes-converter.service';
import { exampleManifest, multiContainerExample } from './kubernetes-converter.examples';
import { manifestInput, quadletOptions } from './kubernetes-converter.state';
import TextareaCopyable from '@/components/TextareaCopyable.vue';

const props = defineProps<{ target: ConversionTarget }>();
const input = manifestInput;
const debouncedInput = refDebounced(input, 200);
const result = computed(() => convertKubernetes(debouncedInput.value, props.target, quadletOptions.value));
const restartOptions = [
  { label: 'From Kubernetes restartPolicy', value: 'manifest' },
  { label: 'no', value: 'no' },
  { label: 'always', value: 'always' },
  { label: 'on-failure', value: 'on-failure' },
];
const selectedFilename = ref('');
const selectedFile = computed(
  () =>
    result.value.files.find((file) => file.name === selectedFilename.value) ??
    result.value.files.find((file) => file.name.endsWith('.container')) ??
    result.value.files[0],
);
const options = computed(() => result.value.files.map((file) => ({ label: file.name, value: file.name })));
const language = computed(() =>
  selectedFile.value?.name.endsWith('.yaml') ? 'yaml' : selectedFile.value?.name.endsWith('.sh') ? 'bash' : 'toml',
);
const targets: { value: ConversionTarget; label: string; route: string }[] = [
  { value: 'compose', label: 'Compose', route: '/kubernetes-to-compose' },
  { value: 'quadlet', label: 'Quadlet', route: '/kubernetes-to-quadlet' },
  { value: 'docker-run', label: 'Docker run', route: '/kubernetes-to-docker-run' },
  { value: 'podman-run', label: 'Podman run', route: '/kubernetes-to-podman-run' },
];
const instructions = computed(() =>
  props.target === 'compose'
    ? 'Extract the bundle, then run docker compose up -d from that directory.'
    : props.target === 'quadlet'
      ? 'Extract all files into ~/.config/containers/systemd/, run systemctl --user daemon-reload, then run bash start-quadlets.sh. Requires Podman 5.8+ with pod Quadlet support.'
      : `Extract the bundle, then run bash ${props.target}.sh from that directory.`,
);

function downloadBytes(bytes: Uint8Array, filename: string, mime: string) {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadFile() {
  if (selectedFile.value) {
    downloadBytes(
      strToU8(selectedFile.value.content),
      selectedFile.value.name.split('/').pop()!,
      'text/plain;charset=utf-8',
    );
  }
}
function downloadSecrets() {
  downloadBytes(strToU8(exportKubernetesSecrets(input.value)), 'secrets.json', 'application/json');
}
function downloadBundle() {
  const files = Object.fromEntries(result.value.files.map((file) => [file.name, strToU8(file.content)]));
  const secretInstructions = result.value.secretReferences?.length
    ? '\nImport referenced Secrets first: python3 import-secrets.py /path/to/secrets.json. Download Secret values separately or provide Kubernetes Secret JSON/List. Keep this file private (chmod 600), out of git, and recreate consumers after rotation.\n'
    : '';
  const notes = `${instructions.value}${secretInstructions}\n\nConversion notes:\n${result.value.warnings.map((warning) => `- ${warning}`).join('\n')}\n`;
  files['README.txt'] = strToU8(notes);
  downloadBytes(zipSync(files), `kubernetes-${props.target}.zip`, 'application/zip');
}
</script>

<template>
  <div class="kubernetes-converter">
    <div mb-5 flex flex-wrap gap-2>
      <c-button
        v-for="targetOption in targets"
        :key="targetOption.value"
        :to="targetOption.route"
        :type="targetOption.value === target ? 'primary' : 'default'"
      >
        {{ targetOption.label }}
      </c-button>
    </div>

    <p text-sm op-75>
      Paste rendered Kubernetes YAML or JSON, including multiple documents or a List. Conversion runs in your browser.
      Only explicit hostPort and nodePort bindings publish host ports; their default host address is 127.0.0.1.
    </p>

    <div mb-3 flex flex-wrap gap-2>
      <c-button secondary @click="input = exampleManifest"> Simple example </c-button>
      <c-button secondary @click="input = multiContainerExample"> Pod with sidecar and ConfigMap </c-button>
      <c-button secondary @click="input = ''"> Clear </c-button>
    </div>

    <c-input-text
      v-model:value="input"
      label="Kubernetes manifests"
      placeholder="Paste your rendered Kubernetes manifests here..."
      raw-text
      multiline
      monospace
      rows="18"
      test-id="kubernetes-input"
      :spellcheck="false"
    />

    <c-card v-if="target === 'quadlet'" title="Options" mt-5>
      <n-form-item label="Description:" label-placement="left">
        <n-input v-model:value="quadletOptions.description" placeholder="Kubernetes workload <container name>" />
      </n-form-item>
      <n-form-item label="After Targets:" label-placement="left">
        <n-dynamic-tags v-model:value="quadletOptions.after" />
      </n-form-item>
      <n-form-item label="Wants Targets:" label-placement="left">
        <n-dynamic-tags v-model:value="quadletOptions.wants" />
      </n-form-item>
      <n-form-item label="Restart Policy:" label-placement="left">
        <n-select v-model:value="quadletOptions.restart" :options="restartOptions" />
      </n-form-item>
      <n-form-item label="WantedBy:" label-placement="left">
        <n-dynamic-tags v-model:value="quadletOptions.wantedBy" />
      </n-form-item>
      <p text-sm op-75>
        Options apply to container units. Init containers keep their one-shot behavior and required ordering. WantedBy
        defaults to default.target for user services.
      </p>
    </c-card>

    <n-alert v-if="result.errors.length" title="Cannot convert these manifests" type="error" mt-5>
      <div v-for="error in result.errors" :key="error" style="white-space: pre-wrap">
        {{ error }}
      </div>
    </n-alert>

    <n-alert v-if="result.warnings.length" title="Review these conversion notes" type="warning" mt-5>
      <ul class="conversion-notes">
        <li v-for="warning in result.warnings" :key="warning">
          {{ warning }}
        </li>
      </ul>
    </n-alert>

    <n-alert
      v-if="result.secretReferences?.length && (target === 'quadlet' || target === 'podman-run')"
      title="Supply Podman secrets before starting"
      type="info"
      mt-5
    >
      <p>
        The bundle contains named Secret references and an import script, with no Secret values. Run
        <code>python3 import-secrets.py /path/to/secrets.json</code> before starting containers. You can supply
        Kubernetes Secret JSON yourself, or download the values from this input separately. That separate JSON contains
        credentials; keep it private and out of git. Rotation requires recreating consumers.
      </p>
      <c-button secondary @click="downloadSecrets"> Download Secret values separately (.json) </c-button>
    </n-alert>

    <template v-if="result.files.length">
      <n-divider />
      <n-form-item label="Output file">
        <n-select
          :value="selectedFile?.name"
          :options="options"
          data-test-id="output-file"
          @update:value="selectedFilename = $event"
        />
      </n-form-item>
      <TextareaCopyable :value="selectedFile?.content ?? ''" :language="language" />
      <div mt-5 flex flex-wrap justify-center gap-3>
        <c-button secondary @click="downloadFile"> Download this file </c-button>
        <c-button type="primary" @click="downloadBundle"> Download all files (.zip) </c-button>
      </div>
      <p text-sm op-75>
        {{ instructions }}
      </p>
    </template>
  </div>
</template>

<style scoped>
.kubernetes-converter {
  width: 100%;
}
.conversion-notes {
  margin: 0;
  padding-left: 20px;
}
.conversion-notes li + li {
  margin-top: 6px;
}
</style>
