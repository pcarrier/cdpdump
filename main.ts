import { decodeBase64 } from "@std/encoding";
import { Protocol } from "devtools-protocol";

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
        switch (data.method) {
          case "Target.attachedToTarget":
            {
              const params =
                data.params as Protocol.Target.AttachedToTargetEvent;
              console.log(
                `Attached to ${params.targetInfo.url} with session ${params.sessionId}`
              );
            }
            break;
          default: {
            const key = `${data.method}/${data.sessionId}`;
            const expectation = this.expectations.get(key);
            if (expectation) {
              expectation(data);
              this.expectations.delete(key);
            }
          }
        }
      }
    };
    await new Promise((resolve) => (this.socket.onopen = resolve));
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
  const browserURLs = (await (await fetch("http://localhost:19222")).json())
    .browsers;
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

  const screenshot = decodeBase64(
    (
      (await client.call(
        "Page.captureScreenshot",
        { format: "png", captureBeyondViewport: true, optimizeForSpeed: true },
        sessionId
      )) as Protocol.Page.CaptureScreenshotResponse
    ).data
  );

  performance.mark("screenshotFinished");

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

  const dom = await client.call(
    "DOMSnapshot.captureSnapshot",
    { computedStyles: ["display"], includeDOMRects: true },
    sessionId
  );

  performance.mark("domFinished");

  const a11y = await client.getA11yTree(sessionId);

  performance.mark("a11yFinished");

  performance.measure("readiness", "started", "ready");
  performance.measure("load", "ready", "loaded");
  performance.measure("screenshot", "ready", "screenshotFinished");
  performance.measure("pdf", "screenshotFinished", "pdfFinished");
  performance.measure("dom", "pdfFinished", "domFinished");
  performance.measure("a11y", "domFinished", "a11yFinished");
  console.table(
    performance.getEntriesByType("measure").map(({ name, duration }) => ({
      name,
      duration: duration.toFixed(2),
    }))
  );

  Deno.writeFileSync("screenshot.png", screenshot);
  Deno.writeFileSync("page.pdf", pdf);
  Deno.writeTextFileSync("dom.json", JSON.stringify(dom));
  Deno.writeTextFileSync("a11y.json", JSON.stringify(a11y));
  Deno.exit(0);
}
