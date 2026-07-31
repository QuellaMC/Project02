'use strict';

// This tiny CommonJS boundary preserves Node's native import() when the
// TypeScript caller is executed through a build or test module transformer.
module.exports = specifier => import(specifier);
