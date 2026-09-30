<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useDownloadFileFromBase64 } from '@/composable/downloadBase64';
import { useCopy } from '@/composable/copy';
import QRCode from 'qrcode';
import { isValidBIC, validateIBAN } from 'ibantools';
import { getFriendlyErrors } from '../iban-validator-and-parser/iban-validator-and-parser.service';
import type { FormInst } from 'naive-ui';

const { t } = useI18n();

const foreground = ref('#000000ff');
const background = ref('#ffffffff');
const size = ref(256);

const formRef = ref<FormInst | null>(null);

const iban = ref('');
const beneficiary = ref('');
const amount = ref<number>(0);
const reference = ref('');
const remittance = ref('');
const bic = ref('');
const version = ref('002');

const qrcode = ref<string>('');
const errorMessage = ref<string>('');

const rules = {
  iban: {
    required: true,
    validator: (_: any, iban: string) => {
      const { valid, errorCodes } = validateIBAN(iban);
      if (valid) {
        return true;
      }

      const errors = getFriendlyErrors(errorCodes);

      return new Error(errors.join(', ') || 'Invalid IBAN');
    },
  },
  beneficiary: {
    required: true,
    validator: (_: any, value: string) => {
      if (value.length > 70) {
        return new Error('Beneficiary name must be ≤ 70 characters');
      }
      return true;
    },
  },
  bic: {
    validator: (_: any, value: string) => {
      if (!value && version.value === '002') {
        return true; // BIC is optional in version 002
      }
      if (isValidBIC(value)) {
        return true;
      }

      return new Error('Invalid or empty BIC');
    },
  },
  amount: {
    required: true,
    validator: (_: any, value: number) => {
      if (value <= 0) {
        return new Error('Amount must be greater than 0');
      }
      return true;
    },
  },
  reference: {
    validator: (_: any, value: string) => {
      if (value.length > 35) {
        return new Error('Reference must be ≤ 35 characters');
      }
      return true;
    },
  },
  remittance: {
    validator: (_: any, value: string) => {
      if (value.length > 140) {
        return new Error('Remittance must be ≤ 140 characters');
      }
      return true;
    },
  },
};

const epcPayload = computed(() => {
  const amt = amount.value != null ? amount.value.toFixed(2) : '';
  return [
    'BCD',
    version.value,
    1,
    'SCT',
    bic.value || '',
    beneficiary.value || '',
    iban.value || '',
    `EUR${amt}`,
    '',
    reference.value || '',
    remittance.value || '',
  ].join('\n');
});

const generateQr = () => {
  errorMessage.value = '';
  qrcode.value = '';

  formRef.value?.validate(async (errors) => {
    if (errors) {
      errorMessage.value = 'Please fix validation errors.';
      return;
    }

    try {
      qrcode.value = await QRCode.toDataURL(epcPayload.value, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: size.value,
        color: {
          dark: foreground.value,
          light: background.value,
        },
      });
    } catch (e) {
      errorMessage.value = 'Failed to generate QR code.';
    }
  });
};

const { download } = useDownloadFileFromBase64({ source: qrcode, filename: 'qr-code.png' });
const { copy } = useCopy({ source: epcPayload, text: t('tools.epc-qrcode-generator.texts.text-copied-to-clipboard') });
</script>

<template>
  <div>
    <NForm
      ref="formRef"
      :model="{
        iban,
        beneficiary,
        bic,
        amount,
        reference,
        remittance,
        version,
      }"
      :rules="rules"
      label-width="150"
      label-placement="left"
    >
      <NFormItem :label="t('tools.epc-qrcode-generator.texts.label-beneficiary-name')" path="beneficiary">
        <NInput
          v-model:value="beneficiary"
          :placeholder="t('tools.epc-qrcode-generator.texts.placeholder-beneficiary-name')"
        />
      </NFormItem>

      <NFormItem :label="t('tools.epc-qrcode-generator.texts.label-account-iban')" path="iban">
        <NInput v-model:value="iban" :placeholder="t('tools.epc-qrcode-generator.texts.placeholder-fr76')" />
      </NFormItem>

      <NFormItem :label="t('tools.epc-qrcode-generator.texts.label-bic')" path="bic">
        <NInput
          v-model:value="bic"
          :placeholder="t('tools.epc-qrcode-generator.texts.placeholder-bank-bic-optional')"
        />
      </NFormItem>

      <NFormItem :label="t('tools.epc-qrcode-generator.texts.label-amount-eur')" path="amount">
        <NInputNumber v-model:value="amount" :min="0.01" :precision="2" />
      </NFormItem>

      <NFormItem :label="t('tools.epc-qrcode-generator.texts.label-payment-reference')" path="reference">
        <NInput v-model:value="reference" :placeholder="t('tools.epc-qrcode-generator.texts.placeholder-optional')" />
      </NFormItem>

      <NFormItem :label="t('tools.epc-qrcode-generator.texts.label-purpose')" path="remittance">
        <NInput v-model:value="remittance" :placeholder="t('tools.epc-qrcode-generator.texts.placeholder-optional')" />
      </NFormItem>

      <NFormItem :label="t('tools.epc-qrcode-generator.texts.label-version')" path="version">
        <NSelect
          v-model:value="version"
          :options="[
            { label: t('tools.epc-qrcode-generator.texts.label-v1'), value: '001' },
            { label: t('tools.epc-qrcode-generator.texts.label-v2'), value: '002' },
          ]"
        />
      </NFormItem>

      <NFormItem :label="t('tools.epc-qrcode-generator.texts.label-foreground-color')">
        <NColorPicker v-model:value="foreground" :modes="['hex']" />
      </NFormItem>
      <NFormItem :label="t('tools.epc-qrcode-generator.texts.label-background-color')">
        <NColorPicker v-model:value="background" :modes="['hex']" />
      </NFormItem>

      <NFormItem :label="t('tools.epc-qrcode-generator.texts.label-qr-size')" path="size">
        <NInputNumber v-model:value="size" :min="128" :max="2048" />
      </NFormItem>

      <NSpace justify="center">
        <NButton type="primary" @click="generateQr">{{
          t('tools.epc-qrcode-generator.texts.tag-generate-qr')
        }}</NButton>
      </NSpace>
    </NForm>

    <NAlert v-if="errorMessage" type="error">{{ errorMessage }}</NAlert>

    <div v-if="qrcode" mb-2>
      <div flex flex-col items-center gap-3>
        <img alt="wifi-qrcode" :src="qrcode" :width="size" />
        <NButton @click="download">{{ t('tools.epc-qrcode-generator.texts.tag-download-qrcode') }}</NButton>
      </div>
    </div>
    <div v-if="qrcode">
      <div flex flex-col items-center gap-3>
        <NButton @click="copy()">{{ t('tools.epc-qrcode-generator.texts.tag-copy-qrcode-text') }}</NButton>
      </div>
    </div>
  </div>
</template>
