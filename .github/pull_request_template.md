## Checklist

- [ ] `pnpm check` passes locally (lint, typecheck, arch:check, coverage).
- [ ] No new `.dependency-cruiser-known-violations.json` entries (the
      baseline may only shrink).
- [ ] No max-lines pin was raised; moved files re-keyed their pins and
      vitest coverage thresholds in the same commit.
- [ ] Does this change implement something an existing module already
      owns? Check the module `README.md` ownership statements (arch
      rule 7 — one responsibility, one owner).
