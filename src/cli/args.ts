/** Minimal hand-rolled CLI arg parsing — no commander/yargs dependency. */

export interface ArgSpec {
  /** `--key <value>` options; repeatable, collected in order. */
  valueOptions: readonly string[];
  /** `--flag` boolean switches. */
  flags: readonly string[];
}

export interface ParsedArgs {
  positionals: string[];
  options: Record<string, string[]>;
  flags: Set<string>;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export function parseArgs(argv: string[], spec: ArgSpec): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string[]> = {};
  const flags = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) {
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    if (spec.flags.includes(key)) {
      flags.add(key);
      continue;
    }
    if (spec.valueOptions.includes(key)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`option --${key} requires a value`);
      }
      i++;
      (options[key] ??= []).push(value);
      continue;
    }
    throw new UsageError(`unknown option --${key}`);
  }
  return { positionals, options, flags };
}
