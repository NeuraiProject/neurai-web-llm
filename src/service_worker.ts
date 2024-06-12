import * as tvmjs from "tvmjs";
import log from "loglevel";
import { AppConfig, ChatOptions, MLCEngineConfig } from "./config";
import { ReloadParams, WorkerRequest, WorkerResponse } from "./message";
import { MLCEngineInterface, InitProgressReport } from "./types";
import {
  MLCEngineWorkerHandler,
  WebWorkerMLCEngine,
  ChatWorker,
} from "./web_worker";
import { areChatOptionsEqual } from "./utils";

/* Service Worker Script */

type IServiceWorker = globalThis.ServiceWorker;

/**
 * Worker handler that can be used in a ServiceWorker.
 *
 * @example
 *
 * const engine = new MLCEngine();
 * let handler;
 * chrome.runtime.onConnect.addListener(function (port) {
 *   if (handler === undefined) {
 *     handler = new MLCEngineServiceWorkerHandler(engine, port);
 *   } else {
 *     handler.setPort(port);
 *   }
 *   port.onMessage.addListener(handler.onmessage.bind(handler));
 * });
 */
export class MLCEngineServiceWorkerHandler extends MLCEngineWorkerHandler {
  modelId?: string;
  chatOpts?: ChatOptions;
  appConfig?: AppConfig;

  private clientRegistry = new Map<
    string,
    IServiceWorker | Client | MessagePort
  >();
  private initRequestUuid?: string;

  constructor(engine: MLCEngineInterface) {
    if (!self || !("addEventListener" in self)) {
      throw new Error(
        "MLCEngineServiceWorkerHandler must be created in the service worker script.",
      );
    }
    const customInitProgressCallback = engine.getInitProgressCallback();
    super(engine);
    const onmessage = this.onmessage.bind(this);

    this.engine.setInitProgressCallback((report: InitProgressReport) => {
      const msg: WorkerResponse = {
        kind: "initProgressCallback",
        uuid: this.initRequestUuid || "",
        content: report,
      };
      this.postMessage(msg);
      customInitProgressCallback?.(report);
    });

    self.addEventListener("message", (event) => {
      const message = event as unknown as ExtendableMessageEvent;
      if (message.source) {
        this.clientRegistry.set(message.data.uuid, message.source);
      }
      message.waitUntil(
        new Promise((resolve, reject) => {
          onmessage(message, resolve, reject);
        }),
      );
    });
  }

  postMessage(message: WorkerResponse) {
    if (this.clientRegistry.has(message.uuid)) {
      const client = this.clientRegistry.get(message.uuid);
      client?.postMessage(message);

      if (message.kind === "return" || message.kind === "throw") {
        this.clientRegistry.delete(message.uuid);
      } else {
        // TODO(nestor): Delete clientRegistry after complete to avoid memory leak?
      }
    }
  }

  onmessage(
    event: ExtendableMessageEvent,
    onComplete?: (value: any) => void,
    onError?: () => void,
  ): void {
    const msg = event.data as WorkerRequest;
    log.trace(
      `ServiceWorker message: [${msg.kind}] ${JSON.stringify(msg.content)}`,
    );

    if (msg.kind === "keepAlive") {
      const reply: WorkerResponse = {
        kind: "heartbeat",
        uuid: msg.uuid,
      };
      this.postMessage(reply);
      onComplete?.(reply);
      return;
    }

    if (msg.kind === "reload") {
      this.handleTask(msg.uuid, async () => {
        const params = msg.content as ReloadParams;
        // If the modelId, chatOpts, and appConfig are the same, immediately return
        if (
          this.modelId === params.modelId &&
          areChatOptionsEqual(this.chatOpts, params.chatOpts)
        ) {
          log.info("Already loaded the model. Skip loading");
          const gpuDetectOutput = await tvmjs.detectGPUDevice();
          if (gpuDetectOutput == undefined) {
            throw Error("Cannot find WebGPU in the environment");
          }
          let gpuLabel = "WebGPU";
          if (gpuDetectOutput.adapterInfo.description.length != 0) {
            gpuLabel += " - " + gpuDetectOutput.adapterInfo.description;
          } else {
            gpuLabel += " - " + gpuDetectOutput.adapterInfo.vendor;
          }
          this.engine.getInitProgressCallback()?.({
            progress: 1,
            timeElapsed: 0,
            text: "Finish loading on " + gpuLabel,
          });
          onComplete?.(null);
          return null;
        }

        this.initRequestUuid = msg.uuid;
        await this.engine.reload(params.modelId, params.chatOpts);
        this.modelId = params.modelId;
        this.chatOpts = params.chatOpts;
        onComplete?.(null);
        return null;
      });
      return;
    }
    super.onmessage(msg, onComplete, onError);
  }
}

/* Webapp Client */
export class ServiceWorker implements ChatWorker {
  _onmessage: (event: MessageEvent) => void = () => {};

  get onmessage() {
    return this._onmessage;
  }

  set onmessage(handler: (event: any) => void) {
    this._onmessage = handler;

    if (!("serviceWorker" in navigator)) {
      throw new Error("Service worker API is not available");
    }
    (navigator.serviceWorker as ServiceWorkerContainer).onmessage = handler;
  }

  postMessage(message: WorkerRequest) {
    if (!("serviceWorker" in navigator)) {
      throw new Error("Service worker API is not available");
    }
    const serviceWorker = (navigator.serviceWorker as ServiceWorkerContainer)
      .controller;
    if (!serviceWorker) {
      throw new Error("There is no active service worker");
    }
    serviceWorker.postMessage(message);
  }
}

/**
 * Create a ServiceWorkerMLCEngine.
 *
 * @param modelId The model to load, needs to either be in `webllm.prebuiltAppConfig`, or in
 * `engineConfig.appConfig`.
 * @param engineConfig Optionally configures the engine, see `webllm.MLCEngineConfig` for more.
 * @returns An initialized `WebLLM.ServiceWorkerMLCEngine` with `modelId` loaded.
 */
export async function CreateServiceWorkerMLCEngine(
  modelId: string,
  engineConfig?: MLCEngineConfig,
  chatOpts?: ChatOptions,
  keepAliveMs = 10000,
): Promise<ServiceWorkerMLCEngine> {
  if (!("serviceWorker" in navigator)) {
    throw new Error(
      "Service worker API is not available in your browser. Please ensure that your browser supports service workers and that you are using a secure context (HTTPS). " +
        "Check the browser compatibility and ensure that service workers are not disabled in your browser settings.",
    );
  }
  const serviceWorkerAPI = navigator.serviceWorker as ServiceWorkerContainer;
  const registration = await serviceWorkerAPI.ready;
  const serviceWorker = registration.active || serviceWorkerAPI.controller;
  if (!serviceWorker) {
    throw new Error(
      "Service worker failed to initialize. This could be due to a failure in the service worker registration process or because the service worker is not active. " +
        "Please refresh the page to retry initializing the service worker.",
    );
  }
  const serviceWorkerMLCEngine = new ServiceWorkerMLCEngine(
    engineConfig,
    keepAliveMs,
  );
  await serviceWorkerMLCEngine.reload(modelId, chatOpts);
  return serviceWorkerMLCEngine;
}

/**
 * A client of MLCEngine that exposes the same interface
 */
export class ServiceWorkerMLCEngine extends WebWorkerMLCEngine {
  missedHeatbeat = 0;

  constructor(engineConfig?: MLCEngineConfig, keepAliveMs = 10000) {
    if (!("serviceWorker" in navigator)) {
      throw new Error("Service worker API is not available");
    }
    super(new ServiceWorker(), engineConfig);

    // Keep alive through periodical heartbeat signals
    setInterval(() => {
      this.worker.postMessage({ kind: "keepAlive", uuid: crypto.randomUUID() });
      this.missedHeatbeat += 1;
      log.trace("missedHeatbeat", this.missedHeatbeat);
    }, keepAliveMs);
  }

  onmessage(event: any): void {
    const msg = event.data;
    log.trace(
      `MLC client message: [${msg.kind}] ${JSON.stringify(msg.content)}`,
    );
    try {
      if (msg.kind === "heartbeat") {
        this.missedHeatbeat = 0;
        return;
      }
      super.onmessage(msg);
    } catch (err: any) {
      // This is expected to throw if user has multiple windows open
      if (!err.message.startsWith("return from a unknown uuid")) {
        log.error("CreateWebServiceWorkerMLCEngine.onmessage", err);
      }
    }
  }
}
