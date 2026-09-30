import { BrandDocker } from '@vicons/tabler';
import { defineTool } from '../tool';
import { translate } from '@/plugins/i18n.plugin';

export const tool = defineTool({
  name: translate('tools.kubernetes-to-quadlet.title'),
  path: '/kubernetes-to-quadlet',
  description: translate('tools.kubernetes-to-quadlet.description'),
  keywords: ['kubernetes', 'k8s', 'yaml', 'manifest', 'container', 'quadlet'],
  component: () => import('./kubernetes-to-quadlet.vue'),
  icon: BrandDocker,
  createdAt: new Date('2026-09-30'),
});
