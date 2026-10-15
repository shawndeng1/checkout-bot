import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopAPI,
  Snapshot,
} from "../../../packages/shared-types/src/index";
const api: DesktopAPI = {
  snapshot: () => ipcRenderer.invoke("retail:snapshot"),
  command: (command) => ipcRenderer.invoke("retail:command", command),
  subscribe: (callback) => {
    const listener = (_event: unknown, data: Snapshot) => callback(data);
    ipcRenderer.on("retail:update", listener);
    return () => ipcRenderer.removeListener("retail:update", listener);
  },
};
contextBridge.exposeInMainWorld("retail", api);
