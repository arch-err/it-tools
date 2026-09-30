import { defineTool } from '../tool';
import { translate } from '@/plugins/i18n.plugin';

export const tool = defineTool({
  name: translate('tools.kubernetes-to-podman-run.title'),
  path: '/kubernetes-to-podman-run',
  description: translate('tools.kubernetes-to-podman-run.description'),
  keywords: ['kubernetes', 'k8s', 'yaml', 'manifest', 'container', 'podman-run'],
  component: () => import('./kubernetes-to-podman-run.vue'),
  icon: defineAsyncComponent(() => import('@vicons/tabler/es/BrandDocker')),
  category: 'Kubernetes',
  createdAt: new Date('2026-09-30'),
});
