import { translate as t } from '@/plugins/i18n.plugin';
import { defineTool } from '../tool';

export const tool = defineTool({
  name: t('tools.epc-qrcode-generator.title'),
  path: '/epc-qrcode-generator',
  description: t('tools.epc-qrcode-generator.description'),
  keywords: ['epc', 'sepa', 'qrcode', 'generator'],
  component: () => import('./epc-qrcode-generator.vue'),
  icon: defineAsyncComponent(() => import('@vicons/tabler/es/ReportMoney')),
  createdAt: new Date('2026-09-06'),
  category: 'Barcodes',
});
