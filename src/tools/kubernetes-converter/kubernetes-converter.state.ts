import { ref } from 'vue';
import { exampleManifest } from './kubernetes-converter.examples';

// Keep pasted manifests when switching outputs, without persisting them to disk.
export const manifestInput = ref(exampleManifest);
