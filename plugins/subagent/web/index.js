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

// plugins/subagent/web-src/runtime.ts
function runtime() {
  const rt = window.ElowenUiRuntime;
  if (!rt) throw new Error("ElowenUiRuntime is not installed");
  return rt;
}
function registerSubagentUi(registration) {
  window.__elowenRegisterPluginUi?.("subagent", registration);
}

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

// web/node_modules/lucide-react/dist/esm/icons/git-fork.js
var GitFork = createLucideIcon("GitFork", [
  ["circle", { cx: "12", cy: "18", r: "3", key: "1mpf1b" }],
  ["circle", { cx: "6", cy: "6", r: "3", key: "1lh9wr" }],
  ["circle", { cx: "18", cy: "6", r: "3", key: "1h7g24" }],
  ["path", { d: "M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9", key: "1uq4wg" }],
  ["path", { d: "M12 12v3", key: "158kv8" }]
]);

// plugins/subagent/web-src/SubagentsSettings.tsx
var import_jsx_runtime = __toESM(require_jsx_runtime(), 1);
var selectClass = "w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-text focus:border-accent";
var EMPTY_FORM = { editing: null, name: "", description: "", body: "", toolsMode: "read-only", customTools: "" };
function SubagentsSettings() {
  const { components: C, hooks } = runtime();
  const s = hooks.usePluginStrings("subagent");
  const query = hooks.usePluginSubagents();
  const save = hooks.useSavePluginSubagent();
  const remove = hooks.useDeletePluginSubagent();
  const toolsLabel = (tools) => Array.isArray(tools) ? tools.join(", ") : { "read-only": s.toolsReadOnly, all: s.toolsAll, inherit: s.toolsInherit }[tools];
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.SettingsGroup, { className: "plugin-card", icon: GitFork, title: s.title, description: s.sectionHint, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "settings-group__panel", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    C.MarkdownAssetEditor,
    {
      query,
      labels: {
        empty: s.empty,
        badgeUser: s.badgeUser,
        badgeBuiltin: s.badgeBuiltin,
        add: s.add,
        edit: s.edit,
        remove: s.remove,
        save: s.save,
        cancel: s.cancel,
        name: s.name,
        nameHint: s.helpName,
        namePlaceholder: "reviewer",
        description: s.description,
        descriptionHint: s.helpDescription,
        body: s.body,
        bodyHint: s.helpBody,
        bodyPlaceholder: s.bodyPlaceholder,
        created: s.created,
        updated: s.updated,
        deleted: s.deleted,
        deleteTitle: s.deleteTitle,
        deleteDesc: s.deleteDesc
      },
      emptyForm: EMPTY_FORM,
      formFromItem: (agent) => ({
        editing: agent.name,
        name: agent.name,
        description: agent.description,
        body: agent.body ?? "",
        toolsMode: Array.isArray(agent.tools) ? "custom" : agent.tools,
        customTools: Array.isArray(agent.tools) ? agent.tools.join(", ") : ""
      }),
      extraValid: (form) => form.toolsMode !== "custom" || form.customTools.trim() !== "",
      renderBadges: (agent) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Badge, { tone: "default", children: toolsLabel(agent.tools) }),
      renderFieldsBeforeBody: (form, patch) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Field, { label: s.tools, hint: s.toolsHint, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", { className: selectClass, value: form.toolsMode, onChange: (e) => patch({ toolsMode: e.target.value }), children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "read-only", children: s.toolsReadOnly }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "all", children: s.toolsAll }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "inherit", children: s.toolsInherit }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "custom", children: s.toolsCustom })
        ] }) }),
        form.toolsMode === "custom" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Field, { label: s.customTools, hint: s.customToolsHint, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Input, { value: form.customTools, onChange: (e) => patch({ customTools: e.target.value }), className: "font-mono", placeholder: "Read, Search, Bash" }) }) : null
      ] }),
      onSave: (form, callbacks) => {
        const tools = form.toolsMode === "custom" ? form.customTools.split(",").map((v) => v.trim()).filter(Boolean) : form.toolsMode;
        save.mutate(
          { name: form.editing ?? form.name.trim(), def: { description: form.description.trim(), tools, body: form.body } },
          callbacks
        );
      },
      saving: save.isPending,
      onDelete: (name, callbacks) => remove.mutate(name, callbacks)
    }
  ) }) });
}

// plugins/subagent/web-src/index.tsx
registerSubagentUi({
  requiresApiVersion: 1,
  settings: {
    "subagents": SubagentsSettings
  }
});
