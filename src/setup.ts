import type { AuthHandle, AuthMode, EngineClient, LumberroomConfig } from "./types.js";

export interface SetupAnswers {
  deployment: "hosted" | "self";
  baseUrl?: string;
  auth: AuthMode;
  token?: string;
  dreamingReview: boolean;
  ownerIds: string[];
}

export interface SetupPlan {
  entryConfig: Record<string, unknown>;
  addPluginsAllow: boolean;
  addToolsAlsoAllow: boolean;
  envToken: string | null;
  diff: string[];
}

export function planSetup(current: Record<string, unknown>, answers: SetupAnswers): SetupPlan {
  throw new Error("T5");
}

/** Runs inside mutateConfigFile's mutate. */
export function applySetup(draft: Record<string, unknown>, plan: SetupPlan): void {
  throw new Error("T5");
}

/** Upserts one line, keeps the rest, 0600. */
export function writeEnvToken(stateDir: string, token: string): void {
  throw new Error("T5");
}

export interface CliIo {
  print(line: string): void;
  ask(question: string, fallback?: string): Promise<string>;
  askSecret(question: string): Promise<string>;
  pastedLines(): AsyncIterable<string>;
}

export interface CliDeps {
  pluginConfig: unknown;
  cliConfig: Record<string, unknown>; // the CLI context's config
  workspaceDir: string | undefined;
  stateDir(): string;
  io: CliIo;
  mutateConfig(mutate: (draft: Record<string, unknown>) => void): Promise<void>;
  makeClient(cfg: LumberroomConfig): { client: EngineClient; auth: AuthHandle };
}

/** Resolves to the exit code. */
export function runSetup(deps: CliDeps): Promise<number> {
  throw new Error("T5");
}
