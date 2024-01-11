import * as Cosmic from "cosmiconfig";
import defaultConfig from "./default.nugo.config";
import { error, verbose, warning } from "../log";
import { TypeScriptLoader } from "cosmiconfig-typescript-loader";
import { IPlugin } from "../plugins/pluginTypes";
import { exit } from "process";

export type INugoConfig = {
  plugins: IPlugin[];
};

// read the plugins from the config file
// and add them to the map
export async function loadConfigAsync(): Promise<INugoConfig> {
  let config: INugoConfig = defaultConfig;
  try {
    const cosmic = Cosmic.cosmiconfig("nugo", {
      loaders: {
        ".ts": TypeScriptLoader(),
      },
      searchPlaces: [`nugo.config.ts`],
    });
    const found = await cosmic.search();
    if (found) {
      verbose(`Loading config from ${found.filepath}`);
    } else {
      verbose(`Did not find any configuration file, using default configs only.`);
    }

    const pluginsWithInitializers = found?.config?.plugins?.filter(
      (p: IPlugin) => p.init !== undefined
    );
    const initializers = pluginsWithInitializers?.map(
      (p: IPlugin) => () => p!.init!(p)
    );

    await Promise.all(initializers || []);

    found?.config?.plugins?.forEach(async (plugin: IPlugin) => {
      if (plugin.init !== undefined) {
        verbose(`Initializing plugin ${plugin.name}...`);
        await plugin.init(plugin);
      }
    });
    // for now, all we have is plugins
    config = {
      plugins: defaultConfig.plugins.concat(found?.config?.plugins || []),
    };
  } catch (e: any) {
    error(e.message);
    exit(1);
  }
  warning(`Active plugins: [${config.plugins.map(p => p.name).join(", ")}]`);
  return config;
}
