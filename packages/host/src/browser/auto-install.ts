import type { EngineStatus } from "./engine.ts";

/**
 * Installs the browser for a host that has no terminal to run `install-browser` in (the desktop sidecar).
 * `status` starts an install whenever the browser is missing and installable and none is running, so a failed
 * install is retried the next time anyone asks; the reason it returns says what is happening instead of naming a command.
 */
export function createAutoInstall(install: () => Promise<unknown>) {
  let installing = false;
  let lastError: string | undefined;
  return {
    status(engine: EngineStatus): EngineStatus {
      if (engine.status === "available" || !engine.installable) return engine;
      if (!installing) {
        installing = true;
        const retry = lastError;
        console.error(`browser not installed; installing it${retry ? " again" : ""}`);
        install().then(
          () => {
            installing = false;
            lastError = undefined;
            console.error("browser installed");
          },
          (e: unknown) => {
            installing = false;
            lastError = e instanceof Error ? e.message : String(e);
            console.error(`browser install failed: ${lastError}`);
          },
        );
        if (retry)
          return {
            status: "unavailable",
            reason: `the browser install failed (${retry}); installing it again, try again in a few minutes`,
          };
      }
      return {
        status: "unavailable",
        reason: "the browser is being installed; try again in a few minutes",
      };
    },
  };
}
