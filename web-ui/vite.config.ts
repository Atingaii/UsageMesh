import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Keep assets relative to the deployed project path. This makes the same
  // dashboard build work for UsageMesh itself and for forks that are renamed.
  base: './',
  plugins: [react(), tailwindcss()],
  build: { sourcemap: false, minify: true },
});
