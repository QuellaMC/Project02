# app

The composition root: wires runtime config, plugin activation, and the
host together (`activation.ts`, `startup.ts`). Only the public barrel
and the CLIs may import it (arch rule `nothing-imports-app`). This
module owns construction; it implements no domain behavior.
