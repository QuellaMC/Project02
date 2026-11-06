import {fileURLToPath} from 'node:url';

import {defineConfig} from 'vite';

// The page's own tsconfig supplies the JSX transform; the daemon serves
// the built files from dist, so no dev server and no proxy exist.
export default defineConfig({
  root: fileURLToPath(new URL('src', import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL('dist', import.meta.url)),
    emptyOutDir: true,
  },
});
