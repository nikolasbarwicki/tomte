import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const digest = (token: string) => createHash("sha256").update(token).digest();

/** Bearer tokens that identify a bot to the browser endpoint. Kept in memory only. */
export class TokenRegistry {
  private entries: { digest: Buffer; botId: string }[] = [];

  issue(botId: string): { token: string; revoke(): void } {
    const token = randomBytes(32).toString("base64url");
    const entry = { digest: digest(token), botId };
    this.entries.push(entry);
    return { token, revoke: () => void (this.entries = this.entries.filter((e) => e !== entry)) };
  }

  /** The bot a token belongs to. Every entry is compared, in constant time, so timing does not reveal a near match. */
  botOf(token: string): string | undefined {
    const d = digest(token);
    let found: string | undefined;
    for (const e of this.entries) if (timingSafeEqual(e.digest, d)) found ??= e.botId;
    return found;
  }

  revokeBot(botId: string) {
    this.entries = this.entries.filter((e) => e.botId !== botId);
  }
}
