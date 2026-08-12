var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// packages/plugin-ui-kit/shims/react.cjs
var require_react = __commonJS({
  "packages/plugin-ui-kit/shims/react.cjs"(exports, module) {
    "use strict";
    var runtime2 = typeof window !== "undefined" ? window.ElowenUiRuntime : void 0;
    if (!runtime2) throw new Error("@elowen/plugin-ui-kit: window.ElowenUiRuntime is missing \u2014 plugin bundles only run inside the Elowen web app");
    module.exports = runtime2.react;
  }
});

// packages/plugin-ui-kit/shims/jsx-runtime.cjs
var require_jsx_runtime = __commonJS({
  "packages/plugin-ui-kit/shims/jsx-runtime.cjs"(exports, module) {
    "use strict";
    var runtime2 = typeof window !== "undefined" ? window.ElowenUiRuntime : void 0;
    if (!runtime2) throw new Error("@elowen/plugin-ui-kit: window.ElowenUiRuntime is missing \u2014 plugin bundles only run inside the Elowen web app");
    module.exports = runtime2.jsxRuntime;
  }
});

// plugins/whatsapp/web-src/runtime.ts
function runtime() {
  const rt = window.ElowenUiRuntime;
  if (!rt) throw new Error("ElowenUiRuntime is not installed");
  return rt;
}
function registerWhatsAppUi(registration) {
  window.__elowenRegisterPluginUi?.("whatsapp", registration);
}

// plugins/whatsapp/web-src/PairingSettings.tsx
var import_react3 = __toESM(require_react(), 1);

// web/node_modules/lucide-react/dist/esm/createLucideIcon.js
var import_react2 = __toESM(require_react());

// web/node_modules/lucide-react/dist/esm/shared/src/utils.js
var toKebabCase = (string) => string.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
var mergeClasses = (...classes) => classes.filter((className, index, array) => {
  return Boolean(className) && className.trim() !== "" && array.indexOf(className) === index;
}).join(" ").trim();

// web/node_modules/lucide-react/dist/esm/Icon.js
var import_react = __toESM(require_react());

// web/node_modules/lucide-react/dist/esm/defaultAttributes.js
var defaultAttributes = {
  xmlns: "http://www.w3.org/2000/svg",
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round"
};

// web/node_modules/lucide-react/dist/esm/Icon.js
var Icon = (0, import_react.forwardRef)(
  ({
    color = "currentColor",
    size = 24,
    strokeWidth = 2,
    absoluteStrokeWidth,
    className = "",
    children,
    iconNode,
    ...rest
  }, ref) => {
    return (0, import_react.createElement)(
      "svg",
      {
        ref,
        ...defaultAttributes,
        width: size,
        height: size,
        stroke: color,
        strokeWidth: absoluteStrokeWidth ? Number(strokeWidth) * 24 / Number(size) : strokeWidth,
        className: mergeClasses("lucide", className),
        ...rest
      },
      [
        ...iconNode.map(([tag, attrs]) => (0, import_react.createElement)(tag, attrs)),
        ...Array.isArray(children) ? children : [children]
      ]
    );
  }
);

// web/node_modules/lucide-react/dist/esm/createLucideIcon.js
var createLucideIcon = (iconName, iconNode) => {
  const Component = (0, import_react2.forwardRef)(
    ({ className, ...props }, ref) => (0, import_react2.createElement)(Icon, {
      ref,
      iconNode,
      className: mergeClasses(`lucide-${toKebabCase(iconName)}`, className),
      ...props
    })
  );
  Component.displayName = `${iconName}`;
  return Component;
};

// web/node_modules/lucide-react/dist/esm/icons/circle-check.js
var CircleCheck = createLucideIcon("CircleCheck", [
  ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
  ["path", { d: "m9 12 2 2 4-4", key: "dzmm74" }]
]);

// web/node_modules/lucide-react/dist/esm/icons/qr-code.js
var QrCode = createLucideIcon("QrCode", [
  ["rect", { width: "5", height: "5", x: "3", y: "3", rx: "1", key: "1tu5fj" }],
  ["rect", { width: "5", height: "5", x: "16", y: "3", rx: "1", key: "1v8r4q" }],
  ["rect", { width: "5", height: "5", x: "3", y: "16", rx: "1", key: "1x03jg" }],
  ["path", { d: "M21 16h-3a2 2 0 0 0-2 2v3", key: "177gqh" }],
  ["path", { d: "M21 21v.01", key: "ents32" }],
  ["path", { d: "M12 7v3a2 2 0 0 1-2 2H7", key: "8crl2c" }],
  ["path", { d: "M3 12h.01", key: "nlz23k" }],
  ["path", { d: "M12 3h.01", key: "n36tog" }],
  ["path", { d: "M12 16v.01", key: "133mhm" }],
  ["path", { d: "M16 12h1", key: "1slzba" }],
  ["path", { d: "M21 12v.01", key: "1lwtk9" }],
  ["path", { d: "M12 21v-1", key: "1880an" }]
]);

// web/node_modules/lucide-react/dist/esm/icons/refresh-cw.js
var RefreshCw = createLucideIcon("RefreshCw", [
  ["path", { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8", key: "v9h5vc" }],
  ["path", { d: "M21 3v5h-5", key: "1q7to0" }],
  ["path", { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16", key: "3uifl3" }],
  ["path", { d: "M8 16H3v5", key: "1cv678" }]
]);

// web/node_modules/lucide-react/dist/esm/icons/unlink.js
var Unlink = createLucideIcon("Unlink", [
  [
    "path",
    {
      d: "m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71",
      key: "yqzxt4"
    }
  ],
  [
    "path",
    {
      d: "m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71",
      key: "4qinb0"
    }
  ],
  ["line", { x1: "8", x2: "8", y1: "2", y2: "5", key: "1041cp" }],
  ["line", { x1: "2", x2: "5", y1: "8", y2: "8", key: "14m1p5" }],
  ["line", { x1: "16", x2: "16", y1: "19", y2: "22", key: "rzdirn" }],
  ["line", { x1: "19", x2: "22", y1: "16", y2: "16", key: "ox905f" }]
]);

// plugins/whatsapp/web-src/PairingSettings.tsx
var import_jsx_runtime = __toESM(require_jsx_runtime(), 1);
var pairing = () => runtime().api("/plugins/whatsapp/pairing");
var pair = () => runtime().api("/plugins/whatsapp/pair", { method: "POST" });
var unpair = () => runtime().api("/plugins/whatsapp/unpair", { method: "POST" });
function PairingSettings() {
  const { components: C, hooks } = runtime();
  const s = hooks.usePluginStrings("whatsapp");
  const [open, setOpen] = (0, import_react3.useState)(false);
  const [connected, setConnected] = (0, import_react3.useState)(null);
  const [confirmUnpair, setConfirmUnpair] = (0, import_react3.useState)(false);
  const refreshStatus = async () => {
    try {
      const st = await pairing();
      setConnected(st.connected);
    } catch {
      setConnected(null);
    }
  };
  (0, import_react3.useEffect)(() => {
    void refreshStatus();
  }, []);
  const doUnpair = async () => {
    setConfirmUnpair(false);
    try {
      await unpair();
    } catch {
    }
    await refreshStatus();
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.SettingsGroup, { className: "plugin-card", icon: QrCode, title: s.pairTitle, description: s.pairHint, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "settings-group__panel space-y-3", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "flex flex-wrap items-center gap-2", children: connected ? (
      // Paired state reads from the action itself — the red "Unpair" is only shown when linked,
      // so no redundant "connected!" banner is needed.
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Button, { variant: "danger", icon: Unlink, onClick: () => setConfirmUnpair(true), children: s.unpairButton })
    ) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Button, { variant: "accent", icon: QrCode, onClick: () => setOpen(true), children: s.pairButton }) }),
    open ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(PairModal, { onClose: () => {
      setOpen(false);
      void refreshStatus();
    } }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      C.ConfirmDialog,
      {
        open: confirmUnpair,
        title: s.unpairButton,
        description: s.unpairConfirm,
        confirmLabel: s.unpairButton,
        onConfirm: doUnpair,
        onClose: () => setConfirmUnpair(false)
      }
    )
  ] }) });
}
function PairModal({ onClose }) {
  const { components: C, hooks } = runtime();
  const s = hooks.usePluginStrings("whatsapp");
  const [state, setState] = (0, import_react3.useState)(null);
  const [error, setError] = (0, import_react3.useState)(false);
  const timer = (0, import_react3.useRef)(null);
  const stop = () => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  };
  (0, import_react3.useEffect)(() => {
    let alive = true;
    const poll = async () => {
      try {
        const st = await pairing();
        if (!alive) return;
        setState(st);
        setError(false);
        if (st.connected) stop();
      } catch {
        if (alive) setError(true);
      }
    };
    void (async () => {
      try {
        await pair();
      } catch {
        if (alive) setError(true);
      }
      await poll();
    })();
    timer.current = setInterval(poll, 1500);
    return () => {
      alive = false;
      stop();
    };
  }, []);
  const refresh = async () => {
    try {
      await pair();
      setError(false);
    } catch {
      setError(true);
    }
  };
  const connected = state?.connected === true;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(C.Modal, { title: s.pairModalTitle, icon: QrCode, size: "sm", onClose, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.ModalBody, { children: error ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "text-sm text-danger", children: s.pairError }) : connected ? (
      // Success is shown by the check + the footer flipping to "OK"; no wording needed.
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "flex flex-col items-center gap-3 py-8 text-center", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(CircleCheck, { size: 48, className: "text-success", "aria-hidden": true }) })
    ) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex flex-col items-center gap-4 py-2 text-center", children: [
      state?.qrImage ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "text-sm text-text-muted", children: s.pairScan }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("img", { src: state.qrImage, alt: "WhatsApp QR", width: 280, height: 280, className: "rounded-md bg-white p-2" })
      ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "py-6 text-sm text-text-muted", children: s.pairWaiting }),
      state?.code ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "w-full border-t border-border pt-3", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "text-sm text-text-muted", children: s.pairCode }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "mt-1 font-mono text-2xl font-bold tracking-widest text-text", children: state.code })
      ] }) : null
    ] }) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(C.ModalFooter, { children: [
      !connected && !error ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Button, { variant: "ghost", icon: RefreshCw, onClick: refresh, children: s.pairRefresh }) : null,
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Button, { variant: "accent", onClick: onClose, children: connected ? "OK" : s.close })
    ] })
  ] });
}

// plugins/whatsapp/web-src/index.tsx
registerWhatsAppUi({
  requiresApiVersion: 1,
  settings: {
    "pairing": PairingSettings
  }
});
