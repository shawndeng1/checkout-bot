import { it, expect } from "vitest";
import {
  CredentialVault,
  type EncryptionProvider,
} from "../apps/desktop/electron/credential-vault";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
function provider(): EncryptionProvider {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(16),
        cipher = createCipheriv("aes-256-cbc", key, iv);
      return Buffer.concat([iv, cipher.update(value, "utf8"), cipher.final()]);
    },
    decryptString(value) {
      const cipher = createDecipheriv(
        "aes-256-cbc",
        key,
        value.subarray(0, 16),
      );
      return Buffer.concat([
        cipher.update(value.subarray(16)),
        cipher.final(),
      ]).toString();
    },
  };
}
it("round-trips credentials through an injected encryption provider and preserves encrypted data on encryption failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-vault-"));
  const file = join(dir, "credentials.enc.json");
  try {
    const crypto = provider(),
      vault = new CredentialVault(file, crypto, "darwin");
    expect(await vault.load()).toEqual({});
    await vault.save({ shopify: "private-test-token" });
    const disk = await readFile(file, "utf8");
    expect(disk).not.toContain("private-test-token");
    expect(await new CredentialVault(file, crypto, "darwin").load()).toEqual({
      shopify: "private-test-token",
    });
    crypto.encryptString = () => {
      throw new Error("keychain locked");
    };
    await expect(vault.save({ shopify: "replacement" })).rejects.toThrow(
      "locked",
    );
    expect(await readFile(file, "utf8")).toBe(disk);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("refuses unavailable OS encryption and Linux basic_text without writing plaintext", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbit-vault-fail-"));
  const file = join(dir, "credentials.enc.json");
  try {
    const crypto = provider();
    crypto.isEncryptionAvailable = () => false;
    await expect(
      new CredentialVault(file, crypto, "darwin").save({ shopify: "secret" }),
    ).rejects.toThrow("unavailable");
    crypto.isEncryptionAvailable = () => true;
    crypto.getSelectedStorageBackend = () => "basic_text";
    await expect(
      new CredentialVault(file, crypto, "linux").save({ shopify: "secret" }),
    ).rejects.toThrow("unavailable");
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
