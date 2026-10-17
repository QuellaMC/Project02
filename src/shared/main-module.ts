import {pathToFileURL} from 'node:url';

export function isMainModule(moduleUrl: string): boolean {
  const scriptPath = process.argv[1];

  return (
    scriptPath !== undefined && pathToFileURL(scriptPath).href === moduleUrl
  );
}

/**
 * The stop a terminal asks for, as one signal: the first SIGINT, SIGTERM
 * or SIGHUP — a closed terminal, an ordinary way to stop — starts the
 * stop, and a second of any kind ends the process the default way: the
 * escape hatch when stopping itself hangs.
 */
export function stopSignal(): AbortSignal {
  const abort = new AbortController();
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const onSignal = (): void => {
    for (const signal of signals) {
      process.off(signal, onSignal);
    }

    abort.abort();
  };

  for (const signal of signals) {
    process.on(signal, onSignal);
  }

  return abort.signal;
}
