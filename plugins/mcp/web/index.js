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

// ../../../../../../../../elowen/packages/plugin-ui-kit/shims/react.cjs
var require_react = __commonJS({
  "../../../../../../../../elowen/packages/plugin-ui-kit/shims/react.cjs"(exports, module) {
    "use strict";
    var runtime2 = typeof window !== "undefined" ? window.ElowenUiRuntime : void 0;
    if (!runtime2) throw new Error("elowen-plugin-ui-kit: window.ElowenUiRuntime is missing \u2014 plugin bundles only run inside the Elowen web app");
    module.exports = runtime2.react;
  }
});

// ../../../../../../../../elowen/packages/plugin-ui-kit/shims/jsx-runtime.cjs
var require_jsx_runtime = __commonJS({
  "../../../../../../../../elowen/packages/plugin-ui-kit/shims/jsx-runtime.cjs"(exports, module) {
    "use strict";
    var runtime2 = typeof window !== "undefined" ? window.ElowenUiRuntime : void 0;
    if (!runtime2) throw new Error("elowen-plugin-ui-kit: window.ElowenUiRuntime is missing \u2014 plugin bundles only run inside the Elowen web app");
    module.exports = runtime2.jsxRuntime;
  }
});

// plugins/mcp/web-src/runtime.ts
var DATA_TABLE_ICON_SIZE = 12;
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

// web/node_modules/lucide-react/dist/esm/icons/search.js
var Search = createLucideIcon("Search", [
  ["circle", { cx: "11", cy: "11", r: "8", key: "4ej97u" }],
  ["path", { d: "m21 21-4.3-4.3", key: "1qie3q" }]
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

// web/node_modules/lucide-react/dist/esm/icons/triangle-alert.js
var TriangleAlert = createLucideIcon("TriangleAlert", [
  [
    "path",
    {
      d: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3",
      key: "wmoenq"
    }
  ],
  ["path", { d: "M12 9v4", key: "juzpu7" }],
  ["path", { d: "M12 17h.01", key: "p32p05" }]
]);

// web/node_modules/lucide-react/dist/esm/icons/wrench.js
var Wrench = createLucideIcon("Wrench", [
  [
    "path",
    {
      d: "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
      key: "cbrjhi"
    }
  ]
]);

// plugins/mcp/web-src/McpServersPage.tsx
var import_jsx_runtime = __toESM(require_jsx_runtime(), 1);
var PAGE_SIZE = 20;
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
function allServers(data) {
  return [...data.personal, ...data.instance];
}
function serverKey(server) {
  return `${server.scope}:${server.name}`;
}
function filterServers(servers, query, scope) {
  const needle = query.trim().toLowerCase();
  return servers.filter((server) => {
    if (scope !== "all" && server.scope !== scope) return false;
    if (needle === "") return true;
    return `${server.name} ${server.transport} ${server.url ?? ""} ${server.command ?? ""}`.toLowerCase().includes(needle);
  });
}
function statusLabel(server, strings) {
  if (server.status === "connected") return strings.statusConnected;
  if (server.status === "error") return strings.statusError;
  if (server.status === "disabled") return strings.statusDisabled;
  return strings.statusDisconnected;
}
function statusDot(server) {
  if (server.status === "connected") return "bg-success";
  if (server.status === "error") return "bg-danger";
  return "bg-text-muted/50";
}
function scopeLabel(scope, strings) {
  return scope === "instance" ? strings.scopeInstance : strings.scopePersonal;
}
function McpServerRow({ server, showScope, selected, onOpen }) {
  const { components: C, hooks } = runtime();
  const s = hooks.usePluginStrings("mcp");
  const label = statusLabel(server, s);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    C.DataTableRow,
    {
      selected,
      "aria-selected": selected,
      onOpen,
      openLabel: s.openServer.replace("{name}", server.name),
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(C.DataTableCell, { lines: "auto", title: label, className: "flex items-center justify-center", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: `h-2 w-2 rounded-full ${statusDot(server)}`, "aria-hidden": true }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "sr-only", children: label })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.DataTableCell, { lines: 1, title: server.name, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "flex w-full min-w-0 items-center gap-2", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "truncate text-sm text-text", children: server.name }),
          !server.enabled ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Badge, { tone: "muted", children: s.statusDisabled }) : null
        ] }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.DataTableCell, { priority: "wide", lines: "auto", className: "whitespace-nowrap", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Badge, { children: server.transport.toUpperCase() }) }),
        showScope ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.DataTableCell, { priority: "wide", lines: 1, className: "text-xs text-text-muted", children: scopeLabel(server.scope, s) }) : null,
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.DataTableCell, { priority: "wide", lines: 1, className: "text-xs text-text-muted", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "flex items-center gap-1.5", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Wrench, { size: DATA_TABLE_ICON_SIZE, "aria-hidden": true }),
          server.toolCount
        ] }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.DataTableCell, { priority: "wide", lines: 1, title: server.lastError ?? label, className: "text-xs text-text-muted", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "flex min-w-0 items-center gap-1.5", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "shrink-0", children: server.lastError ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(TriangleAlert, { size: DATA_TABLE_ICON_SIZE, "aria-hidden": true }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(PlugZap, { size: DATA_TABLE_ICON_SIZE, "aria-hidden": true }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: `truncate ${server.lastError ? "text-danger" : ""}`, children: server.lastError ?? label })
        ] }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.DataTableChevronCell, {})
      ]
    }
  );
}
function ServerEditor({ server, draft, saving, busy, error, canManageInstance, onChange, onSave, onReconnect, onRemove, onShowTools }) {
  const { components: C, hooks } = runtime();
  const s = hooks.usePluginStrings("mcp");
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex flex-col gap-3", children: [
    server ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex flex-col gap-2", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex flex-wrap items-center gap-2", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Badge, { children: server.transport.toUpperCase() }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Badge, { tone: server.status === "connected" ? "accent" : server.status === "error" ? "danger" : "muted", children: statusLabel(server, s) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Badge, { tone: "muted", children: scopeLabel(server.scope, s) })
      ] }),
      server.lastError ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "text-xs text-danger", children: server.lastError }) : null
    ] }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "grid grid-cols-1 gap-3 sm:grid-cols-2", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Field, { label: s.name, htmlFor: "mcp-name", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Input, { id: "mcp-name", value: draft.name, disabled: Boolean(server), onChange: (event) => onChange({ ...draft, name: event.target.value }) }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Field, { label: s.scope, hint: s.scopeHelp, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        C.SelectMenu,
        {
          label: s.scope,
          value: draft.scope,
          onChange: (scope) => onChange({ ...draft, scope }),
          options: [
            { value: "personal", label: s.scopePersonal },
            ...canManageInstance ? [{ value: "instance", label: s.scopeInstance }] : []
          ]
        }
      ) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "sm:col-span-2", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Field, { label: s.transport, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        C.SelectMenu,
        {
          label: s.transport,
          value: draft.transport,
          onChange: (transport) => onChange({ ...draft, transport }),
          options: [{ value: "stdio", label: "stdio" }, { value: "http", label: "HTTP" }, { value: "sse", label: "SSE" }]
        }
      ) }) }),
      draft.transport === "stdio" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "sm:col-span-2", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Field, { label: s.command, hint: s.commandHelp, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Input, { value: draft.command, onChange: (event) => onChange({ ...draft, command: event.target.value }) }) }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Field, { label: s.arguments, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("textarea", { className: "min-h-24 rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-text", value: draft.args, onChange: (event) => onChange({ ...draft, args: event.target.value }) }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Field, { label: s.environment, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("textarea", { className: "min-h-24 rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-text", value: draft.env, onChange: (event) => onChange({ ...draft, env: event.target.value }) }) })
      ] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "sm:col-span-2", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Field, { label: s.url, htmlFor: "mcp-url", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Input, { id: "mcp-url", value: draft.url, onChange: (event) => onChange({ ...draft, url: event.target.value }) }) }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "sm:col-span-2", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Toggle, { checked: draft.enabled, onChange: (enabled) => onChange({ ...draft, enabled }), label: s.enabled }) })
    ] }),
    server ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.DetailBlock, { icon: Wrench, title: s.tools, hint: s.toolsHint, children: server.tools.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "text-xs text-text-muted", children: s.noTools }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      C.SelectionSummary,
      {
        readOnly: true,
        countText: s.toolsCount.replace("{n}", String(server.tools.length)),
        samples: server.tools.slice(0, 3).map((tool) => ({
          label: tool.title || tool.name,
          // Bridged tools carry no icon of their own, so they all wear the generic wrench the
          // user detail falls back to — the chips stay aligned with the ones there.
          icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Wrench, { size: 12, className: "inline" })
        })),
        moreCount: Math.max(0, server.tools.length - 3),
        onManage: onShowTools,
        manageLabel: s.viewTools,
        manageAriaLabel: `${s.viewTools}: ${server.name}`
      }
    ) }) : null,
    error ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "text-sm text-danger", role: "alert", children: error }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3", children: [
      server ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Button, { variant: "ghost-danger", icon: Trash2, onClick: onRemove, disabled: busy, children: s.removeServer }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {}),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex flex-wrap items-center gap-2", children: [
        server ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Button, { variant: "ghost", icon: RefreshCw, onClick: onReconnect, disabled: busy, children: s.reconnectServer }) : null,
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Button, { variant: "accent", onClick: onSave, disabled: busy, children: saving ? s.saving : s.save })
      ] })
    ] })
  ] });
}
function McpServersPage() {
  const { components: C, hooks, utils } = runtime();
  const s = hooks.usePluginStrings("mcp");
  const { t } = hooks.useTranslation();
  const [data, setData] = (0, import_react3.useState)();
  const [loading, setLoading] = (0, import_react3.useState)(true);
  const [loadError, setLoadError] = (0, import_react3.useState)(false);
  const [query, setQuery] = (0, import_react3.useState)("");
  const [scope, setScope] = (0, import_react3.useState)("all");
  const [page, setPage] = (0, import_react3.useState)(0);
  const [editor, setEditor] = (0, import_react3.useState)();
  const [saving, setSaving] = (0, import_react3.useState)(false);
  const [busy, setBusy] = (0, import_react3.useState)(false);
  const [actionError, setActionError] = (0, import_react3.useState)();
  const [removing, setRemoving] = (0, import_react3.useState)();
  const [showTools, setShowTools] = (0, import_react3.useState)(false);
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
  const canManageInstance = data?.canManageInstance === true;
  const rows = (0, import_react3.useMemo)(() => data ? allServers(data) : [], [data]);
  const filtered = (0, import_react3.useMemo)(() => filterServers(rows, query, scope), [rows, query, scope]);
  (0, import_react3.useEffect)(() => {
    setPage(0);
  }, [query, scope]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageItems = (0, import_react3.useMemo)(() => filtered.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE), [filtered, clampedPage]);
  const connected = rows.filter((server) => server.status === "connected").length;
  const failing = rows.filter((server) => server.status === "error").length;
  const bridged = rows.reduce((total, server) => total + server.toolCount, 0);
  const selected = editor?.key != null ? rows.find((server) => serverKey(server) === editor.key) : void 0;
  const closeEditor = () => {
    setEditor(void 0);
    setActionError(void 0);
    setShowTools(false);
  };
  const save = async () => {
    if (!editor) return;
    setSaving(true);
    setBusy(true);
    setActionError(void 0);
    try {
      if (selected && editor.draft.scope !== selected.scope) {
        await apiJson("/plugins/mcp/api/transfer", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fromScope: selected.scope, name: selected.name, toScope: editor.draft.scope })
        });
      }
      const path = selected ? `/plugins/mcp/api/servers/${encodeURIComponent(selected.name)}` : "/plugins/mcp/api/servers";
      await apiJson(path, {
        method: selected ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(serverPayload(editor.draft))
      });
      setEditor(void 0);
      await load();
    } catch (error) {
      setActionError(utils.apiErrorMessage(error) || s.saveError);
      await load();
    } finally {
      setSaving(false);
      setBusy(false);
    }
  };
  const reconnect = async () => {
    if (!selected) return;
    setBusy(true);
    setActionError(void 0);
    try {
      await apiJson("/plugins/mcp/api/reconnect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: selected.scope, name: selected.name })
      });
      await load();
    } catch {
      setActionError(s.actionError);
    } finally {
      setBusy(false);
    }
  };
  const removeServer = async () => {
    const target = removing;
    setRemoving(void 0);
    if (!target) return;
    setBusy(true);
    setActionError(void 0);
    try {
      await apiJson(`/plugins/mcp/api/servers/${encodeURIComponent(target.name)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: target.scope })
      });
      setEditor(void 0);
      await load();
    } catch {
      setActionError(s.actionError);
    } finally {
      setBusy(false);
    }
  };
  const openServer = (server) => {
    setActionError(void 0);
    setEditor({ key: serverKey(server), draft: serverDraft(server) });
  };
  const addServer = () => {
    setActionError(void 0);
    setEditor({ key: null, draft: emptyDraft("personal") });
  };
  const addButton = /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Button, { variant: "accent", icon: Plus, onClick: addServer, children: s.addServer });
  const table = /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex min-w-0 flex-col gap-3", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      C.DataTable,
      {
        ariaLabel: s.title,
        columns: canManageInstance ? "2rem minmax(0,1fr) 6rem 7rem 5rem minmax(0,10rem) 1.25rem" : "2rem minmax(0,1fr) 6rem 5rem minmax(0,10rem) 1.25rem",
        compactColumns: "2rem minmax(0,1fr) 1.25rem",
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(C.DataTableRow, { header: true, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.DataTableCell, { header: true, labelHidden: true, lines: 1, children: s.colStatus }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.DataTableCell, { header: true, lines: 1, children: s.name }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.DataTableCell, { header: true, priority: "wide", lines: 1, children: s.transport }),
            canManageInstance ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.DataTableCell, { header: true, priority: "wide", lines: 1, children: s.scope }) : null,
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.DataTableCell, { header: true, priority: "wide", lines: 1, children: s.tools }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.DataTableCell, { header: true, priority: "wide", lines: 1, children: s.colStatus })
          ] }),
          pageItems.map((server) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            McpServerRow,
            {
              server,
              showScope: canManageInstance,
              selected: editor?.key === serverKey(server),
              onOpen: () => openServer(server)
            },
            serverKey(server)
          ))
        ]
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Pager, { page: clampedPage, pageSize: PAGE_SIZE, total: filtered.length, onPageChange: setPage, ariaLabel: s.title })
  ] });
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    C.WorkspaceShell,
    {
      variant: "register",
      hero: {
        eyebrow: t.pluginUi.eyebrow,
        title: s.title,
        count: rows.length,
        description: s.description,
        icon: Blocks,
        mascot: loadError ? "error" : loading ? "saving" : "idle",
        status: !loading && !loadError ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "workspace-status", children: s.workspaceReady }) : void 0,
        action: addButton,
        metrics: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.WorkspaceMetric, { label: s.statusConnected, value: connected, icon: PlugZap }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.WorkspaceMetric, { label: s.statusError, value: failing, icon: TriangleAlert }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.WorkspaceMetric, { label: s.tools, value: bridged, icon: Wrench })
        ] })
      },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.ControlSurfaceDocument, { children: loadError ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.ControlSurfaceState, { tone: "danger", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.ErrorState, { message: s.loadError, onRetry: () => void load() }) }) : loading || !data ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.ControlSurfaceState, { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.LoadingState, { variant: "cards" }) }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex min-w-0 flex-col gap-4", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.ControlSurfaceToolbar, { className: "flex-col items-stretch", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex min-w-0 flex-wrap items-center gap-2 py-3", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.RegisterSearch, { value: query, onChange: setQuery, placeholder: s.searchPlaceholder, label: s.searchPlaceholder }),
            canManageInstance ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              C.Segmented,
              {
                value: scope,
                onChange: (value) => setScope(value),
                options: [{ value: "all", label: s.filterAll }, { value: "personal", label: s.scopePersonal }, { value: "instance", label: s.scopeInstance }],
                "aria-label": s.scope,
                nowrap: true
              }
            ) : null
          ] }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.ControlSurfaceRegister, { className: "flex flex-col gap-4", children: rows.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.EmptyState, { title: s.empty, icon: Server, action: addButton }) : filtered.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.EmptyState, { title: s.emptySearch, icon: Search }) : table })
        ] }) }),
        editor ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.WorkspaceDetailRail, { label: selected ? selected.name : s.addServer, closeLabel: t.common.close, onClose: closeEditor, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          ServerEditor,
          {
            server: selected,
            draft: editor.draft,
            saving,
            busy,
            error: actionError,
            canManageInstance,
            onChange: (draft) => setEditor((current) => current ? { ...current, draft } : current),
            onSave: () => void save(),
            onReconnect: () => void reconnect(),
            onRemove: () => {
              if (selected) setRemoving(selected);
            },
            onShowTools: () => setShowTools(true)
          }
        ) }) : null,
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          C.ManageSelectionModal,
          {
            readOnly: true,
            open: showTools && (selected?.tools.length ?? 0) > 0,
            title: s.tools,
            subtitle: selected?.name,
            onClose: () => setShowTools(false),
            items: (selected?.tools ?? []).map((tool) => ({
              id: tool.name,
              label: tool.title || tool.name,
              group: "",
              disabledHint: tool.description
            })),
            countLabel: (n) => s.toolsCount.replace("{n}", String(n))
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          C.ConfirmDialog,
          {
            open: Boolean(removing),
            title: removing ? s.removeConfirm.replace("{name}", removing.name) : "",
            confirmLabel: s.removeServer,
            onClose: () => setRemoving(void 0),
            onConfirm: () => void removeServer()
          }
        )
      ]
    }
  );
}

// plugins/mcp/web-src/index.tsx
registerMcpUi({
  // 8: the register composes WorkspaceShell, Pager, RegisterSearch and DataTableChevronCell.
  requiresApiVersion: 8,
  pages: { "": McpServersPage }
});
