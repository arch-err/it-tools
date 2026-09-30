<script setup lang="ts">
const route = useRoute();
</script>

<template>
  <div :key="route.path" class="external-tool" v-html="route.meta.externalHTMLContent" />
</template>
