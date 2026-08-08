import {pathToFileURL} from 'node:url';

export function isMainModule(moduleUrl: string): boolean {
  const scriptPath = process.argv[1];

  return (
    scriptPath !== undefined && pathToFileURL(scriptPath).href === moduleUrl
  );
}
