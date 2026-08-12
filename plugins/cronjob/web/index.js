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

// plugins/cronjob/web-src/runtime.ts
function runtime() {
  const rt = window.ElowenUiRuntime;
  if (!rt) throw new Error("ElowenUiRuntime is not installed");
  return rt;
}
function registerCronUi(registration) {
  window.__elowenRegisterPluginUi?.("cronjob", registration);
}

// plugins/cronjob/web-src/JobsSettings.tsx
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

// web/node_modules/lucide-react/dist/esm/icons/calendar-clock.js
var CalendarClock = createLucideIcon("CalendarClock", [
  ["path", { d: "M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5", key: "1osxxc" }],
  ["path", { d: "M16 2v4", key: "4m81vk" }],
  ["path", { d: "M8 2v4", key: "1cmpym" }],
  ["path", { d: "M3 10h5", key: "r794hk" }],
  ["path", { d: "M17.5 17.5 16 16.3V14", key: "akvzfd" }],
  ["circle", { cx: "16", cy: "16", r: "6", key: "qoo3c4" }]
]);

// web/node_modules/lucide-react/dist/esm/icons/check.js
var Check = createLucideIcon("Check", [["path", { d: "M20 6 9 17l-5-5", key: "1gmf2c" }]]);

// web/node_modules/lucide-react/dist/esm/icons/chevron-down.js
var ChevronDown = createLucideIcon("ChevronDown", [
  ["path", { d: "m6 9 6 6 6-6", key: "qrunsl" }]
]);

// web/node_modules/lucide-react/dist/esm/icons/chevron-right.js
var ChevronRight = createLucideIcon("ChevronRight", [
  ["path", { d: "m9 18 6-6-6-6", key: "mthhwq" }]
]);

// web/node_modules/lucide-react/dist/esm/icons/clock.js
var Clock = createLucideIcon("Clock", [
  ["circle", { cx: "12", cy: "12", r: "10", key: "1mglay" }],
  ["polyline", { points: "12 6 12 12 16 14", key: "68esgv" }]
]);

// web/node_modules/lucide-react/dist/esm/icons/hash.js
var Hash = createLucideIcon("Hash", [
  ["line", { x1: "4", x2: "20", y1: "9", y2: "9", key: "4lhtct" }],
  ["line", { x1: "4", x2: "20", y1: "15", y2: "15", key: "vyu0kd" }],
  ["line", { x1: "10", x2: "8", y1: "3", y2: "21", key: "1ggp8o" }],
  ["line", { x1: "16", x2: "14", y1: "3", y2: "21", key: "weycgp" }]
]);

// web/node_modules/lucide-react/dist/esm/icons/message-square.js
var MessageSquare = createLucideIcon("MessageSquare", [
  ["path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z", key: "1lielz" }]
]);

// web/node_modules/lucide-react/dist/esm/icons/plus.js
var Plus = createLucideIcon("Plus", [
  ["path", { d: "M5 12h14", key: "1ays0h" }],
  ["path", { d: "M12 5v14", key: "s699le" }]
]);

// web/node_modules/lucide-react/dist/esm/icons/trash-2.js
var Trash2 = createLucideIcon("Trash2", [
  ["path", { d: "M3 6h18", key: "d0wm0j" }],
  ["path", { d: "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6", key: "4alrt4" }],
  ["path", { d: "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2", key: "v07s0e" }],
  ["line", { x1: "10", x2: "10", y1: "11", y2: "17", key: "1uufr5" }],
  ["line", { x1: "14", x2: "14", y1: "11", y2: "17", key: "xtxkd" }]
]);

// web/node_modules/lucide-react/dist/esm/icons/x.js
var X = createLucideIcon("X", [
  ["path", { d: "M18 6 6 18", key: "1bl5f8" }],
  ["path", { d: "m6 6 12 12", key: "d8bk6v" }]
]);

// plugins/cronjob/web-src/JobsSettings.tsx
var import_jsx_runtime = __toESM(require_jsx_runtime(), 1);
var textareaClass = "w-full rounded-md border border-border bg-bg px-3 py-2 font-mono text-sm text-text placeholder:text-text-muted focus:border-accent";
function ChannelField({ value, onChange, channels }) {
  const { components: C, hooks } = runtime();
  const { t } = hooks.useTranslation();
  const s = hooks.usePluginStrings("cronjob");
  const [open, setOpen] = (0, import_react3.useState)(false);
  const selected = channels.find((ch) => ch.id === value);
  const icon = (type) => type === "thread" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MessageSquare, { size: 12, "aria-hidden": true }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Hash, { size: 12, "aria-hidden": true });
  const toItem = (ch) => ({
    id: ch.id,
    label: ch.name,
    group: ch.type,
    groupLabel: ch.type === "thread" ? t.managePicker.groupThreads : t.managePicker.groupChannels,
    icon: icon(ch.type),
    badges: ch.parentName ? [{ text: `#${ch.parentName}` }] : void 0
  });
  const items = [
    // Pinned rows: the guild-default destination, plus a saved id the guild no longer lists.
    { id: "", label: s.pillDefault, group: "" },
    ...value && !selected ? [{ id: value, label: value, group: "", icon: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Hash, { size: 12, "aria-hidden": true }) }] : [],
    // Text channels first, then threads — one group each.
    ...channels.filter((ch) => ch.type !== "thread").map(toItem),
    ...channels.filter((ch) => ch.type === "thread").map(toItem)
  ];
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      C.SelectionSummary,
      {
        countText: value ? "" : "\u2014",
        samples: value ? [{ label: selected?.name ?? value, icon: icon(selected?.type ?? "channel") }] : [],
        moreCount: 0,
        onManage: () => setOpen(true),
        manageLabel: t.managePicker.manage
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      C.ManageSelectionModal,
      {
        title: s.channel,
        subtitle: s.helpChannel,
        open,
        onClose: () => setOpen(false),
        items,
        selected: /* @__PURE__ */ new Set([value]),
        single: true,
        onSave: (next) => onChange([...next][0] ?? "")
      }
    )
  ] });
}
function CronJobRow({ job, persisted, channels, models, onRemoved }) {
  const { components: C, hooks, utils } = runtime();
  const s = hooks.usePluginStrings("cronjob");
  const { toast } = hooks.useToast();
  const save = hooks.useSaveCronJob();
  const del = hooks.useDeleteCronJob();
  const [draft, setDraft] = (0, import_react3.useState)(job);
  const [open, setOpen] = (0, import_react3.useState)(!persisted);
  const [confirming, setConfirming] = (0, import_react3.useState)(false);
  const draftRef = (0, import_react3.useRef)(draft);
  draftRef.current = draft;
  const dirty = (0, import_react3.useRef)(false);
  const deleted = (0, import_react3.useRef)(false);
  const inFlight = (0, import_react3.useRef)(null);
  const everSaved = (0, import_react3.useRef)(persisted);
  const isSavable = (j) => j.name.trim() !== "" && j.prompt.trim() !== "" && (j.runAt ? true : utils.isValidSchedule(j.schedule));
  const autosave = hooks.useAutoSaveStatus([draft], async () => {
    if (deleted.current) return;
    const sent = draftRef.current;
    everSaved.current = true;
    const request = save.mutateAsync(sent);
    inFlight.current = request;
    try {
      await request;
      if (draftRef.current === sent) dirty.current = false;
    } catch (error) {
      toast(s.saveError, "error");
      throw error;
    } finally {
      if (inFlight.current === request) inFlight.current = null;
    }
  }, { savable: isSavable(draft), delay: 900 });
  const serverCopy = JSON.stringify(job);
  (0, import_react3.useEffect)(() => {
    if (dirty.current || deleted.current) return;
    setDraft(job);
  }, [serverCopy]);
  const patch = (p) => {
    dirty.current = true;
    setDraft((cur) => ({ ...cur, ...p }));
  };
  const remove = async () => {
    deleted.current = true;
    setConfirming(false);
    onRemoved(job.id);
    await inFlight.current?.catch(() => {
    });
    if (!everSaved.current) return;
    try {
      await del.mutateAsync(job.id);
    } catch {
      deleted.current = false;
      toast(s.deleteError, "error");
    }
  };
  const enabled = draft.enabled !== false;
  const validSchedule = draft.runAt ? true : utils.isValidSchedule(draft.schedule);
  const lastRunMs = utils.parseTs(job.lastRun);
  const dest = draft.notifyChannelId ? channels.find((ch) => ch.id === draft.notifyChannelId)?.name ?? draft.notifyChannelId : null;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "@container rounded-lg border border-border bg-elevated/40", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex items-center gap-2 p-3", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", { type: "button", onClick: () => setOpen((v) => !v), "aria-expanded": open, className: "flex min-w-0 flex-1 items-center gap-2 text-left", children: [
        open ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ChevronDown, { size: 15, className: "shrink-0 text-text-muted", "aria-hidden": true }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ChevronRight, { size: 15, className: "shrink-0 text-text-muted", "aria-hidden": true }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "span",
          {
            className: `h-2 w-2 shrink-0 rounded-full ${enabled ? "bg-success" : "bg-text-muted/50"}`,
            title: enabled ? s.enabled : s.paused,
            "aria-hidden": true
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "truncate text-sm font-medium text-text", children: draft.name || s.jobNew }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "ml-auto flex shrink-0 items-center gap-1.5", children: [
          lastRunMs != null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "hidden text-tiny text-text-muted @sm:inline", title: new Date(lastRunMs).toLocaleString(), children: s.lastRun.replace("{t}", utils.compactElapsed(Date.now() - lastRunMs)) }) : null,
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(C.Badge, { tone: validSchedule ? "default" : "danger", children: [
            draft.runAt ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(CalendarClock, { size: 10, className: "mr-1 inline-block align-[-1px]", "aria-hidden": true }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Clock, { size: 10, className: "mr-1 inline-block align-[-1px]", "aria-hidden": true }),
            draft.schedule
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "hidden @sm:inline-flex", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(C.Badge, { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Hash, { size: 10, className: "mr-1 inline-block align-[-1px]", "aria-hidden": true }),
            dest ?? s.channelDefault
          ] }) })
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.AutoSaveStatus, { status: autosave.status, onRetry: autosave.retry }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Button, { variant: "ghost", icon: Trash2, "aria-label": s.removeJob, onClick: () => setConfirming(true) })
    ] }),
    open ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex flex-col gap-3 border-t border-border p-3", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "grid grid-cols-1 gap-3 @sm:grid-cols-2", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Field, { label: s.name, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Input, { value: draft.name, onChange: (e) => patch({ name: e.target.value }), placeholder: "morning-digest" }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Field, { label: s.schedule, hint: s.helpSchedule, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "relative", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Input, { value: draft.schedule, onChange: (e) => patch({ schedule: e.target.value }), className: "pr-8 font-mono", placeholder: "daily 06:00" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "absolute right-2.5 top-1/2 -translate-y-1/2", title: validSchedule ? s.scheduleValid : s.scheduleInvalid, children: validSchedule ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Check, { size: 14, className: "text-success", "aria-label": s.scheduleValid }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(X, { size: 14, className: "text-danger", "aria-label": s.scheduleInvalid }) })
        ] }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Field, { label: s.hours, hint: s.helpHours, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Input, { value: draft.hours ?? "", onChange: (e) => patch({ hours: e.target.value || void 0 }), className: "font-mono", placeholder: "5-21" }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Field, { label: s.enabled, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "flex h-9 items-center gap-2 text-sm text-text-muted", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Toggle, { checked: enabled, onChange: (v) => patch({ enabled: v }), label: `${draft.name || s.jobNew}: ${s.enabled}` }),
          enabled ? s.enabled : s.paused
        ] }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Field, { label: s.header, hint: s.helpHeader, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "flex h-9 items-center text-sm text-text-muted", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Toggle, { checked: draft.plain !== true, onChange: (v) => patch({ plain: v ? void 0 : true }), label: `${draft.name || s.jobNew}: ${s.header}` }) }) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Field, { label: s.check, hint: s.helpCheck, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "textarea",
        {
          value: draft.check ?? "",
          onChange: (e) => patch({ check: e.target.value || void 0 }),
          rows: 2,
          className: textareaClass,
          placeholder: 'test -n "$(ls /new-bookings 2>/dev/null)" && cat /new-bookings/*'
        }
      ) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Field, { label: s.prompt, hint: s.helpPrompt, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("textarea", { value: draft.prompt, onChange: (e) => patch({ prompt: e.target.value }), rows: 5, className: textareaClass }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Field, { label: s.channel, hint: s.helpChannel, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        ChannelField,
        {
          value: draft.notifyChannelId ?? "",
          onChange: (v) => patch({ notifyChannelId: v || void 0 }),
          channels
        }
      ) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Field, { label: s.model, hint: s.helpModel, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        C.BrainModelField,
        {
          value: draft.model ? `${draft.model.provider}/${draft.model.model}` : "",
          onChange: (v) => {
            const slash = v.indexOf("/");
            patch({ model: slash > 0 ? { provider: v.slice(0, slash), model: v.slice(slash + 1) } : void 0 });
          },
          models,
          title: s.model,
          subtitle: s.helpModel,
          defaultLabel: s.modelDefault,
          keyOf: (m) => `${m.provider}/${m.model}`
        }
      ) }),
      job.lastResult ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.Field, { label: s.lastResult, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "whitespace-pre-wrap rounded-md border border-border bg-bg px-3 py-2 text-xs text-text-muted", children: job.lastResult }) }) : null
    ] }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      C.ConfirmDialog,
      {
        open: confirming,
        title: s.deleteTitle,
        description: s.deleteDesc.replace("{name}", draft.name || s.jobNew),
        confirmLabel: s.removeJob,
        onConfirm: remove,
        onClose: () => setConfirming(false)
      }
    )
  ] });
}
function JobsSettings() {
  const { components: C, hooks } = runtime();
  const s = hooks.usePluginStrings("cronjob");
  const { t } = hooks.useTranslation();
  const { data, isLoading, isError, refetch } = hooks.useCronJobs();
  const channels = hooks.useDiscordChannels();
  const models = hooks.useBrainModels();
  const [drafts, setDrafts] = (0, import_react3.useState)([]);
  (0, import_react3.useEffect)(() => {
    if (!data) return;
    const ids = new Set(data.map((j) => j.id));
    setDrafts((cur) => cur.some((j) => ids.has(j.id)) ? cur.filter((j) => !ids.has(j.id)) : cur);
  }, [data]);
  const body = () => {
    if (isError) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.ErrorState, { message: t.common.daemonUnreachable, onRetry: () => refetch() });
    if (isLoading || !data) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.LoadingState, {});
    const saved = new Set(data.map((j) => j.id));
    const rows = [...data, ...drafts.filter((j) => !saved.has(j.id))];
    const addJob = () => {
      const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      setDrafts((cur) => [...cur, { id, name: "", schedule: "every 1h", prompt: "", enabled: false, createdAt: (/* @__PURE__ */ new Date()).toISOString() }]);
    };
    const dropDraft = (id) => setDrafts((cur) => cur.filter((j) => j.id !== id));
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "flex flex-col gap-3", children: [
      rows.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "text-xs italic text-text-muted", children: s.empty }) : null,
      rows.map((job) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        CronJobRow,
        {
          job,
          persisted: saved.has(job.id),
          channels: channels.data ?? [],
          models: models.data ?? [],
          onRemoved: dropDraft
        },
        job.id
      )),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "flex items-center justify-between gap-3", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", { type: "button", className: "spatial-inline-action", onClick: addJob, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Plus, { size: 14, "aria-hidden": true }),
        s.addJob
      ] }) })
    ] });
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(C.SettingsGroup, { className: "plugin-card", icon: Clock, title: s.title, description: s.sectionHint, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "settings-group__panel", children: body() }) });
}

// plugins/cronjob/web-src/index.tsx
registerCronUi({
  requiresApiVersion: 1,
  settings: {
    "jobs": JobsSettings
  }
});
