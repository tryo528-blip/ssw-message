import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'SSW Message',
        short_name: 'SSW',
        description: '현장 메모·사진 사무실 전송',
        theme_color: '#0f1115',
        background_color: '#0f1115',
        display: 'standalone',
        start_url: '/',
        lang: 'ko',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }]
      }
    })
  ],
  resolve: {
    alias: { '@ssw/envelope': path.resolve(root, '../server/lib/envelope.mjs') }
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8443' }
  },
  preview: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8443' }
  }
});
