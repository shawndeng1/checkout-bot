import { create } from "zustand";
import type {
  Snapshot,
  Command,
  DesktopAPI,
} from "../../../packages/shared-types/src/index";
declare global {
  interface Window {
    retail: DesktopAPI;
  }
}
interface State {
  data: Snapshot | null;
  error: string | null;
  setData(data: Snapshot): void;
  clearError(): void;
  command(cmd: Command): Promise<boolean>;
}
export const useWorkspace = create<State>((set) => ({
  data: null,
  error: null,
  setData: (data) => set({ data }),
  clearError: () => set({ error: null }),
  command: async (cmd) => {
    try {
      const data = await window.retail.command(cmd);
      set({ data, error: null });
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "Action failed" });
      return false;
    }
  },
}));
