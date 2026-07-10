import type {
  RuntimePlugin,
  RuntimePluginManifest
} from './validation.ts';

export type RuntimePluginFactoryCreate = (
  ...args: never[]
) => Promise<RuntimePlugin> | RuntimePlugin;

export type RuntimePluginFactoryDefinition<
  TCreate extends RuntimePluginFactoryCreate = RuntimePluginFactoryCreate
> = {
  readonly manifest: RuntimePluginManifest;
  readonly create: TCreate;
};
