import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
export interface EncryptionProvider {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
/** OS-backed encryption only. Never enables Electron's plaintext fallback. */
export class CredentialVault {
  constructor(
    private path: string,
    private provider: EncryptionProvider,
    private platform = process.platform,
  ) {}
  encryptionAvailable() {
    try {
      this.available();
      return true;
    } catch {
      return false;
    }
  }
  private available() {
    if (
      !this.provider.isEncryptionAvailable() ||
      (this.platform === "linux" &&
        ["basic_text", "unknown"].includes(
          this.provider.getSelectedStorageBackend?.() ?? "unknown",
        ))
    )
      throw new Error(
        "OS keychain encryption is unavailable; credentials were not saved",
      );
  }
  async checkpoint(): Promise<Record<string, string>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        Object.entries(parsed).some(
          ([key, value]) =>
            !/^[-a-z0-9]{1,60}$/.test(key) || typeof value !== "string",
        )
      )
        throw new Error("Invalid encrypted credential store");
      return parsed as Record<string, string>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error("Encrypted credential store is unreadable");
    }
  }
  async restore(encrypted: Record<string, string>) {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path + ".tmp", JSON.stringify(encrypted), {
      mode: 0o600,
    });
    await rename(this.path + ".tmp", this.path);
  }
  async replace(id: string, value: string) {
    this.available();
    const encrypted = await this.checkpoint();
    encrypted[id] = this.provider.encryptString(value).toString("base64");
    await this.restore(encrypted);
  }
  async remove(id: string) {
    const encrypted = await this.checkpoint();
    delete encrypted[id];
    await this.restore(encrypted);
  }
  async load(): Promise<Record<string, string>> {
    const encrypted = await this.checkpoint();
    if (!Object.keys(encrypted).length) return {};
    this.available();
    const result: Record<string, string> = {};
    for (const [id, value] of Object.entries(encrypted)) {
      if (typeof value !== "string")
        throw new Error("Invalid encrypted credential store");
      result[id] = this.provider.decryptString(Buffer.from(value, "base64"));
    }
    return result;
  }
  async save(values: Record<string, string>) {
    this.available();
    const encrypted: Record<string, string> = {};
    for (const [id, value] of Object.entries(values))
      if (value)
        encrypted[id] = this.provider.encryptString(value).toString("base64");
    await this.restore(encrypted);
  }
}
