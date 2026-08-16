import type { ProcessRunner } from "./process";
import { runProcess } from "./process";

export const openBrowser = async (
  url: string,
  runner: ProcessRunner = runProcess,
  platform: NodeJS.Platform = process.platform,
): Promise<void> => {
  if (platform === "darwin") {
    await runner("open", [url]);
    return;
  }
  if (platform === "win32") {
    await runner("cmd", ["/c", "start", "", url]);
    return;
  }
  await runner("xdg-open", [url]);
};
