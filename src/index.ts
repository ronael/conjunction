// Conjunction core library entry point.
// Dependency direction: workspace and verification are leaf modules;
// core depends on them only through the narrow ports in core/orchestrator.ts.
export * from "./core/index.js";
export * from "./workspace/index.js";
export * from "./verification/index.js";
