/**
 * Worker-thread entry for one code-mode cell, plus the in-context bootstrap that installs the
 * globals the `exec` description promises.
 *
 * WHY THE GLOBALS ARE DEFINED BY A SOURCE STRING INSIDE THE CONTEXT.
 *
 * Codex runs the model's JavaScript in its own V8 isolate whose globals are native function
 * templates, so the script holds no reference to any other realm. Node's `vm` gives a context, not
 * an isolate: any FUNCTION placed directly on the sandbox stays an object of THIS realm, and
 * `text.constructor.constructor('return process')()` walks straight out of the sandbox into the
 * worker, where `require` and `process` are real. A naive port of the Codex design is not a sandbox.
 *
 * So the bootstrap runs inside the context, captures the one foreign bridge function in a closure,
 * deletes it from `globalThis`, and from then on everything crossing the boundary in either
 * direction is a JSON string. A primitive carries no prototype, so there is nothing to walk.
 *
 * This file is plain ESM rather than TypeScript so the same path works in tests and in `dist/`
 * without a compile step; its host-side counterpart `cell.ts` carries the protocol types.
 */
import { parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';

/** Thrown by `exit()` and recognised as clean success, mirroring Codex's `EXIT_SENTINEL`. */
const EXIT_SENTINEL = '__elowen_code_mode_exit__';

const BOOTSTRAP_SOURCE = String.raw`
(function bootstrap(send, configJson) {
  'use strict';

  var config = JSON.parse(configJson);
  var EXIT_SENTINEL = config.exitSentinel;

  // Codex deletes these four intrinsics from the isolate; do the same so the advertised contract
  // ("no console") is true rather than aspirational.
  delete globalThis.console;
  delete globalThis.Atomics;
  delete globalThis.SharedArrayBuffer;
  delete globalThis.WebAssembly;

  var pendingToolCalls = new Map();
  var nextToolCallId = 0;
  var timeouts = new Map();
  var nextTimeoutId = 0;
  var storedValues = new Map(Object.entries(JSON.parse(config.storedValuesJson)));
  var storedWrites = new Map();
  var exitRequested = false;

  function emit(message) {
    send(JSON.stringify(message));
  }

  function throwText(message) {
    // Codex throws a bare string rather than a TypeError, so a catch clause sees a string here too.
    throw message;
  }

  /** Mirrors Codex serialize_output_text. */
  function serializeOutputText(value) {
    var kind = typeof value;
    if (value === null || value === undefined || kind === 'string' || kind === 'number' || kind === 'boolean' || kind === 'bigint') {
      return String(value);
    }
    var serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  }

  function requireDataUrl(imageUrl) {
    if (typeof imageUrl !== 'string' || imageUrl.length === 0) {
      throwText('Tool call failed: invalid image output. Pass a base64 data URI instead');
    }
    var scheme = imageUrl.slice(0, 8).toLowerCase();
    if (scheme.indexOf('http:') === 0 || scheme.indexOf('https:') === 0) {
      throwText('Tool call failed: remote image URLs are not supported in tool outputs. Pass a base64 data URI instead');
    }
    if (imageUrl.slice(0, 5).toLowerCase() !== 'data:') {
      throwText('Tool call failed: invalid image output. Pass a base64 data URI instead');
    }
    return imageUrl;
  }

  function normalizeDetail(detail) {
    if (detail === null || detail === undefined) return undefined;
    if (detail === 'auto' || detail === 'low' || detail === 'high') return detail;
    throwText('Tool call failed: invalid image detail. Use "auto", "low" or "high"');
  }

  function appendItem(item) {
    emit({ type: 'item', item: item });
  }

  globalThis.text = function text(value) {
    appendItem({ type: 'text', text: serializeOutputText(value) });
  };

  globalThis.image = function image(imageUrlOrItem, detail) {
    var url;
    var embeddedDetail;
    if (typeof imageUrlOrItem === 'string') {
      url = imageUrlOrItem;
    } else if (imageUrlOrItem && typeof imageUrlOrItem === 'object') {
      url = imageUrlOrItem.image_url !== undefined ? imageUrlOrItem.image_url : imageUrlOrItem.imageUrl;
      embeddedDetail = imageUrlOrItem.detail;
      if (url === undefined && typeof imageUrlOrItem.data === 'string' && typeof imageUrlOrItem.mimeType === 'string') {
        // A tool image block, as returned inside result.content.
        url = 'data:' + imageUrlOrItem.mimeType + ';base64,' + imageUrlOrItem.data;
      }
    }
    var resolvedDetail = normalizeDetail(detail !== undefined ? detail : embeddedDetail);
    var item = { type: 'image', imageUrl: requireDataUrl(url) };
    if (resolvedDetail !== undefined) item.detail = resolvedDetail;
    appendItem(item);
  };

  globalThis.generatedImage = function generatedImage(result) {
    if (!result || typeof result !== 'object') {
      throwText('Tool call failed: invalid image output. Pass a base64 data URI instead');
    }
    appendItem({ type: 'image', imageUrl: requireDataUrl(result.image_url) });
    if (typeof result.output_hint === 'string' && result.output_hint.length > 0) {
      appendItem({ type: 'text', text: result.output_hint });
    }
  };

  globalThis.notify = function notify(value) {
    var serialized = serializeOutputText(value);
    if (serialized.trim().length === 0) throwText('notify expects non-empty text');
    emit({ type: 'notify', text: serialized });
  };

  globalThis.store = function store(key, value) {
    if (typeof key !== 'string') throwText('store expects a string key');
    var serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throwText('Unable to store "' + key + '". Only plain serializable objects can be stored.');
    }
    var parsed = JSON.parse(serialized);
    // Visible to load immediately inside this cell; committed to the session only on completion.
    storedValues.set(key, parsed);
    storedWrites.set(key, parsed);
  };

  globalThis.load = function load(key) {
    if (typeof key !== 'string') throwText('load expects a string key');
    return storedValues.has(key) ? storedValues.get(key) : undefined;
  };

  globalThis.exit = function exit() {
    exitRequested = true;
    throw EXIT_SENTINEL;
  };

  globalThis.yield_control = function yield_control() {
    emit({ type: 'yieldRequested' });
  };

  globalThis.setTimeout = function setTimeout(callback, delayMs) {
    if (typeof callback !== 'function') throwText('setTimeout expects a function callback');
    nextTimeoutId += 1;
    var id = nextTimeoutId;
    timeouts.set(id, callback);
    var delay = typeof delayMs === 'number' && isFinite(delayMs) && delayMs > 0 ? delayMs : 0;
    emit({ type: 'timer', id: id, delayMs: delay });
    return id;
  };

  globalThis.clearTimeout = function clearTimeout(timeoutId) {
    if (typeof timeoutId !== 'number' || !isFinite(timeoutId) || timeoutId <= 0) return;
    if (timeouts.delete(timeoutId)) emit({ type: 'timerCleared', id: timeoutId });
  };

  var tools = Object.create(null);
  for (var index = 0; index < config.tools.length; index += 1) {
    (function defineTool(tool) {
      tools[tool.globalName] = function callTool(input) {
        nextToolCallId += 1;
        var id = 'tool-' + nextToolCallId;
        return new Promise(function executor(resolve, reject) {
          pendingToolCalls.set(id, { resolve: resolve, reject: reject });
          emit({
            type: 'toolCall',
            id: id,
            name: tool.name,
            kind: tool.kind,
            inputJson: input === undefined ? undefined : JSON.stringify(input),
          });
        });
      };
    })(config.tools[index]);
  }
  globalThis.tools = tools;

  globalThis.ALL_TOOLS = config.tools.map(function metadata(tool) {
    return { name: tool.globalName, description: tool.description };
  });

  function deliver(payloadJson) {
    var payload = JSON.parse(payloadJson);
    if (payload.type === 'toolResult') {
      var entry = pendingToolCalls.get(payload.id);
      if (!entry) return;
      pendingToolCalls.delete(payload.id);
      // Codex rejects with a plain string, not an Error, so catch (e) sees the message itself.
      if (payload.ok) entry.resolve(payload.resultJson === undefined ? undefined : JSON.parse(payload.resultJson));
      else entry.reject(payload.error);
      return;
    }
    if (payload.type === 'timerFired') {
      var callback = timeouts.get(payload.id);
      if (!callback) return;
      timeouts.delete(payload.id);
      callback();
    }
  }

  function takeStoredWrites() {
    var out = {};
    storedWrites.forEach(function copy(value, key) {
      out[key] = value;
    });
    return JSON.stringify(out);
  }

  function isExitException(error) {
    return exitRequested && error === EXIT_SENTINEL;
  }

  function describeError(error) {
    if (error && typeof error === 'object' && typeof error.stack === 'string') return error.stack;
    return String(error);
  }

  // The bridge is reachable only through this closure from here on.
  delete globalThis.__codeModeSend;
  delete globalThis.__codeModeConfig;

  return {
    deliver: deliver,
    takeStoredWrites: takeStoredWrites,
    isExitException: isExitException,
    describeError: describeError,
  };
})(globalThis.__codeModeSend, globalThis.__codeModeConfig)
`;

const port = parentPort;
if (port === null) throw new Error('code-mode cell worker must run as a worker thread');

const data = workerData;

const sandbox = {
  __codeModeSend: (json) => {
    port.postMessage(JSON.parse(json));
  },
  __codeModeConfig: JSON.stringify({
    exitSentinel: EXIT_SENTINEL,
    storedValuesJson: JSON.stringify(data.storedValues ?? {}),
    tools: data.tools ?? [],
  }),
};

const context = vm.createContext(sandbox, {
  name: 'code-mode-cell',
  codeGeneration: { strings: true, wasm: false },
});

const control = vm.runInContext(BOOTSTRAP_SOURCE, context, { filename: 'code_mode_bootstrap.js' });

port.on('message', (message) => {
  // Every delivery crosses as a primitive string, so no host object ever enters the context.
  control.deliver(JSON.stringify(message));
});

async function run() {
  port.postMessage({ type: 'started' });

  let errorText;
  try {
    // An async IIFE gives top-level await without --experimental-vm-modules. `import` is still
    // rejected, matching Codex, because no dynamic import callback is installed for this context.
    const evaluate = vm.runInContext(`(async () => {\n${data.source}\n})`, context, {
      filename: 'exec_main.mjs',
    });
    await evaluate();
  } catch (error) {
    if (!control.isExitException(error)) errorText = control.describeError(error);
  }

  port.postMessage({ type: 'result', errorText, storedWritesJson: control.takeStoredWrites() });
}

run().catch((error) => {
  // A failure here is a harness fault, not a script fault; report it as the cell's error so the
  // model is told something went wrong instead of waiting for a result that never comes.
  port.postMessage({
    type: 'result',
    errorText: error instanceof Error ? (error.stack ?? error.message) : String(error),
    storedWritesJson: '{}',
  });
});
