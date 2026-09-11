// Memory Center 实时同步引擎（R8 phase 5）——独立浏览器脚本。
//
// 架构：page.ts 在页面注入静态策略数据（window.__mc.sseUrl = SSE 订阅地址；
// window.__mc.live = live.ts 单一来源序列化的视图订阅映射 / 定时常数 /
// detailViews），并先于 app.js 加载本脚本；SPA（app.js）经 window.MCLive.create
// 把动态领域钩子接入引擎：
//   - state()      当前导航状态 { view, id }（惰性读取，无需每次导航同步）
//   - refresh()    重取当前视图（事件命中后调用）
//   - text(key)    i18n 文案（角标/提示，键与 app.js 词表对齐）
//   - eventTypes   SSE 命名事件帧词表（来自 app.js 的 E 审计 token 表）
// 引擎职责：SSE 连接、命名事件帧订阅、命中当前视图订阅的 debounce 刷新、
// 页面隐藏补刷、本地写回声静音、连接状态角标。刷新/抑制语义的唯一来源
// 是 live.ts（服务端注入 window.__mc.live）。
(function () {
  "use strict";

  // 状态角标样式（从 app.js 迁移：随引擎加载，无需服务端模板改动）。
  var LIVE_STYLE =
    ".live{align-items:center;gap:5px;margin:0 2px 0 6px;padding:2px 8px;font-size:11px;line-height:1.5;" +
    "border-radius:999px;border:1px solid #2f4066;color:#9fb1d1;opacity:.85;white-space:nowrap}" +
    ".live i{width:7px;height:7px;border-radius:50%;background:#5c6b8a;display:inline-block}" +
    ".live b{font-weight:600}" +
    ".live.on{border-color:#1f5c3c;color:#8fd9ac;opacity:1}.live.on i{background:#3fbf6f}" +
    ".live.off{border-color:#6b3240;color:#ffb9c1;opacity:1}.live.off i{background:#e0556e}";
  // 角标文案键与 app.js 的 i18n 词表对齐（自然语言由桥端 text() 解析）。
  var TIP_KEY = "live.tip", OK_KEY = "live.ok", CONNECTING_KEY = "live.connecting", OFF_KEY = "live.off";

  function styleOnce() {
    if (styleOnce.injected) return;
    styleOnce.injected = true;
    var el = document.createElement("style");
    el.textContent = LIVE_STYLE;
    (document.head || document.documentElement).appendChild(el);
  }

  // 单条订阅表达式是否命中事件类型：精确名、`前缀.*` 通配或 `*`。
  function prefixHit(type, subscription) {
    if (subscription === "*") return true;
    if (subscription.slice(-2) === ".*") return type.indexOf(subscription.slice(0, -1)) === 0;
    return type === subscription;
  }

  /**
   * 创建实时同步控制器。
   * @param bridge 动态领域钩子（见文件头）；可缺省（引擎仍可加载，仅不连线）。
   * @returns { start(): void, localWrite(): void, refreshPill(): void }
   */
  function create(bridge) {
    var host = bridge || {};
    var mc = window.__mc || {};
    var cfg = mc.live || {};
    var views = cfg.views || {};
    var sseUrl = mc.sseUrl || cfg.stream || "";
    var debounceMs = cfg.debounceMs || 0;
    var muteMs = cfg.muteMs || 0;
    // 详情视图集合：与 live.ts DETAIL_VIEWS 同源，page.ts 注入 __mc.live.detailViews。
    var detailViews = cfg.detailViews || [];
    var enabled = !!sseUrl && typeof window.EventSource === "function";

    var es = null, timer = null, scheduledView = null;
    var muteUntil = 0, hiddenDirty = false, everConnected = false, sawError = false;
    var pill = null, pillText = null, pillMode = null, started = false;

    function state() {
      var st = host.state ? host.state() : null;
      return (st && typeof st.view === "string") ? st : { view: "overview", id: null };
    }
    function text(key) { return host.text ? host.text(key) : key; }
    function refreshView() { if (typeof host.refresh === "function") host.refresh(); }

    function isMuted() { return Date.now() < muteUntil; }

    // 本地写操作完成后的回声静音入口（app.js 的 post() 成功回调中调用）。
    function localWrite() { if (enabled) muteUntil = Date.now() + (muteMs || 0); }

    // 命中当前视图的事件合并为一次刷新；页面隐藏时只记账，可见后补刷。
    function queueRefresh() {
      if (!enabled || isMuted()) return;
      if (document.hidden) { hiddenDirty = true; return; }
      scheduledView = state().view;
      if (timer === null) timer = window.setTimeout(fireRefresh, debounceMs);
    }

    function fireRefresh() {
      timer = null;
      if (!enabled || isMuted()) { scheduledView = null; return; }
      if (document.hidden) { hiddenDirty = true; return; }
      var view = scheduledView;
      scheduledView = null;
      if (view === null || view !== state().view) return; // 期间切走：丢弃过期刷新
      refreshView();
    }

    // 命名事件帧：负载为审计锚点 { type, memoryId? }；命中当前视图订阅才刷新，
    // 详情视图只跟随同实体事件（memoryId === 当前实体 id）。
    function onEvent(ev) {
      var data = null;
      try { data = JSON.parse(ev.data || "null"); } catch (e) { return; }
      if (!data || typeof data.type !== "string") return;
      var st = state();
      var subs = views[st.view];
      if (!subs || !subs.length) return;
      if (!subs.some(function (s) { return prefixHit(data.type, s); })) return;
      var memoryId = data.memoryId && typeof data.memoryId === "string" ? data.memoryId : null;
      if (detailViews.indexOf(st.view) !== -1 && (memoryId === null || memoryId !== st.id)) return;
      queueRefresh();
    }

    // 状态角标：connecting / ok / off。pillMode 记住最近状态，供语言切换重挂后恢复。
    function setStatus(mode) {
      pillMode = mode;
      if (!pill) return;
      var key = mode === "ok" ? OK_KEY : mode === "off" ? OFF_KEY : CONNECTING_KEY;
      pill.className = "live " + (mode === "ok" ? "on" : "off");
      pill.setAttribute("title", text(TIP_KEY) + " — " + text(key));
      pillText.nodeValue = text(key);
    }

    function ensurePill() {
      if (!enabled) return;
      var bar = document.querySelector(".langbar");
      if (!bar) return;
      if (pill && pill.parentNode === bar) return;
      if (pill && pill.parentNode) { pill.parentNode.removeChild(pill); pill = null; }
      pill = document.createElement("span");
      pill.className = "live off";
      pill.setAttribute("aria-live", "polite");
      var dot = document.createElement("i");
      pillText = document.createTextNode("");
      pill.appendChild(dot);
      pill.appendChild(pillText);
      bar.appendChild(pill);
      setStatus(pillMode || "connecting");
    }

    // app.js 重建 DOM（语言切换）后调用：把角标挂回新 .langbar 并按最近状态重绘。
    function refreshPill() { ensurePill(); }

    function start() {
      if (!enabled || started) return;
      started = true;
      styleOnce();
      ensurePill();
      es = new window.EventSource(sseUrl);
      es.addEventListener("open", function () {
        var needCatchUp = everConnected || sawError;
        everConnected = true;
        sawError = false;
        // 重连（或首次连接前曾失败）后补刷当前视图，覆盖断线期间漏掉的事件。
        if (needCatchUp) queueRefresh();
        setStatus("ok");
      });
      es.addEventListener("error", function () {
        sawError = true; // EventSource 按服务端 retry: 自动重连
        setStatus("off");
      });
      // 词表由 app.js 注入（审计 token 表即事件名全集）；只订阅 overview 命中的
      // 前缀帧，服务端按同一集合过滤推送（views.overview === 服务端默认类型）。
      var overview = views.overview || [];
      var types = host.eventTypes || [];
      for (var i = 0; i < types.length; i++) {
        var name = types[i];
        for (var j = 0; j < overview.length; j++) {
          if (prefixHit(name, overview[j])) {
            es.addEventListener(name, onEvent);
            break;
          }
        }
      }
    }

    function onVisibility() {
      if (!document.hidden && hiddenDirty) {
        hiddenDirty = false;
        queueRefresh();
      }
    }
    document.addEventListener("visibilitychange", onVisibility);

    return { start: start, localWrite: localWrite, refreshPill: refreshPill };
  }

  window.MCLive = { create: create };
})();
