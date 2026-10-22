type CdpResponse = {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code?: number };
};

type PendingCall = {
  method: string;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
};

export type CdpMethodAudit = { method: string; occurred_at: string };

export class CdpConnection {
  readonly #socket: WebSocket;
  readonly #pending = new Map<number, PendingCall>();
  readonly #audit: CdpMethodAudit[] = [];
  #nextId = 1;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      void this.#receive(event.data);
    });
    socket.addEventListener("close", () => {
      for (const pending of this.#pending.values())
        pending.reject(new Error(`CDP ${pending.method} connection closed`));
      this.#pending.clear();
    });
  }

  static async connect(webSocketUrl: string, timeoutMs = 10_000) {
    const url = new URL(webSocketUrl);
    if (!["ws:", "wss:"].includes(url.protocol)) throw new Error("invalid CDP websocket URL");
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("CDP connection timed out")), timeoutMs);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new Error("CDP connection failed"));
        },
        { once: true },
      );
    });
    return new CdpConnection(socket);
  }

  async send(method: string, params: Record<string, unknown> = {}) {
    if (this.#socket.readyState !== WebSocket.OPEN) throw new Error("CDP connection is not open");
    const id = this.#nextId++;
    this.#audit.push({ method, occurred_at: new Date().toISOString() });
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject });
      // Parameters are intentionally never copied into the audit trail. This connection is the
      // privileged boundary used for secret injection below the model.
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  audit() {
    return this.#audit.map((entry) => ({ ...entry }));
  }

  close() {
    this.#socket.close();
  }

  async #receive(data: unknown) {
    let text: string;
    if (typeof data === "string") text = data;
    else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString("utf8");
    else if (typeof Blob !== "undefined" && data instanceof Blob) text = await data.text();
    else return;
    let response: CdpResponse;
    try {
      response = JSON.parse(text) as CdpResponse;
    } catch {
      return;
    }
    if (response.id === undefined) return;
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    if (response.error) {
      pending.reject(
        new Error(`CDP ${pending.method} failed with code ${response.error.code ?? "unknown"}`),
      );
      return;
    }
    pending.resolve(response.result ?? {});
  }
}

type RuntimeResult = {
  result?: { value?: unknown; objectId?: string };
  exceptionDetails?: unknown;
};

export class DevtoolsPage {
  private constructor(
    readonly sessionId: string,
    private readonly cdp: CdpConnection,
  ) {}

  static async connect(sessionId: string, webSocketUrl: string) {
    const cdp = await CdpConnection.connect(webSocketUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    return new DevtoolsPage(sessionId, cdp);
  }

  async navigate(url: string) {
    await this.cdp.send("Page.navigate", { url });
    await this.waitForReady();
  }

  async waitForReady(timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const state = await this.evaluate("document.readyState");
        if (state === "complete" || state === "interactive") return;
      } catch {
        // A cross-document navigation temporarily destroys the old execution context.
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("browser page did not become ready");
  }

  async currentOrigin() {
    const origin = await this.evaluate("location.origin");
    if (typeof origin !== "string") throw new Error("browser did not return an origin");
    return origin;
  }

  async readVisibleText(selector: string | null = null) {
    const value = await this.callDocument(
      `function(selector) {
      const root = selector ? this.querySelector(selector) : this.body;
      if (!root) throw new Error('element not found');
      if (root instanceof HTMLInputElement || root instanceof HTMLTextAreaElement) {
        return root.hasAttribute('data-co-secret-filled') ? '[secret field]' : root.value;
      }
      const clone = root.cloneNode(true);
      for (const secret of clone.querySelectorAll('[data-co-secret-filled]')) {
        secret.setAttribute('value', '');
        secret.textContent = '[secret field]';
      }
      return (clone.innerText || clone.textContent || '').trim();
    }`,
      [selector],
      true,
    );
    if (typeof value !== "string") throw new Error("browser did not return visible text");
    return value;
  }

  async fillPublic(selector: string, value: string) {
    return this.callDocument(
      `function(selector, value) {
      const element = this.querySelector(selector);
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) throw new Error('fillable element not found');
      if (element.disabled || element.readOnly || element.type === 'hidden') throw new Error('element is not fillable');
      element.focus();
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }`,
      [selector, value],
      true,
    );
  }

  async injectSecret(selector: string, secret: Uint8Array, expectedOrigin: string) {
    let value = Buffer.from(secret).toString("utf8");
    try {
      const result = await this.callDocument(
        `function(selector, value, expectedOrigin) {
        if (location.origin !== expectedOrigin) throw new Error('secret origin changed before fill');
        const element = this.querySelector(selector);
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) throw new Error('fillable element not found');
        if (element.disabled || element.readOnly || element.type === 'hidden') throw new Error('element is not fillable');
        element.focus();
        element.setAttribute('data-co-secret-filled', 'true');
        element.style.setProperty('-webkit-text-security', 'disc', 'important');
        element.style.setProperty('color', 'transparent', 'important');
        element.style.setProperty('text-shadow', '0 0 7px rgba(0,0,0,.65)', 'important');
        element.style.setProperty('caret-color', 'transparent', 'important');
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return { filled: true };
      }`,
        [selector, value, expectedOrigin],
        true,
      );
      if (
        !result ||
        typeof result !== "object" ||
        (result as { filled?: unknown }).filled !== true
      ) {
        throw new Error("secret field injection was not confirmed");
      }
      return { filled: true as const };
    } finally {
      value = "";
    }
  }

  async click(selector: string) {
    const previousUrl = await this.evaluate("location.href");
    const startedAt = Date.now();
    let clickError: unknown = null;
    try {
      await this.callDocument(
        `function(selector) {
        const element = this.querySelector(selector);
        if (!(element instanceof HTMLElement)) throw new Error('clickable element not found');
        element.click();
        return true;
      }`,
        [selector],
        true,
      );
    } catch (error) {
      // A successful form submission can destroy the execution context before CDP returns the
      // function result. Never click again: observe the resulting document instead.
      clickError = error;
    }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const state = (await this.evaluate(
          "({ href: location.href, ready: document.readyState })",
        )) as {
          href?: unknown;
          ready?: unknown;
        };
        if (
          state &&
          typeof state === "object" &&
          (state.ready === "complete" || state.ready === "interactive") &&
          (state.href !== previousUrl || (!clickError && Date.now() - startedAt >= 250))
        )
          return;
      } catch {
        // Keep polling while Chrome swaps execution contexts for the new document.
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (clickError instanceof Error) throw clickError;
    throw new Error("browser click did not settle");
  }

  async screenshot() {
    await this.callDocument(
      `function() {
      let style = this.getElementById('co-vault-screenshot-mask');
      if (!style) {
        style = this.createElement('style');
        style.id = 'co-vault-screenshot-mask';
        this.documentElement.append(style);
      }
      style.textContent = '[data-co-secret-filled="true"] {' +
        'color: transparent !important;' +
        'text-shadow: 0 0 7px rgba(0,0,0,.65) !important;' +
        '-webkit-text-security: disc !important;' +
        'caret-color: transparent !important;' +
      '}';
      return true;
    }`,
      [],
      true,
    );
    const response = await this.cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    });
    if (typeof response.data !== "string") throw new Error("browser did not return a screenshot");
    return response.data;
  }

  async secretFieldPresentation(selector: string) {
    return this.callDocument(
      `function(selector) {
      const element = this.querySelector(selector);
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) throw new Error('secret element not found');
      const style = getComputedStyle(element);
      return {
        marked: element.getAttribute('data-co-secret-filled') === 'true',
        text_security: style.webkitTextSecurity,
        color: style.color,
        caret_color: style.caretColor,
        value_length: element.value.length,
      };
    }`,
      [selector],
      true,
    ) as Promise<{
      marked: boolean;
      text_security: string;
      color: string;
      caret_color: string;
      value_length: number;
    }>;
  }

  methodAudit() {
    return this.cdp.audit();
  }

  close() {
    this.cdp.close();
  }

  async evaluate(expression: string) {
    const response = (await this.cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      generatePreview: false,
    })) as RuntimeResult;
    if (response.exceptionDetails) throw new Error("browser evaluation failed");
    return response.result?.value;
  }

  async callDocument(functionDeclaration: string, values: unknown[], returnByValue: boolean) {
    const documentResult = (await this.cdp.send("Runtime.evaluate", {
      expression: "document",
      returnByValue: false,
      generatePreview: false,
    })) as RuntimeResult;
    const objectId = documentResult.result?.objectId;
    if (!objectId) throw new Error("browser document unavailable");
    try {
      const response = (await this.cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration,
        arguments: values.map((value) => ({ value })),
        returnByValue,
        awaitPromise: true,
        userGesture: true,
        generatePreview: false,
        silent: true,
      })) as RuntimeResult;
      if (response.exceptionDetails) throw new Error("browser function failed");
      return response.result?.value;
    } finally {
      // Cross-document navigation invalidates remote object ids. Releasing an already-destroyed
      // handle is harmless and must not turn a successful navigation into a failed tool call.
      await this.cdp.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
    }
  }
}
