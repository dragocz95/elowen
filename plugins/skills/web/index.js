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

// plugins/skills/web-src/runtime.ts
function runtime() {
  const rt = window.ElowenUiRuntime;
  if (!rt) throw new Error("ElowenUiRuntime is not installed");
  return rt;
}
function registerSkillsUi(registration) {
  window.__elowenRegisterPluginUi?.("skills", registration);
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

// web/node_modules/lucide-react/dist/esm/icons/graduation-cap.js
var GraduationCap = createLucideIcon("GraduationCap", [
  [
    "path",
    {
      d: "M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z",
      key: "j76jl0"
    }
  ],
  ["path", { d: "M22 10v6", key: "1lu8f3" }],
  ["path", { d: "M6 12.5V16a6 3 0 0 0 12 0v-3.5", key: "1r8lef" }]
]);

// plugins/skills/web-src/SkillsSettings.tsx
var import_jsx_runtime = __toESM(require_jsx_runtime(), 1);
var EMPTY_FORM = { editing: null, name: "", description: "", body: "", disableModelInvocation: false };
function SkillsSettings() {
  const { components: C, hooks, utils } = runtime();
  const s = hooks.usePluginStrings("skills");
  const { toast } = hooks.useToast();
  const query = hooks.usePluginSkills();
  const create = hooks.useCreatePluginSkill();
  const update = hooks.useUpdatePluginSkill();
  const remove = hooks.useDeletePluginSkill();
  const toggleInvocation = (skill, next) => {
    update.mutate(
      { name: skill.name, patch: { disableModelInvocation: next } },
      { onError: (e) => toast(utils.apiErrorMessage(e), "error") }
    );
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.SettingsGroup, { className: "plugin-card", icon: GraduationCap, title: s.title, description: s.sectionHint, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "settings-group__panel", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    C.MarkdownAssetEditor,
    {
      query,
      labels: {
        empty: s.empty,
        badgeUser: s.badgeUser,
        badgeBuiltin: s.badgeBundled,
        add: s.add,
        edit: s.edit,
        remove: s.remove,
        save: s.save,
        cancel: s.cancel,
        name: s.name,
        nameHint: s.helpName,
        namePlaceholder: "deploy-checklist",
        description: s.description,
        descriptionHint: s.helpDescription,
        body: s.content,
        bodyHint: s.helpContent,
        created: s.created,
        updated: s.updated,
        deleted: s.deleted,
        deleteTitle: s.deleteTitle,
        deleteDesc: s.deleteDesc
      },
      emptyForm: EMPTY_FORM,
      formFromItem: (skill) => ({
        editing: skill.name,
        name: skill.name,
        description: skill.description,
        body: skill.content ?? "",
        disableModelInvocation: skill.disableModelInvocation
      }),
      renderBadges: (skill) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        skill.version != null ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(C.Badge, { tone: "default", children: [
          "v",
          skill.version
        ] }) : null,
        skill.disableModelInvocation ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Badge, { tone: "default", children: s.manualOnlyBadge }) : null
      ] }),
      renderRowControl: (skill) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        C.Toggle,
        {
          checked: skill.disableModelInvocation,
          onChange: (next) => toggleInvocation(skill, next),
          label: s.disableModelInvocation,
          disabled: update.isPending && update.variables?.name === skill.name
        }
      ),
      renderFieldsAfterBody: (form, patch) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "flex items-center gap-2", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          C.Toggle,
          {
            checked: form.disableModelInvocation,
            onChange: (next) => patch({ disableModelInvocation: next }),
            label: s.disableModelInvocation
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "flex flex-col", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "text-sm text-text", children: s.disableModelInvocation }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "text-xs text-text-muted", children: s.disableModelInvocationHint })
        ] })
      ] }),
      onSave: (form, callbacks) => {
        if (form.editing !== null) {
          update.mutate(
            { name: form.editing, patch: { description: form.description.trim(), content: form.body, disableModelInvocation: form.disableModelInvocation } },
            callbacks
          );
        } else {
          create.mutate(
            { name: form.name.trim(), description: form.description.trim(), content: form.body, disableModelInvocation: form.disableModelInvocation },
            callbacks
          );
        }
      },
      saving: create.isPending || update.isPending,
      onDelete: (name, callbacks) => remove.mutate(name, callbacks)
    }
  ) }) });
}

// plugins/skills/web-src/index.tsx
registerSkillsUi({
  requiresApiVersion: 1,
  settings: {
    "skills": SkillsSettings
  }
});
