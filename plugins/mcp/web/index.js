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
    if (!runtime2) throw new Error("elowen-plugin-ui-kit: window.ElowenUiRuntime is missing \u2014 plugin bundles only run inside the Elowen web app");
    module.exports = runtime2.react;
  }
});

// packages/plugin-ui-kit/shims/jsx-runtime.cjs
var require_jsx_runtime = __commonJS({
  "packages/plugin-ui-kit/shims/jsx-runtime.cjs"(exports, module) {
    "use strict";
    var runtime2 = typeof window !== "undefined" ? window.ElowenUiRuntime : void 0;
    if (!runtime2) throw new Error("elowen-plugin-ui-kit: window.ElowenUiRuntime is missing \u2014 plugin bundles only run inside the Elowen web app");
    module.exports = runtime2.jsxRuntime;
  }
});

// plugins/mcp/web-src/runtime.ts
function runtime() {
  const value = window.ElowenUiRuntime;
  if (!value) throw new Error("ElowenUiRuntime is not installed");
  return value;
}
async function apiJson(path, init) {
  return await runtime().api(path, init);
}
function registerMcpUi(registration) {
  window.__elowenRegisterPluginUi?.("mcp", registration);
}

// plugins/mcp/web-src/McpServersPage.tsx
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

// web/node_modules/lucide-react/dist/esm/icons/blocks.js
var Blocks = createLucideIcon("Blocks", [
  ["rect", { width: "7", height: "7", x: "14", y: "3", rx: "1", key: "6d4xhi" }],
  [
    "path",
    {
      d: "M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3",
      key: "1fpvtg"
    }
  ]
]);

// web/node_modules/lucide-react/dist/esm/icons/plug-zap.js
var PlugZap = createLucideIcon("PlugZap", [
  [
    "path",
    { d: "M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z", key: "goz73y" }
  ],
  ["path", { d: "m2 22 3-3", key: "19mgm9" }],
  ["path", { d: "M7.5 13.5 10 11", key: "7xgeeb" }],
  ["path", { d: "M10.5 16.5 13 14", key: "10btkg" }],
  ["path", { d: "m18 3-4 4h6l-4 4", key: "16psg9" }]
]);

// web/node_modules/lucide-react/dist/esm/icons/plus.js
var Plus = createLucideIcon("Plus", [
  ["path", { d: "M5 12h14", key: "1ays0h" }],
  ["path", { d: "M12 5v14", key: "s699le" }]
]);

// web/node_modules/lucide-react/dist/esm/icons/refresh-cw.js
var RefreshCw = createLucideIcon("RefreshCw", [
  ["path", { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8", key: "v9h5vc" }],
  ["path", { d: "M21 3v5h-5", key: "1q7to0" }],
  ["path", { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16", key: "3uifl3" }],
  ["path", { d: "M8 16H3v5", key: "1cv678" }]
]);

// web/node_modules/lucide-react/dist/esm/icons/server.js
var Server = createLucideIcon("Server", [
  ["rect", { width: "20", height: "8", x: "2", y: "2", rx: "2", ry: "2", key: "ngkwjq" }],
  ["rect", { width: "20", height: "8", x: "2", y: "14", rx: "2", ry: "2", key: "iecqi9" }],
  ["line", { x1: "6", x2: "6.01", y1: "6", y2: "6", key: "16zg32" }],
  ["line", { x1: "6", x2: "6.01", y1: "18", y2: "18", key: "nzw8ys" }]
]);

// web/node_modules/lucide-react/dist/esm/icons/trash-2.js
var Trash2 = createLucideIcon("Trash2", [
  ["path", { d: "M3 6h18", key: "d0wm0j" }],
  ["path", { d: "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6", key: "4alrt4" }],
  ["path", { d: "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2", key: "v07s0e" }],
  ["line", { x1: "10", x2: "10", y1: "11", y2: "17", key: "1uufr5" }],
  ["line", { x1: "14", x2: "14", y1: "11", y2: "17", key: "xtxkd" }]
]);

// plugins/mcp/web-src/McpServersPage.tsx
var import_jsx_runtime = __toESM(require_jsx_runtime(), 1);
var emptyDraft = (scope) => ({
  scope,
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  env: "",
  url: "",
  enabled: true
});
function serverDraft(server) {
  return {
    scope: server.scope,
    name: server.name,
    transport: server.transport,
    command: server.command ?? "",
    args: (server.args ?? []).join("\n"),
    env: Object.entries(server.env ?? {}).map(([key, value]) => `${key}=${value}`).join("\n"),
    url: server.url ?? "",
    enabled: server.enabled
  };
}
function parseEnvironment(value) {
  return Object.fromEntries(value.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const at = line.indexOf("=");
    return at < 1 ? [line, ""] : [line.slice(0, at).trim(), line.slice(at + 1)];
  }));
}
function serverPayload(draft) {
  return draft.transport === "stdio" ? {
    scope: draft.scope,
    name: draft.name.trim(),
    transport: draft.transport,
    command: draft.command.trim(),
    args: draft.args.split("\n").map((line) => line.trim()).filter(Boolean),
    env: parseEnvironment(draft.env),
    enabled: draft.enabled
  } : { scope: draft.scope, name: draft.name.trim(), transport: draft.transport, url: draft.url.trim(), enabled: draft.enabled };
}
function statusLabel(server, strings) {
  if (server.status === "connected") return strings.statusConnected;
  if (server.status === "error") return strings.statusError;
  if (server.status === "disabled") return strings.statusDisabled;
  return strings.statusDisconnected;
}
function ServerCard({ server, strings, onEdit, onRemove, onReconnect, onTools }) {
  const { Button, Badge, SelectionSummary } = runtime().components;
  const samples = server.tools.slice(0, 3).map((tool) => ({ label: tool.title || tool.name }));
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex flex-col gap-3 rounded-xl border border-border bg-surface p-4", style: { boxShadow: "var(--shadow-card)" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex flex-wrap items-start justify-between gap-3", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex min-w-0 items-center gap-3", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-elevated text-text-muted", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Server, { size: 17 }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "min-w-0", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex flex-wrap items-center gap-2", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "truncate text-sm font-medium text-text", children: server.name }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, { children: server.transport.toUpperCase() }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Badge, { tone: server.status === "connected" ? "accent" : "muted", children: statusLabel(server, strings) })
          ] }),
          server.lastError ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "mt-1 text-xs text-danger", children: server.lastError }) : null
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex flex-wrap gap-2", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Button, { size: "sm", variant: "ghost", onClick: onReconnect, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(RefreshCw, { size: 13 }),
          strings.reconnectServer
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, { size: "sm", variant: "ghost", onClick: onEdit, children: strings.editServer }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Button, { size: "sm", variant: "ghost", onClick: onRemove, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Trash2, { size: 13 }),
          strings.removeServer
        ] })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      SelectionSummary,
      {
        variant: "line",
        countText: strings.toolsCount.replace("{n}", String(server.toolCount)),
        samples,
        moreCount: Math.max(0, server.tools.length - samples.length),
        onManage: onTools,
        manageLabel: strings.viewTools,
        manageAriaLabel: `${strings.viewTools}: ${server.name}`
      }
    )
  ] });
}
function ServerForm({ draft, editing, strings, saving, error, onChange, onSave, onClose, canManageInstance }) {
  const { Modal, ModalBody, ModalFooter, Button, Input, Field, HelpTip, Toggle, SelectMenu } = runtime().components;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Modal, { title: editing ? strings.editServer : strings.addServer, onClose, size: "md", icon: PlugZap, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ModalBody, { children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "grid gap-4 sm:grid-cols-2", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: strings.name, htmlFor: "mcp-name", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Input, { id: "mcp-name", value: draft.name, disabled: editing, onChange: (event) => onChange({ ...draft, name: event.target.value }) }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex flex-col gap-1.5", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-text-muted", children: [
          strings.scope,
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(HelpTip, { align: "left", children: strings.scopeHelp })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SelectMenu, { label: strings.scope, value: draft.scope, onChange: (scope) => onChange({ ...draft, scope }), options: [
          { value: "personal", label: strings.scopePersonal },
          ...canManageInstance ? [{ value: "instance", label: strings.scopeInstance }] : []
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex flex-col gap-1.5 sm:col-span-2", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "text-xs font-medium uppercase tracking-wide text-text-muted", children: strings.transport }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SelectMenu, { label: strings.transport, value: draft.transport, onChange: (transport) => onChange({ ...draft, transport }), options: [
          { value: "stdio", label: "stdio" },
          { value: "http", label: "HTTP" },
          { value: "sse", label: "SSE" }
        ] })
      ] }),
      draft.transport === "stdio" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex flex-col gap-1.5 sm:col-span-2", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-text-muted", children: [
            strings.command,
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(HelpTip, { align: "left", children: strings.commandHelp })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Input, { value: draft.command, onChange: (event) => onChange({ ...draft, command: event.target.value }) })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: strings.arguments, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("textarea", { className: "min-h-24 rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-text", value: draft.args, onChange: (event) => onChange({ ...draft, args: event.target.value }) }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: strings.environment, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("textarea", { className: "min-h-24 rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-text", value: draft.env, onChange: (event) => onChange({ ...draft, env: event.target.value }) }) })
      ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: strings.url, htmlFor: "mcp-url", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Input, { id: "mcp-url", value: draft.url, onChange: (event) => onChange({ ...draft, url: event.target.value }) }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "sm:col-span-2", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Toggle, { checked: draft.enabled, onChange: (enabled) => onChange({ ...draft, enabled }), label: strings.enabled }) }),
      error ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "text-sm text-danger sm:col-span-2", role: "alert", children: error }) : null
    ] }) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(ModalFooter, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, { variant: "ghost", onClick: onClose, children: strings.cancel }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Button, { onClick: onSave, disabled: saving, children: saving ? strings.saving : strings.save })
    ] })
  ] });
}
function McpServersPage({ surface }) {
  const { components, hooks } = runtime();
  const { PluginPageHeader, SettingsDocument, SettingsGroup, Button, LoadingState, ErrorState, EmptyState, ConfirmDialog, ManageSelectionModal } = components;
  const strings = hooks.usePluginStrings("mcp");
  const [data, setData] = (0, import_react3.useState)();
  const [loading, setLoading] = (0, import_react3.useState)(true);
  const [loadError, setLoadError] = (0, import_react3.useState)(false);
  const [draft, setDraft] = (0, import_react3.useState)();
  const [editingName, setEditingName] = (0, import_react3.useState)();
  const [saving, setSaving] = (0, import_react3.useState)(false);
  const [actionError, setActionError] = (0, import_react3.useState)();
  const [remove, setRemove] = (0, import_react3.useState)();
  const [tools, setTools] = (0, import_react3.useState)();
  const load = (0, import_react3.useCallback)(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      setData(await apiJson("/plugins/mcp/api/servers"));
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);
  (0, import_react3.useEffect)(() => {
    void load();
  }, [load]);
  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setActionError(void 0);
    try {
      const path = editingName ? `/plugins/mcp/api/servers/${encodeURIComponent(editingName)}` : "/plugins/mcp/api/servers";
      await apiJson(path, { method: editingName ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(serverPayload(draft)) });
      setDraft(void 0);
      setEditingName(void 0);
      await load();
    } catch {
      setActionError(strings.saveError);
    } finally {
      setSaving(false);
    }
  };
  const reconnect = async (server) => {
    await apiJson("/plugins/mcp/api/reconnect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: server.scope, name: server.name }) });
    await load();
  };
  const removeServer = async () => {
    if (!remove) return;
    await apiJson(`/plugins/mcp/api/servers/${encodeURIComponent(remove.name)}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: remove.scope }) });
    setRemove(void 0);
    await load();
  };
  const openCreate = (scope) => {
    setEditingName(void 0);
    setActionError(void 0);
    setDraft(emptyDraft(scope));
  };
  const openEdit = (server) => {
    setEditingName(server.name);
    setActionError(void 0);
    setDraft(serverDraft(server));
  };
  const groups = (0, import_react3.useMemo)(() => [
    { scope: "personal", title: strings.personalTitle, description: strings.personalDescription, servers: data?.personal ?? [], empty: strings.emptyPersonal },
    ...data?.canManageInstance ? [{ scope: "instance", title: strings.instanceTitle, description: strings.instanceDescription, servers: data.instance, empty: strings.emptyInstance }] : []
  ], [data, strings]);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    surface === "page" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(PluginPageHeader, { title: strings.title, description: strings.description, icon: Blocks, action: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Button, { onClick: () => openCreate("personal"), children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Plus, { size: 14 }),
      strings.addServer
    ] }) }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SettingsDocument, { children: loading ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(LoadingState, { variant: "cards" }) : loadError ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ErrorState, { message: strings.loadError, onRetry: load }) : groups.map((group) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SettingsGroup, { title: group.title, description: group.description, actions: surface === "deck" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(Button, { size: "sm", onClick: () => openCreate(group.scope), children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Plus, { size: 13 }),
      strings.addServer
    ] }) : void 0, children: group.servers.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(EmptyState, { title: group.empty, icon: Server }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "grid gap-3", children: group.servers.map((server) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ServerCard, { server, strings, onEdit: () => openEdit(server), onRemove: () => setRemove(server), onReconnect: () => void reconnect(server), onTools: () => setTools(server) }, server.name)) }) }, group.scope)) }),
    draft ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ServerForm, { draft, editing: Boolean(editingName), strings, saving, error: actionError, onChange: setDraft, onSave: () => void save(), onClose: () => {
      setDraft(void 0);
      setEditingName(void 0);
      setActionError(void 0);
    }, canManageInstance: data?.canManageInstance === true }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ConfirmDialog, { open: Boolean(remove), title: remove ? strings.removeConfirm.replace("{name}", remove.name) : "", confirmLabel: strings.removeServer, onClose: () => setRemove(void 0), onConfirm: () => void removeServer() }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      ManageSelectionModal,
      {
        open: Boolean(tools),
        title: tools ? `${strings.tools}: ${tools.name}` : strings.tools,
        subtitle: tools?.tools.length ? void 0 : strings.noTools,
        onClose: () => setTools(void 0),
        items: (tools?.tools ?? []).map((tool) => ({ id: tool.name, label: tool.title || tool.name, group: "", disabled: true, disabledHint: tool.description })),
        selected: new Set((tools?.tools ?? []).map((tool) => tool.name)),
        onSave: () => setTools(void 0),
        countLabel: (n) => strings.toolsCount.replace("{n}", String(n))
      }
    )
  ] });
}

// plugins/mcp/web-src/index.tsx
registerMcpUi({
  requiresApiVersion: 2,
  pages: { "": McpServersPage }
});
