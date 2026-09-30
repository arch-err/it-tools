<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useQueryParam } from '@/composable/queryParams';

const { t } = useI18n();

const domain = useQueryParam({ tool: 'whois-checker', name: 'domain', defaultValue: '' });

function launchWhois() {
  if (!domain.value.trim()) {
    return;
  }
  // Construct WHOIS URL
  const url = `https://www.iana.org/whois?q=${encodeURIComponent(domain.value)}`;
  window.open(url, '_blank');
}
</script>

<template>
  <div style="max-width: 600px">
    <c-input-text
      v-model:value="domain"
      :label="t('tools.iana-whois-checker.texts.label-domain-to-check')"
      label-position="left"
      :placeholder="t('tools.iana-whois-checker.texts.placeholder-enter-a-domain-e-g-example-com')"
      mb-2
    />
    <n-space justify="center">
      <n-button type="primary" @click="launchWhois">
        {{ t('tools.iana-whois-checker.texts.tag-lookup-whois') }}
      </n-button>
    </n-space>
  </div>
</template>
