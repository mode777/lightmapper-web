import { defineConfig } from 'vite';

// Relative base so the build works under the GitHub Pages subpath
// (https://mode777.github.io/lightmapper-web/).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
  },
});
