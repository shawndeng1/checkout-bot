import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopAPI,
  Snapshot,
} from "../../../packages/shared-types/src/index";
const api: DesktopAPI = {
  discover: (input) => ipcRenderer.invoke("retail:discover", input),
  cancelDiscovery: (id) => ipcRenderer.invoke("retail:cancel-discovery", id),
  history: (input) => ipcRenderer.invoke("retail:history", input),
  diagnostics: () => ipcRenderer.invoke("retail:diagnostics"),
  credentialStatus: () => ipcRenderer.invoke("retail:credential-status"),
  deleteCredential: (id) => ipcRenderer.invoke("retail:delete-credential", id),
  configureIntegration: (input) =>
    ipcRenderer.invoke("retail:configure", input),
  snapshot: () => ipcRenderer.invoke("retail:snapshot"),
  command: (command) => ipcRenderer.invoke("retail:command", command),
  subscribe: (callback) => {
    const listener = (_event: unknown, data: Snapshot) => callback(data);
    ipcRenderer.on("retail:update", listener);
    return () => ipcRenderer.removeListener("retail:update", listener);
  },
};
contextBridge.exposeInMainWorld("retail", api);
