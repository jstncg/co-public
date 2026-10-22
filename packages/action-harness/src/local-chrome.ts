import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DevtoolsPage } from "./cdp";

type TargetDescription = {
  id: string;
  webSocketDebuggerUrl: string;
};

export class LocalChromeController {
  readonly #pages = new Set<DevtoolsPage>();

  private constructor(
    private readonly process: ChildProcess,
    private readonly profileDirectory: string,
    private readonly endpoint: string,
  ) {}

  static async launch(input: { executablePath: string; extraArgs?: string[]; timeoutMs?: number }) {
    const profileDirectory = await mkdtemp(join(tmpdir(), "co-action-chrome-"));
    const chrome = spawn(
      input.executablePath,
      [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${profileDirectory}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--disable-extensions",
        "--disable-features=Translate,OptimizationHints",
        ...(input.extraArgs ?? []),
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    try {
      const port = await waitForDevtoolsPort(profileDirectory, chrome, input.timeoutMs ?? 15_000);
      return new LocalChromeController(chrome, profileDirectory, `http://127.0.0.1:${port}`);
    } catch (error) {
      chrome.kill("SIGTERM");
      await removeProfile(profileDirectory);
      throw error;
    }
  }

  async newPage(initialUrl = "about:blank") {
    const response = await fetch(`${this.endpoint}/json/new?${encodeURIComponent(initialUrl)}`, {
      method: "PUT",
    });
    if (!response.ok) throw new Error(`Chrome target creation failed (${response.status})`);
    const target = (await response.json()) as TargetDescription;
    if (!target.id || !target.webSocketDebuggerUrl)
      throw new Error("Chrome target response was incomplete");
    const page = await DevtoolsPage.connect(target.id, target.webSocketDebuggerUrl);
    this.#pages.add(page);
    return page;
  }

  async close() {
    for (const page of this.#pages) page.close();
    this.#pages.clear();
    this.process.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (this.process.exitCode !== null) return resolve();
      const timeout = setTimeout(() => {
        this.process.kill("SIGKILL");
        resolve();
      }, 3_000);
      this.process.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    await removeProfile(this.profileDirectory);
  }
}

async function removeProfile(profileDirectory: string) {
  // Chrome child processes can finish writing profile files just after the parent exits on Linux.
  await rm(profileDirectory, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 50,
  });
}

async function waitForDevtoolsPort(
  profileDirectory: string,
  chrome: ChildProcess,
  timeoutMs: number,
) {
  const activePortFile = join(profileDirectory, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (chrome.exitCode !== null) throw new Error("Chrome exited before exposing DevTools");
    try {
      const [port] = (await readFile(activePortFile, "utf8")).trim().split("\n");
      if (port?.match(/^\d+$/)) return Number(port);
    } catch {
      // Chrome writes the file atomically after the profile and debugging endpoint are ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Chrome did not expose DevTools in time");
}
