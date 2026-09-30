import { BrandDocker } from '@vicons/tabler';
import { defineTool } from '../tool';
import { translate } from '@/plugins/i18n.plugin';

export const tool = defineTool({
  name: translate('tools.kubernetes-to-compose.title'),
  path: '/kubernetes-to-compose',
  description: translate('tools.kubernetes-to-compose.description'),
  keywords: ['kubernetes', 'k8s', 'yaml', 'manifest', 'container', 'compose'],
  component: () => import('./kubernetes-to-compose.vue'),
  icon: BrandDocker,
  createdAt: new Date('2026-09-30'),
});
