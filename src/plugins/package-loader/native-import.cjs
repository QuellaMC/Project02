'use strict';

// Preserves Node's native import() under a build or test transformer.
module.exports = specifier => import(specifier);
