export type DiskSentinelStatus = {
  freeKb: number;
  totalKb: number;
  isBelowThreshold: boolean;
};

declare module "claude-code" {
  interface PluginState {
    "disk-sentinel": { lastStatus: DiskSentinelStatus | null };
  }
}
