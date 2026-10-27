import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 3000,
  },
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
    server: {
      allowedHosts: ['3000-itvug0rn2fs4a3n8b6zdp-6699e48a.sg2.manus.computer'],
      proxy: {
        '/api/v1': {
          target: 'http://127.0.0.1:8000',
          changeOrigin: true,
        },
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('/node_modules/recharts/')) return 'charts';
            if (id.includes('/node_modules/@supabase/')) return 'supabase';
          },
        },
      },
    },
  },
});
