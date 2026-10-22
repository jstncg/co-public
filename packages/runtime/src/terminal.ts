import { stdout } from "node:process";
import type { RunResult } from "./types.ts";

const ANSI = {
  reset: "\u001b[0m", bold: "\u001b[1m", dim: "\u001b[2m", cyan: "\u001b[36m", green: "\u001b[32m",
  yellow: "\u001b[33m", red: "\u001b[31m", magenta: "\u001b[35m", clearLine: "\r\u001b[2K",
};

function humanDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export interface BusyLine {
  update(status: string): void;
  stop(finalStatus?: string): void;
}

export class TerminalRenderer {
  readonly interactive: boolean;
  readonly color: boolean;
  readonly json: boolean;

  constructor(options: { json?: boolean; plain?: boolean } = {}) {
    this.json = options.json === true;
    this.interactive = stdout.isTTY === true && !this.json;
    this.color = this.interactive && options.plain !== true && process.env.NO_COLOR === undefined;
  }

  private paint(code: string, text: string): string { return this.color ? `${code}${text}${ANSI.reset}` : text; }

  info(text: string): void { if (!this.json) console.log(`${this.paint(ANSI.dim, "co ›")} ${text}`); }
  error(text: string): void { if (!this.json) console.error(`${this.paint(ANSI.red, "error ›")} ${text}`); }

  ready(name: string, mode: string): void {
    if (this.json) return;
    console.log(`${this.paint(ANSI.bold + ANSI.cyan, name)} is ready ${this.paint(ANSI.dim, `(${mode})`)}`);
    console.log(this.paint(ANSI.dim, "Type exit to leave; use .paste … .end for an explicit multi-line paste."));
  }

  prompt(): void { if (!this.json) stdout.write(`${this.paint(ANSI.green, "you ›")} `); }

  answer(name: string, result: RunResult): void {
    if (this.json) {
      console.log(JSON.stringify(result));
      return;
    }
    const label = this.paint(ANSI.bold + ANSI.cyan, `${name.toLowerCase()} ›`);
    console.log(`${label} ${this.renderMarkdown(result.text)}`);
    if (result.approvalId) console.log(`${this.paint(ANSI.yellow, "approval ›")} ${result.approvalId}  ${this.paint(ANSI.dim, `(co approve ${result.approvalId})`)}`);
    if (result.status === "cancelled") console.log(this.paint(ANSI.yellow, `run ${result.runId} cancelled`));
  }

  busy(initial: string): BusyLine {
    if (this.json) return { update: () => undefined, stop: () => undefined };
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const started = Date.now(); let status = initial; let index = 0; let stopped = false;
    const draw = () => {
      if (!this.interactive || stopped) return;
      const frame = this.paint(ANSI.cyan, frames[index % frames.length] as string); index += 1;
      stdout.write(`${ANSI.clearLine}${frame} ${status} ${this.paint(ANSI.dim, humanDuration(Date.now() - started))}`);
    };
    if (!this.interactive) console.log(`co › ${initial}`);
    else draw();
    const timer = this.interactive ? setInterval(draw, 80) : undefined;
    timer?.unref();
    return {
      update: (next) => { status = next; draw(); },
      stop: (finalStatus) => {
        if (stopped) return;
        stopped = true;
        if (timer) clearInterval(timer);
        if (this.interactive) stdout.write(ANSI.clearLine);
        if (finalStatus) console.log(`${this.paint(ANSI.dim, "co ›")} ${finalStatus} ${this.paint(ANSI.dim, humanDuration(Date.now() - started))}`);
      },
    };
  }

  section(title: string, items: string[], empty = "Nothing here."): void {
    if (this.json) return;
    console.log(this.paint(ANSI.bold, title));
    if (!items.length) console.log(`  ${this.paint(ANSI.dim, empty)}`);
    else for (const item of items) console.log(`  ${item}`);
  }

  identifier(value: string): string { return this.paint(ANSI.dim, value); }
  status(value: string): string {
    const code = value === "active" || value === "prepared" || value === "open" || value === "completed" ? ANSI.green
      : value === "proposed" || value === "waiting" || value === "watching" || value === "queued" || value === "running" || value === "waiting_approval" || value === "needs_input" ? ANSI.yellow : ANSI.dim;
    return this.paint(code, value);
  }

  private renderMarkdown(text: string): string {
    if (!this.color) return text;
    let fenced = false;
    return text.split("\n").map((line) => {
      if (line.trim().startsWith("```")) { fenced = !fenced; return this.paint(ANSI.dim, line); }
      if (fenced) return this.paint(ANSI.dim, line);
      if (/^#{1,3}\s/.test(line)) return this.paint(ANSI.bold, line.replace(/^#{1,3}\s/, ""));
      return line.replace(/\*\*([^*]+)\*\*/g, `${ANSI.bold}$1${ANSI.reset}`).replace(/`([^`]+)`/g, `${ANSI.magenta}$1${ANSI.reset}`);
    }).join("\n");
  }
}
