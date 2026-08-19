import { render } from "ink";
import React from "react";

import type { RuntimeRegistry } from "../../core/index.js";

import { ConfigStore, userConfigDir } from "./config-store.js";
import { ProductApp } from "./product-app.js";
import { ProductController } from "./product-controller.js";

/**
 * Entry point for the interactive product flow (`conjunction` with no args on
 * a TTY). Renders the Composer -> Execution TUI -> Result Actions. Must never
 * be invoked on a non-TTY / piped / CI environment.
 */
export async function runProduct(registry: RuntimeRegistry, configDir?: string): Promise<number> {
  if (process.stdout.isTTY !== true || process.stdin.isTTY !== true) {
    process.stdout.write(
      "error: the interactive Conjunction composer needs a terminal.\n" +
        '  use `conjunction run "<task>" ...` for scripts/CI, or `conjunction --help`.\n',
    );
    return 2;
  }

  const configStore = new ConfigStore(configDir ?? userConfigDir());
  const controller = new ProductController(registry, configStore, process.cwd());
  await controller.init();

  let quitResolve!: () => void;
  const quit = new Promise<void>((resolve) => {
    quitResolve = resolve;
  });
  const width = Math.max(40, (process.stdout.columns ?? 80) - 2);
  const height = Math.max(10, (process.stdout.rows ?? 24) - 2);

  const app = render(
    React.createElement(ProductApp, {
      controller,
      width,
      height,
      onExit: () => quitResolve(),
    }),
  );
  await quit;
  app.unmount();
  return 0;
}
