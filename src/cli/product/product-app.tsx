import { Box, Text, useInput } from "ink";
import React, { useEffect, useState, useSyncExternalStore } from "react";

import { RunApp } from "../ui/run-app.js";

import { ComposerApp } from "./composer-app.js";
import type { ProductController } from "./product-controller.js";
import { ResultActionsApp } from "./result-actions-app.js";

function FatalView({
  message,
  onExit,
}: {
  message: string;
  onExit: () => void;
}): React.JSX.Element {
  useInput((_input, key) => {
    if (key.return || key.escape || key.ctrl) {
      onExit();
    }
  });
  return (
    <Box flexDirection="column">
      <Text bold color="red">
        ✗ {message}
      </Text>
      <Text> </Text>
      <Text dimColor>Press Enter to exit</Text>
    </Box>
  );
}

/**
 * Top-level product renderer: switches between the Run Composer, the existing
 * Execution TUI, and the Result Actions — all driven by the one ProductController.
 */
export function ProductApp({
  controller,
  width,
  height,
  onExit,
}: {
  controller: ProductController;
  width: number;
  height: number;
  onExit: () => void;
}): React.JSX.Element {
  useSyncExternalStore(controller.subscribe, controller.getVersion);
  useSyncExternalStore(controller.composer.subscribe, controller.composer.getVersion);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((value) => value + 1), 150);
    return () => clearInterval(interval);
  }, []);

  // When the composer's Run is requested, hand off to the engine.
  useEffect(() => {
    if (controller.phase === "composer" && controller.composer.runRequested) {
      void controller.startRun();
    }
  }, [controller, controller.composer.runRequested]);

  switch (controller.phase) {
    case "composer":
      return (
        <ComposerApp
          composer={controller.composer}
          width={width}
          height={height}
          onExit={onExit}
          tick={tick}
        />
      );
    case "execution":
      return controller.runModel !== undefined ? (
        <RunApp
          model={controller.runModel}
          onCancel={() => controller.cancel()}
          onQuit={() => {}}
          width={width}
          showFinalPanel={false}
        />
      ) : (
        <Box />
      );
    case "result":
      if (controller.fatalError !== undefined) {
        return <FatalView message={controller.fatalError} onExit={onExit} />;
      }
      return controller.result !== undefined ? (
        <ResultActionsApp model={controller.result} width={width} height={height} onExit={onExit} />
      ) : (
        <Box />
      );
  }
}
