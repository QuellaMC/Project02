export function scaffoldRuntimePluginPackage(options: {
  readonly id: string;
  readonly packagesRoot: string;
  /** The static bundled-factory map the scaffold registers the package in. */
  readonly bundledPath: string;
}): {readonly packageRoot: string};
