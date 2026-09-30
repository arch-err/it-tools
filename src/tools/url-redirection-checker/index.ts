import { translate as t } from '@/plugins/i18n.plugin';
import { defineTool } from '../tool';

export const tool = defineTool({
  name: t('tools.url-redirection-checker.title'),
  path: '/url-redirection-checker',
  description: t('tools.url-redirection-checker.description'),
  keywords: ['url', 'redirection', 'checker'],
  component: () => import('./url-redirection-checker.vue'),
  icon: defineAsyncComponent(() => import('@vicons/tabler/es/Direction')),
  createdAt: new Date('2026-09-06'),
  category: 'Network',
  externAccessDescription:
    'This tool calls your Self Host Network Utilities Service to perform URL redirection checking.',
});
