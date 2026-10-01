import { ref } from 'vue';
import { defaultQuadletOptions } from './kubernetes-converter.service';
import { exampleManifest } from './kubernetes-converter.examples';

// Keep pasted manifests when switching outputs, without persisting them to disk.
export const manifestInput = ref(exampleManifest);

export const quadletOptions = ref({
  ...defaultQuadletOptions,
  after: [...defaultQuadletOptions.after],
  wants: [...defaultQuadletOptions.wants],
  wantedBy: [...defaultQuadletOptions.wantedBy],
});
