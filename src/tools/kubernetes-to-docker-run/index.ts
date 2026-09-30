import { BrandDocker } from '@vicons/tabler';
import { defineTool } from '../tool';
import { translate } from '@/plugins/i18n.plugin';

export const tool = defineTool({
  name: translate('tools.kubernetes-to-docker-run.title'),
  path: '/kubernetes-to-docker-run',
  description: translate('tools.kubernetes-to-docker-run.description'),
  keywords: ['kubernetes', 'k8s', 'yaml', 'manifest', 'container', 'docker-run'],
  component: () => import('./kubernetes-to-docker-run.vue'),
  icon: BrandDocker,
  createdAt: new Date('2026-09-30'),
});
