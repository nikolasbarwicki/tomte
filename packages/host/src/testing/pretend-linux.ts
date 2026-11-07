/**
 * A `bun --preload` script for tests that spawn the host as a subprocess in remote mode, which parses on Linux only (ADR-0006).
 * It makes the child report `linux` so the tests run on a Mac too; they use a fake CLI, so nothing platform-specific runs.
 */
Object.defineProperty(process, "platform", { value: "linux" });
