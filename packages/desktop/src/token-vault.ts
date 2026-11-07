import { safeStorage } from "electron";

import { ConnectionError } from "./connection-error.ts";
import type { TokenVault } from "./profile-store.ts";

/** Device tokens encrypted by Electron's `safeStorage` (Keychain on macOS, DPAPI on Windows, the desktop's secret service on Linux). Refuses when the platform would keep the key in plaintext. */
export function createSafeStorageVault(): TokenVault {
  return {
    async assertAvailable() {
      if (!(await safeStorage.isAsyncEncryptionAvailable()))
        throw new ConnectionError(
          "This computer's credential store is not available, so a device token cannot be stored safely. Nothing was saved.",
        );
      if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")
        throw new ConnectionError(
          "No keyring was found (the only option is a plaintext file), so a device token cannot be stored safely. Install and unlock GNOME Keyring or KWallet. Nothing was saved.",
        );
    },
    async encrypt(plain) {
      return (await safeStorage.encryptStringAsync(plain)).toString("base64");
    },
    async decrypt(encrypted) {
      return (await safeStorage.decryptStringAsync(Buffer.from(encrypted, "base64"))).result;
    },
  };
}
