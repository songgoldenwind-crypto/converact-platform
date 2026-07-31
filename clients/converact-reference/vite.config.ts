import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 4180 },
  preview: { port: 4181 },
  build: {
    chunkSizeWarningLimit: 520,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/livekit-client/') || id.includes('/node_modules/@livekit/')) {
            return 'livekit-vendor';
          }
          return undefined;
        }
      }
    }
  }
});
