import {fileURLToPath} from 'node:url';

import {defineConfig} from 'vite';

// The page's own tsconfig supplies the JSX transform; the daemon serves
// the built files from dist/web, so no dev server and no proxy exist.
export default defineConfig({
  root: fileURLToPath(new URL('src/frontends/web', import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL('dist/web', import.meta.url)),
    emptyOutDir: true,
  },
});
