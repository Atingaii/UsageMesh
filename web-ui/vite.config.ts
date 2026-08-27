import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: '/usagemesh/',
  plugins: [react(), tailwindcss()],
  build: { sourcemap: false, minify: true },
});
