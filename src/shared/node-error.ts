export function isNodeErrorWithCode<Code extends string>(
  error: unknown,
  code: Code
): error is NodeJS.ErrnoException & { readonly code: Code } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
