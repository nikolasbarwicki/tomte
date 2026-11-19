import { readFile } from "node:fs/promises";

import { BinaryVersion } from "@tomte/contract/update";
import { z } from "zod";

import { hostInfoUrl, type UpdateConf } from "../platform/update-conf.ts";
import type { Deps, ServiceUser, Systemd } from "./apply.ts";

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  argv: readonly string[],
  opts: { stdin?: string; timeoutMs?: number } = {},
): Promise<Ran> {
  const proc = Bun.spawn([...argv], {
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
    stdin: opts.stdin === undefined ? "ignore" : Buffer.from(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
    ...(opts.timeoutMs === undefined ? {} : { timeout: opts.timeoutMs }),
  });
  const [stdout, stderr, code] = await Promise.all([
    proc.stdout.text(),
    proc.stderr.text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function mustRun(argv: readonly string[], opts?: Parameters<typeof run>[1]): Promise<string> {
  const r = await run(argv, opts);
  if (r.code !== 0)
    throw new Error(`${argv[0]} failed (exit ${r.code}): ${r.stderr.trim().slice(0, 300)}`);
  return r.stdout;
}

/** The service's `systemctl` verbs. */
export function systemd(service: string, systemctl = "systemctl"): Systemd {
  const unit = `${service}.service`;
  const ctl = (verb: string) => () => mustRun([systemctl, verb, unit]).then(() => undefined);
  return {
    stop: ctl("stop"),
    start: ctl("start"),
    restart: ctl("restart"),
    isActive: async () => (await run([systemctl, "is-active", "--quiet", unit])).code === 0,
  };
}

/** `prefix` runs a command as the service user: `runuser -u <user> --`, or nothing for a test that runs as the current user. */
export function serviceUser(prefix: readonly string[]): ServiceUser {
  return {
    writeFile: (path, content) =>
      mustRun(
        [
          ...prefix,
          "sh",
          "-c",
          'umask 077 && cat > "$1.tmp" && mv -f -- "$1.tmp" "$1"',
          "sh",
          path,
        ],
        {
          stdin: content,
        },
      ).then(() => undefined),
    restoreDatabase: (snapshot, [database, ...rest]) =>
      mustRun([
        ...prefix,
        "sh",
        "-c",
        'set -e; cp -- "$1" "$2.restore"; shift; rm -f -- "$@"; mv -f -- "$1.restore" "$1"',
        "sh",
        snapshot,
        database!,
        ...rest,
      ]).then(() => undefined),
  };
}

const HOST_INFO_VERSION = z.object({ version: z.string() });

/** Where the release comes from (`fetch`, https only through redirects when the URL is https) into `dest`. */
export async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  if (url.startsWith("https:") && !res.url.startsWith("https:"))
    throw new Error("the download was redirected away from https");
  await Bun.write(dest, res);
}

const ASSETS: Record<string, string> = {
  "linux-x64": "tomte-host-linux-x64",
  "linux-arm64": "tomte-host-linux-arm64",
};

/** The helper's real dependencies on this machine: systemd, `runuser`, the network and the installed binaries. */
export function systemDeps(conf: UpdateConf, target = `${process.platform}-${process.arch}`): Deps {
  const asset = ASSETS[target];
  if (asset === undefined) throw new Error(`no release binary for ${target}`);
  return {
    asset,
    download,
    versionOf: async (binary) =>
      BinaryVersion.parse(JSON.parse(await mustRun([binary, "version"], { timeoutMs: 15_000 }))),
    systemd: systemd(conf.service),
    service: serviceUser(["runuser", "-u", conf.serviceUser, "--"]),
    hostVersion: async () => {
      const res = await fetch(hostInfoUrl(await readFile(conf.envFile, "utf8")), {
        signal: AbortSignal.timeout(2000),
      });
      return HOST_INFO_VERSION.parse(await res.json()).version;
    },
    sleep: (ms) => Bun.sleep(ms),
    now: () => Date.now(),
    log: (line) => console.error(`apply-update: ${line}`),
  };
}
