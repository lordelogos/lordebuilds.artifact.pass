import { spawn } from "node:child_process";

export type BrowserOpener = (url: string) => Promise<void>;
export type BrowserProcessRunner = (
  executable: string,
  args: readonly string[],
) => Promise<unknown>;

const run = async (command: string, args: readonly string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Could not open the browser (${code ?? "unknown"})`));
    });
  });

export const openBrowser = async (
  url: string,
  runner: BrowserProcessRunner = run,
  platform: NodeJS.Platform = process.platform,
): Promise<void> => {
  if (platform === "darwin") {
    await runner("/usr/bin/open", [url]);
    return;
  }
  if (platform === "win32") {
    await runner("cmd", ["/c", "start", "", url]);
    return;
  }
  await runner("xdg-open", [url]);
};
