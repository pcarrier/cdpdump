import { decodeBase64 } from "@std/encoding";
import { Protocol } from "devtools-protocol";
import {
  compress,
  init,
} from "https://deno.land/x/zstd_wasm@0.0.21/deno/zstd.ts";

class CDPClient {
  nextId = 1;
  // deno-lint-ignore no-explicit-any
  handlers: Map<number, (arg: any) => void> = new Map();
  // deno-lint-ignore no-explicit-any
  expectations: Map<string, (data: any) => void> = new Map();
  socket: WebSocket;

  constructor(url: string) {
    this.socket = new WebSocket(url);
  }

  async start() {
    this.socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      const handler = this.handlers.get(data.id);
      if (handler) {
        handler(data);
        this.handlers.delete(data.id);
      } else {
        const key = `${data.method}/${data.sessionId}`;
        const expectation = this.expectations.get(key);
        if (expectation) {
          expectation(data);
          this.expectations.delete(key);
        }
      }
    };
    await new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = reject;
    });
  }

  expect(eventName: string, sessionId: string) {
    return new Promise((resolve) => {
      this.expectations.set(`${eventName}/${sessionId}`, resolve);
    });
  }

  _send<Q, R>(
    method: string,
    params: Q,
    sessionId: string | undefined,
    handler: (
      data: { result: R } | { error: { code: number; message: string } }
    ) => void
  ) {
    const id = this.nextId++;
    this.handlers.set(id, handler);
    this.socket.send(JSON.stringify({ id, method, params, sessionId }));
  }

  call<Q, R>(method: string, params: Q, sessionId: string | undefined) {
    return new Promise<R>((resolve, reject) =>
      this._send(method, params, sessionId, (data) => {
        if ("error" in data) {
          reject(new Error(`${data.error.code}: ${data.error.message}`));
        } else {
          resolve(data.result as R);
        }
      })
    );
  }

  async listPages(): Promise<Protocol.Target.TargetInfo[]> {
    return (
      (await this.call(
        "Target.getTargets",
        { filter: [{ type: "page", exclude: false }] },
        undefined
      )) as Protocol.Target.GetTargetsResponse
    ).targetInfos;
  }

  async attachToTarget(targetId: string) {
    return (
      (await this.call(
        "Target.attachToTarget",
        { targetId, flatten: true },
        undefined
      )) as Protocol.Target.AttachToTargetResponse
    ).sessionId;
  }

  async getA11yTree(sessionId: string) {
    const frameTree = (
      (await this.call(
        "Page.getFrameTree",
        {},
        sessionId
      )) as Protocol.Page.GetFrameTreeResponse
    ).frameTree;
    const frameIds: string[] = [];
    function collectFrameIDs(tree: Protocol.Page.FrameTree) {
      frameIds.push(tree.frame.id);
      tree.childFrames?.forEach(collectFrameIDs);
    }
    collectFrameIDs(frameTree);
    const a11yTrees = (await Promise.all(
      frameIds.map((frameId) => {
        try {
          return this.call(
            "Accessibility.getFullAXTree",
            { frameId },
            sessionId
          );
        } catch (e) {
          console.error(e);
          return null;
        }
      })
    )) as (Protocol.Accessibility.GetFullAXTreeResponse | null)[];
    const res: Record<string, Protocol.Accessibility.AXNode[] | undefined> = {};
    frameIds.forEach((frameId, idx) => {
      res[frameId] = a11yTrees[idx]?.nodes;
    });
    return res;
  }
}

async function grabUrlFromStealthium() {
  const url = Deno.env.get("STEALTHIUM_URL") || "http://localhost:19222";
  const settings = Deno.env.get("LAUNCH_SETTINGS");
  if (settings) {
    const launchUrl = URL.parse(url);
    if (launchUrl) {
      launchUrl.protocol = launchUrl.protocol.replace("http", "ws");
      launchUrl.pathname += "launch";
      launchUrl.searchParams.set("env", settings);
      return launchUrl.toString();
    }
  }
  const browserURLs = (await (await fetch(url)).json()).browsers;
  if (browserURLs.length === 0) {
    throw new Error("No browsers found");
  }
  const browserURL = browserURLs[0];
  const browserData = (await (await fetch(browserURL)).json())[0];
  const wsUrl = browserData.webSocketDebuggerUrl.replace(
    new RegExp("/devtools/.*"),
    ""
  );
  console.log("Debug @", browserData.devtoolsFrontendUrl);
  console.log("WS @", wsUrl);
  return wsUrl;
}

if (import.meta.main) {
  const url = Deno.env.get("URL") || (await grabUrlFromStealthium());
  if (!url) {
    Deno.exit(1);
  }
  const client = new CDPClient(url);
  await client.start();
  console.log("Connected to", url);

  const pages = await client.listPages();
  let page;
  if (pages.length === 0) {
    console.error("No pages found");
    Deno.exit(1);
  } else if (pages.length === 1) {
    page = pages[0];
  } else {
    pages.forEach((page, idx) => {
      console.log(`${idx}. ${page.url}`);
    });
    const choice = Number(prompt("Which do you want to dump?"));
    page = pages[choice];
  }

  performance.mark("started");

  const sessionId = await client.attachToTarget(page.targetId);
  await client.call("Accessibility.enable", {}, sessionId);
  await client.call("DOMSnapshot.enable", {}, sessionId);
  await client.call("Page.enable", {}, sessionId);

  performance.mark("ready");

  const goTo = Deno.args.shift();
  if (goTo !== undefined) {
    const expectation = client.expect("Page.loadEventFired", sessionId);
    await client.call("Page.navigate", { url: goTo }, sessionId);
    await expectation;
  }

  performance.mark("loaded");

  const dom = await client.call(
    "DOMSnapshot.captureSnapshot",
    {
      computedStyles: ["display", "visibility", "opacity"],
      includeDOMRects: true,
    },
    sessionId
  );

  performance.mark("domFinished");

  const a11y = await client.getA11yTree(sessionId);

  performance.mark("a11yFinished");

  const screenShot = decodeBase64(
    (
      (await client.call(
        "Page.captureScreenshot",
        { format: "png", optimizeForSpeed: true },
        sessionId
      )) as Protocol.Page.CaptureScreenshotResponse
    ).data
  );

  performance.mark("screenShotFinished");

  const pageShot = decodeBase64(
    (
      (await client.call(
        "Page.captureScreenshot",
        { format: "png", captureBeyondViewport: true, optimizeForSpeed: true },
        sessionId
      )) as Protocol.Page.CaptureScreenshotResponse
    ).data
  );

  performance.mark("pageShotFinished");

  const pdf = decodeBase64(
    (
      (await client.call(
        "Page.printToPDF",
        {},
        sessionId
      )) as Protocol.Page.PrintToPDFResponse
    ).data
  );
  performance.mark("pdfFinished");

  performance.measure("readiness", "started", "ready");
  if (goTo !== undefined) performance.measure("load", "ready", "loaded");
  performance.measure("dom", "loaded", "domFinished");
  performance.measure("a11y", "domFinished", "a11yFinished");
  performance.measure("screen shot", "a11yFinished", "screenShotFinished");
  performance.measure("so far", "started", "screenShotFinished");
  performance.measure("page shot", "screenShotFinished", "pageShotFinished");
  performance.measure("PDF", "pageShotFinished", "pdfFinished");

  performance.measure("total", "started", "pdfFinished");

  console.table(
    performance.getEntriesByType("measure").map(({ name, duration }) => ({
      name,
      duration: duration.toFixed(2),
    }))
  );

  const domJSON = JSON.stringify(dom);
  const a11yJSON = JSON.stringify(a11y);

  await init();
  Deno.writeFileSync("pageshot.png", pageShot);
  Deno.writeFileSync("screenshot.png", screenShot);
  Deno.writeFileSync("page.pdf", pdf);
  Deno.writeFileSync(
    "dom.json.zst",
    compress(new TextEncoder().encode(domJSON))
  );
  Deno.writeFileSync(
    "a11y.json.zst",
    compress(new TextEncoder().encode(a11yJSON))
  );
  Deno.exit(0);
}
