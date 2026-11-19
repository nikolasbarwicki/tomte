// A fake machine for the root update helper's tests: temp directories for the binary, the data root and the helper's state, a
// release folder signed with a throwaway key, and fakes for systemd, the service user, host-info, downloads and the clock.
// "Binaries" are JSON files holding what `tomte-host version` prints, plus how the service behaves once started from them.
import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BinaryVersion, REQUEST_FILE, RESULT_FILE, UPDATES_DIR } from "@tomte/contract/update";
import type { UpdateRequest, UpdateResult } from "@tomte/contract/update";

import type { Deps, UpdateConf } from "../update-helper/index.ts";

const BASE_URL = "https://releases.test";
const REPO = "owner/tomte";
const ASSET = "tomte-host-linux-x64";

/** How a fake binary behaves once the service runs it. */
export type Behaviour = "healthy" | "crashes" | "reports-old-version";

interface FakeBinary extends BinaryVersion {
  behaviour: Behaviour;
}

export interface Release {
  version: string;
  schemaVersion?: number;
  behaviour?: Behaviour;
  /** Sign with this key instead of the pinned one. */
  signWith?: string;
  /** Replace the binary after the sums were made. */
  tamper?: boolean;
  /** What release.json says it is, when not `version`. */
  manifestVersion?: string;
  /** Replaces release.json's content (before the sums are made). */
  manifest?: string;
  /** Rewrites SHA256SUMS before it is signed. */
  sums?: (sums: string) => string;
}

export class World {
  readonly root = mkdtempSync(join(tmpdir(), "update-helper-"));
  readonly bin = join(this.root, "usr-local-bin", "tomte-host");
  readonly dataRoot = join(this.root, "data");
  readonly stateDir = join(this.root, "helper-state");
  readonly releases = join(this.root, "releases");
  readonly #pair = generateKeyPairSync("ed25519");
  readonly #other = generateKeyPairSync("ed25519");
  /** The binary the service is running now; undefined while it is stopped. */
  running: FakeBinary | undefined;
  /** Every systemctl verb, in order. */
  readonly calls: string[] = [];
  /** Seconds the fake clock advanced. */
  slept = 0;
  logs: string[] = [];
  /** Called after each journal write with the step; throw to play a crash. */
  crashAfter: string | undefined;

  constructor() {
    mkdirSync(join(this.root, "usr-local-bin"), { recursive: true });
    mkdirSync(join(this.dataRoot, UPDATES_DIR), { recursive: true });
    writeFileSync(join(this.root, "tomte.env"), "TOMTE_PORT=8417\n");
  }

  readonly publicKey = this.#pair.publicKey
    .export({ type: "spki", format: "der" })
    .subarray(12)
    .toString("base64");

  get conf(): UpdateConf {
    return {
      repo: REPO,
      publicKey: this.publicKey,
      dataRoot: this.dataRoot,
      service: "tomte",
      serviceUser: "tomte",
      bin: this.bin,
      envFile: join(this.root, "tomte.env"),
      releaseBaseUrl: BASE_URL,
      stateDir: this.stateDir,
    };
  }

  /** Installs `version` as the running host, as `install.sh` would. */
  install(version: string, schemaVersion = 7): void {
    this.#writeBinary(this.bin, { version, schemaVersion, behaviour: "healthy" });
    this.running = this.#readBinary(this.bin);
    writeFileSync(join(this.dataRoot, "tomte.db"), `database of ${version}`);
  }

  /** Publishes `release` to the fake GitHub, signed unless told otherwise. */
  publish(release: Release): void {
    const dir = join(this.releases, `v${release.version}`);
    mkdirSync(dir, { recursive: true });
    const binary: FakeBinary = {
      version: release.version,
      schemaVersion: release.schemaVersion ?? 7,
      behaviour: release.behaviour ?? "healthy",
    };
    this.#writeBinary(join(dir, ASSET), binary);
    writeFileSync(
      join(dir, "release.json"),
      release.manifest ??
        JSON.stringify({
          version: release.manifestVersion ?? release.version,
          shellApi: { min: 1, max: 1 },
          schemaVersion: binary.schemaVersion,
        }),
    );
    const made = ["release.json", ASSET]
      .map((name) => {
        const sha = createHash("sha256")
          .update(readFileSync(join(dir, name)))
          .digest("hex");
        return `${sha}  ${name}\n`;
      })
      .join("");
    const sums = release.sums?.(made) ?? made;
    writeFileSync(join(dir, "SHA256SUMS"), sums);
    const key = release.signWith === "other" ? this.#other.privateKey : this.#pair.privateKey;
    writeFileSync(join(dir, "SHA256SUMS.sig"), sign(null, Buffer.from(sums), key));
    if (release.tamper) writeFileSync(join(dir, ASSET), "tampered");
  }

  /** The service user's snapshot of the database, taken before updating to `version`. */
  snapshot(version: string, content = `snapshot before ${version}`): void {
    writeFileSync(join(this.dataRoot, UPDATES_DIR, `pre-${version}.db`), content);
  }

  request(r: UpdateRequest): void {
    writeFileSync(join(this.dataRoot, UPDATES_DIR, REQUEST_FILE), JSON.stringify(r));
  }

  rawRequest(text: string): void {
    writeFileSync(join(this.dataRoot, UPDATES_DIR, REQUEST_FILE), text);
  }

  get requestPath(): string {
    return join(this.dataRoot, UPDATES_DIR, REQUEST_FILE);
  }

  get database(): string {
    return readFileSync(join(this.dataRoot, "tomte.db"), "utf8");
  }

  result(): UpdateResult | undefined {
    try {
      return JSON.parse(readFileSync(join(this.dataRoot, UPDATES_DIR, RESULT_FILE), "utf8"));
    } catch {
      return undefined;
    }
  }

  installed(): BinaryVersion {
    return this.#readBinary(this.bin);
  }

  previous(): BinaryVersion | undefined {
    try {
      return this.#readBinary(`${this.bin}.prev`);
    } catch {
      return undefined;
    }
  }

  deps(): Deps {
    const start = () => {
      this.running = this.#readBinary(this.bin);
    };
    return {
      asset: ASSET,
      download: async (url, dest) => {
        const path = url.slice(`${BASE_URL}/${REPO}/releases/download/`.length);
        try {
          copyFileSync(join(this.releases, path), dest);
        } catch {
          throw new Error("404 Not Found");
        }
      },
      versionOf: async (binary) => BinaryVersion.parse(this.#readBinary(binary)),
      systemd: {
        stop: async () => {
          this.calls.push("stop");
          this.running = undefined;
        },
        start: async () => {
          this.calls.push("start");
          start();
        },
        restart: async () => {
          this.calls.push("restart");
          start();
        },
        isActive: async () => this.running !== undefined && this.running.behaviour !== "crashes",
      },
      service: {
        writeFile: async (path, content) => writeFileSync(path, content),
        restoreDatabase: async (snapshot, [database, ...rest]) => {
          for (const file of rest) rmSync(file, { force: true });
          copyFileSync(snapshot, database!);
        },
      },
      hostVersion: async () =>
        this.running?.behaviour === "reports-old-version" ? "0.0.1" : this.running?.version,
      sleep: async () => {
        this.slept++;
      },
      now: () => 1_700_000_000_000,
      log: (line) => this.logs.push(line),
      journaled: (step) => {
        if (step === this.crashAfter) throw new Error(`crash after ${step}`);
      },
    };
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }

  #writeBinary(path: string, b: FakeBinary): void {
    writeFileSync(path, JSON.stringify(b));
  }

  #readBinary(path: string): FakeBinary {
    return JSON.parse(readFileSync(path, "utf8")) as FakeBinary;
  }
}
