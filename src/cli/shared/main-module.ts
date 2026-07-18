import { pathToFileURL } from 'node:url';

export function isMainModule(
  moduleUrl: string,
  scriptPath: string | undefined = process.argv[1]
): boolean {
  return scriptPath !== undefined && pathToFileURL(scriptPath).href === moduleUrl;
}
