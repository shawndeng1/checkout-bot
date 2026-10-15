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
  async load(): Promise<Record<string, string>> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    this.available();
    const encrypted = JSON.parse(text);
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
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path + ".tmp", JSON.stringify(encrypted), {
      mode: 0o600,
    });
    await rename(this.path + ".tmp", this.path);
  }
}
