import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config.js", () => ({
  readLoggingConfig: () => undefined,
}));

let loadConfigCalls = 0;
vi.mock("node:module", async () => {
  const actual = await vi.importActual<typeof import("node:module")>("node:module");
  return Object.assign({}, actual, {
    createRequire: (url: string | URL) => {
      const realRequire = actual.createRequire(url);
      return (specifier: string) => {
        if (specifier.endsWith("config.js")) {
          return {
            loadConfig: () => {
              loadConfigCalls += 1;
              console.warn("config warning");
              return {};
            },
          };
        }
        return realRequire(specifier);
      };
    },
  });
});

type ConsoleSnapshot = {
  log: typeof console.log;
  info: typeof console.info;
  warn: typeof console.warn;
  error: typeof console.error;
  debug: typeof console.debug;
  trace: typeof console.trace;
};

let snapshot: ConsoleSnapshot;

beforeEach(() => {
  loadConfigCalls = 0;
  vi.resetModules();
  snapshot = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
    trace: console.trace,
  };
});

afterEach(async () => {
  console.log = snapshot.log;
  console.info = snapshot.info;
  console.warn = snapshot.warn;
  console.error = snapshot.error;
  console.debug = snapshot.debug;
  console.trace = snapshot.trace;
  const state = await import("./state.js");
  state.loggingState.consolePatched = false;
  state.loggingState.cachedLogger = null;
  state.loggingState.cachedSettings = null;
  state.loggingState.cachedConsoleSettings = null;
  state.loggingState.overrideSettings = null;
  state.loggingState.resolvingConsoleSettings = false;
  state.loggingState.resolvingLoggerSettings = false;
  state.loggingState.forceConsoleToStderr = false;
  state.loggingState.consoleTimestampPrefix = false;
  state.loggingState.rawConsole = null;
  vi.restoreAllMocks();
});

describe("logger config resolution", () => {
  it("does not recurse when loadConfig logs during console capture", async () => {
    const logging = await import("../logging.js");
    logging.enableConsoleCapture();
    expect(() => console.warn("outer warning")).not.toThrow();
    expect(loadConfigCalls).toBeGreaterThan(0);
    expect(loadConfigCalls).toBeLessThanOrEqual(2);
  });
});
