/**
 * A construction failure a package states is safe to show an operator:
 * the loader sanitizes every other exception, because arbitrary factory
 * text can embed resolved secrets. Build the message from the manifest,
 * field names, or the interface contract; never from a secret field's
 * resolved value.
 */
export const runtimePluginConstructionErrorName =
  'RuntimePluginConstructionError';

export class RuntimePluginConstructionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = runtimePluginConstructionErrorName;
  }
}

/**
 * Matched by name, not identity: an operator package carries its own copy
 * of this class, and a published package will bundle one.
 */
export function isRuntimePluginConstructionError(error: unknown): boolean {
  return (
    error instanceof Error && error.name === runtimePluginConstructionErrorName
  );
}
