import { defineConfig } from 'vite';
export default defineConfig({
  base: '/simulation/',
  build: { outDir: '../src/uvyazka/viewer', emptyOutDir: true, chunkSizeWarningLimit: 750 },
});
