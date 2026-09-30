<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import * as ctz from 'countries-and-timezones';
import getTimezoneOffset from 'get-timezone-offset';
import posixTimezones from './posix-timezones.json';
import { useFlexSearch } from '@/composable/flexSearch';

const { t } = useI18n();

const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const allTimezones = Object.values(ctz.getAllTimezones()).map((tz) => ({
  value: tz.name,
  label: `${tz.name === browserTimezone ? 'Browser TZ - ' : ''}${tz.name} (${tz.utcOffset === tz.dstOffset ? tz.utcOffsetStr : `${tz.utcOffsetStr}/${tz.dstOffsetStr}`})`,
}));

function convertMinsToHrsMins(minutes: number) {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return `${h}:${m}`;
}

const otherTimezones = useStorage<{ name: string }[]>('timezone-conv:zones', [{ name: 'Etc/GMT' }]);
const currentTimezone = useStorage<string>('timezone-conv:current', browserTimezone);
const use24HourTimeFormat = useStorage<boolean>('timezone-conv:24h', true);
const format = computed(() => (use24HourTimeFormat.value ? 'yyyy-MM-dd HH:mm:ss' : 'yyyy-MM-dd hh:mm:ss a'));
const timePickerProps = computed(() => (use24HourTimeFormat.value ? { use12Hours: false } : { use12Hours: true }));

const now = Date.now();
const currentDatetimeRange = ref<[number, number]>([now, now]);
const currentTimezoneOffset = computed(() => {
  return convertMinsToHrsMins(-getTimezoneOffset(currentTimezone.value, new Date(currentDatetimeRange.value[0])));
});
function convertToTimezone(tz: string, timestamp: number) {
  return new Date(
    timestamp +
      getTimezoneOffset(currentTimezone.value, new Date()) * 60 * 1000 -
      getTimezoneOffset(browserTimezone, new Date()) * 60 * 1000,
  ).toLocaleString(undefined, { timeZone: tz, timeZoneName: undefined, hour12: !use24HourTimeFormat.value });
}

const tzToCountriesInput = ref(browserTimezone);
const tzToCountriesOutput = computed(() => ctz.getCountriesForTimezone(tzToCountriesInput.value));

const allCountries = Object.values(ctz.getAllCountries()).map((c) => ({
  value: c.id,
  label: `${c.name} (${c.id})`,
}));
const countryToTimezonesInput = ref('FR');
const countryToTimezonesOutput = computed(() => ctz.getTimezonesForCountry(countryToTimezonesInput.value));

const searchPosix = ref('');

const { searchResult: searchPosixResult } = useFlexSearch({
  search: searchPosix,
  data: Object.entries(posixTimezones).map(([timezone, posix]) => ({
    timezone,
    posix,
  })),
  options: {
    keys: ['timezone', 'posix'],
  },
});
</script>

<template>
  <div>
    <c-card :title="t('tools.timezone-converter.texts.title-timezones-date-time-converter')" mb-2>
      <c-select
        v-model:value="currentTimezone"
        :label="t('tools.timezone-converter.texts.label-timezone')"
        label-position="left"
        searchable
        :options="allTimezones"
        mb-2
      />
      <n-form-item
        :label="t('tools.timezone-converter.texts.label-date-time-interval-to-convert')"
        label-placement="top"
      >
        <n-date-picker
          :key="format"
          v-model:value="currentDatetimeRange"
          type="datetimerange"
          :format="format"
          :time-picker-props="timePickerProps"
          mb-2
          w-full
        />
      </n-form-item>

      <n-space justify="space-evenly">
        <n-form-item :label="t('tools.timezone-converter.texts.label-current-timezone-offset')" label-placement="left">
          <n-input :value="currentTimezoneOffset" readonly style="width: 5em" />
        </n-form-item>
        <n-form-item :label="t('tools.timezone-converter.texts.label-use-24-hour-time-format')" label-placement="left">
          <n-switch v-model:value="use24HourTimeFormat" />
        </n-form-item>
      </n-space>

      <c-card :title="t('tools.timezone-converter.texts.title-date-time-in-other-timezones')">
        <n-dynamic-input v-model:value="otherTimezones" show-sort-button :on-create="() => ({ name: browserTimezone })">
          <template #default="{ value }">
            <div flex flex-wrap items-center gap-1>
              <n-select
                v-model:value="value.name"
                filterable
                :placeholder="t('tools.timezone-converter.texts.placeholder-please-select-a-timezone')"
                :options="allTimezones"
                w-full
              />
              <div w-full flex items-baseline gap-1>
                <n-input
                  style="min-width: 49%"
                  readonly
                  :value="convertToTimezone(value.name, currentDatetimeRange[0])"
                />
                <n-input
                  style="min-width: 49%"
                  readonly
                  :value="convertToTimezone(value.name, currentDatetimeRange[1])"
                />
              </div>
            </div>
          </template>
        </n-dynamic-input>
      </c-card>
    </c-card>

    <c-card :title="t('tools.timezone-converter.texts.title-country-to-timezones')" mb-2>
      <c-select
        v-model:value="countryToTimezonesInput"
        :label="t('tools.timezone-converter.texts.label-country')"
        label-position="left"
        searchable
        :options="allCountries"
      />

      <n-divider />

      <ul>
        <li v-for="(tz, ix) in countryToTimezonesOutput" :key="ix">
          {{ tz.name }} ({{ tz.countries.join(', ') }}): UTC= {{ tz.utcOffsetStr }}, DST= {{ tz.dstOffsetStr }}
        </li>
      </ul>
    </c-card>

    <c-card :title="t('tools.timezone-converter.texts.title-timezones-to-countries')" mb-2>
      <c-select
        v-model:value="tzToCountriesInput"
        :label="t('tools.timezone-converter.texts.label-timezone')"
        label-position="left"
        searchable
        :options="allTimezones"
      />

      <n-divider />

      <ul>
        <li v-for="(country, ix) in tzToCountriesOutput" :key="ix">
          {{ country.name }} ({{ country.id }}): {{ country.timezones.join(', ') }}
        </li>
      </ul>
    </c-card>

    <c-card :title="t('tools.timezone-converter.texts.title-posix-timezones')" mb-2>
      <div flex items-center gap-3>
        <c-input-text
          v-model:value="searchPosix"
          :placeholder="t('tools.timezone-converter.texts.search-posix-timezones')"
          mx-auto
          max-w-600px
        >
          <template #prefix>
            <icon-mdi-search mr-6px color-black op-70 dark:color-white />
          </template>
        </c-input-text>
      </div>

      <n-alert v-if="!searchPosixResult.length" type="info" mt-2>
        {{ t('tools.timezone-converter.texts.tag-no-results') }}
      </n-alert>
      <n-table v-else mt-2>
        <thead>
          <tr>
            <th>{{ t('tools.timezone-converter.texts.tag-timezone') }}</th>
            <th>{{ t('tools.timezone-converter.texts.tag-posix') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(result, ix) in searchPosixResult" :key="ix">
            <td><input-copyable readonly :value="result.timezone" /></td>
            <td><input-copyable readonly :value="result.posix" /></td>
          </tr>
        </tbody>
      </n-table>
    </c-card>
  </div>
</template>
