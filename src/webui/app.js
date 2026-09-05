// Memory Center SPA（纯前端展示层）。
// 不直接访问数据：所有读取/操作都走 /dsh-memory/api/*（R7-1 registry）。
(function () {
  "use strict";

  var API = "/dsh-memory/api";
  var screens = window.__mc && window.__mc.screens ? window.__mc.screens : [];
  var state = { view: "overview", id: null };

  // ---- i18n：英文文案 ----
  var UI_EN = {
    "meta.title": "Amnesia · Memory Center",
    "wordmark.main": "Amnesia", "wordmark.sub": "Memory Center",
    "group.library": "Memory", "group.review": "Review", "group.operations": "Operations",
    "screen.overview.title": "Overview", "screen.overview.sub": "Memory health, review queue and recent activity",
    "screen.memories.title": "Memory Explorer", "screen.memories.sub": "Browse and govern memory items",
    "screen.memory-detail.title": "Memory Detail",
    "screen.experiences.title": "Experience Center", "screen.experiences.sub": "Long-term experiences distilled from sessions",
    "screen.experience-detail.title": "Experience Detail",
    "screen.conflicts.title": "Conflict Review", "screen.conflicts.sub": "Duplicate memories awaiting a decision",
    "screen.quarantine.title": "Quarantine Review", "screen.quarantine.sub": "Low-confidence / conflicting items kept out of context",
    "screen.system.title": "System Health", "screen.system.sub": "Runtime, driver and maintenance actions",
    "card.memories": "Memories", "card.active": "Active", "card.quarantinedPending": "Quarantined pending",
    "card.archived": "Archived", "card.experiences": "Experiences", "card.experiencesActive": "Active experiences",
    "card.conflictsOpen": "Conflicts open", "card.conflictsResolved": "Resolved", "card.conflictsDiscarded": "Discarded",
    "card.schemaVersion": "Schema version", "card.memoryItems": "Memory items", "card.auditEntries": "Audit entries",
    "card.eventsTotal": "Events", "card.cacheRows": "Cache rows", "card.cacheHits": "Cache hits",
    "col.time": "Time", "col.actor": "Actor", "col.action": "Action", "col.entity": "Entity", "col.id": "Id",
    "col.date": "Date", "col.reason": "Reason", "col.content": "Content", "col.decision": "Decision", "col.status": "Status",
    "col.project": "Project", "col.summary": "Summary", "col.type": "Type", "col.scope": "Scope",
    "col.importance": "Importance", "col.confidence": "Confidence", "col.state": "State", "col.actions": "Actions", "col.phase": "Phase",
    "col.note": "Note", "col.key": "Key", "col.value": "Value", "col.created": "Created",
    "col.conflicting": "Conflicting memories", "col.experience": "Experience",
    "act.open": "Open", "act.archive": "Archive", "act.restore": "Restore", "act.back": "Back",
    "act.advance": "Advance", "act.advancePhase": "Advance phase", "act.resolve": "Resolve", "act.discard": "Discard",
    "act.promote": "Promote", "act.reject": "Reject", "act.validation": "Run validation",
    "act.consolidation": "Run consolidation", "act.cacheClear": "Clear retrieval cache",
    "act.projection": "Rebuild markdown projection",
    "empty.memories": "No memories yet. They appear here after capture events.",
    "empty.experiences": "No experiences yet.",
    "empty.conflicts": "No open conflicts.",
    "empty.quarantine": "Quarantine is empty.",
    "empty.bars": "No data.", "bar.none": "(none)",
    "panel.byScope": "By scope", "panel.byType": "By type",
    "panel.activity": "Recent activity", "panel.content": "Content", "panel.markdown": "Markdown projection",
    "panel.audit": "Audit trail", "panel.phases": "Phase history", "panel.driver": "Driver & runtime",
    "panel.maintenance": "Maintenance",
    "kv.driver": "Driver", "kv.driverNote": "Driver note", "kv.mode": "Mode", "kv.vectorSearch": "Vector search",
    "kv.vectorInfo": "Vector info", "kv.queuePending": "Queue pending", "kv.cacheHitRate": "Cache hit rate",
    "kv.lastValidation": "Last validation", "kv.cacheMode": "Cache mode", "kv.cacheStore": "Cache store",
    "kv.enabled": "enabled", "kv.disabled": "disabled",
    "prompt.advance": "Target phase (leave blank for auto):",
    "prompt.resolve": "Resolve as (merge | link | supersede | keep_separate):",
    "prompt.merged": "Merged content:", "prompt.rejectNote": "Rejection note (optional):",
    "error.unknownResolution": "Unknown resolution: {v} (merge | link | supersede | keep_separate)",
    "error.mergeRequired": "Merged content is required for merge",
    "confirm.resolve": "Resolve conflict {id} as {how}? Merge or supersede will rewrite/archive the losing memory row.",
    "confirm.discard": "Discard this conflict pair (keep both memories)?",
    "confirm.promote": "Promote this quarantined memory back into context?",
    "confirm.reject": "Reject this quarantined memory? It will be marked rejected/historical and excluded from context (audit stays).",
    "flash.archived": "Memory archived", "flash.restored": "Memory restored", "flash.advanced": "Experience advanced",
    "flash.resolved": "Conflict resolved", "flash.discarded": "Conflict discarded", "flash.promoted": "Promoted",
    "flash.rejected": "Rejected", "flash.opOk": "Operation ok",
  };

  // ---- i18n：中文文案 ----
  var UI_ZH = {
    "meta.title": "倒霉蛋 · 记忆中心",
    "wordmark.main": "倒霉蛋", "wordmark.sub": "记忆中心",
    "group.library": "记忆库", "group.review": "评审", "group.operations": "运维",
    "screen.overview.title": "总览", "screen.overview.sub": "记忆健康度、待评审队列与最近动态",
    "screen.memories.title": "记忆浏览", "screen.memories.sub": "浏览并管理记忆条目",
    "screen.memory-detail.title": "记忆详情",
    "screen.experiences.title": "经验中心", "screen.experiences.sub": "从会话中沉淀的长期经验",
    "screen.experience-detail.title": "经验详情",
    "screen.conflicts.title": "冲突评审", "screen.conflicts.sub": "等待决策的疑似重复记忆",
    "screen.quarantine.title": "隔离区评审", "screen.quarantine.sub": "低置信度或冲突项，暂不进入上下文",
    "screen.system.title": "系统状态", "screen.system.sub": "运行环境、驱动与维护操作",
    "card.memories": "记忆总数", "card.active": "激活中", "card.quarantinedPending": "待评审隔离",
    "card.archived": "已归档", "card.experiences": "经验", "card.experiencesActive": "激活中的经验",
    "card.conflictsOpen": "待处理冲突", "card.conflictsResolved": "已解决冲突", "card.conflictsDiscarded": "已忽略冲突",
    "card.schemaVersion": "Schema 版本", "card.memoryItems": "记忆条目", "card.auditEntries": "审计记录",
    "card.eventsTotal": "事件总数", "card.cacheRows": "缓存行数", "card.cacheHits": "缓存命中",
    "col.time": "时间", "col.actor": "来源", "col.action": "动作", "col.entity": "实体", "col.id": "ID",
    "col.date": "日期", "col.reason": "原因", "col.content": "内容", "col.decision": "决策", "col.status": "状态",
    "col.project": "项目", "col.summary": "摘要", "col.type": "类型", "col.scope": "作用域",
    "col.importance": "重要度", "col.confidence": "置信度", "col.state": "状态", "col.actions": "操作", "col.phase": "阶段",
    "col.note": "备注", "col.key": "键", "col.value": "值", "col.created": "创建时间",
    "col.conflicting": "冲突双方记忆", "col.experience": "经验",
    "act.open": "打开", "act.archive": "归档", "act.restore": "恢复", "act.back": "返回",
    "act.advance": "推进", "act.advancePhase": "推进阶段", "act.resolve": "解决", "act.discard": "忽略",
    "act.promote": "恢复", "act.reject": "拒绝", "act.validation": "运行校验",
    "act.consolidation": "运行整合", "act.cacheClear": "清空检索缓存",
    "act.projection": "重建 Markdown 投影",
    "empty.memories": "还没有记忆。捕获事件发生后它们会出现在这里。",
    "empty.experiences": "还没有经验。",
    "empty.conflicts": "没有待处理的冲突。",
    "empty.quarantine": "隔离区为空。",
    "empty.bars": "暂无数据。", "bar.none": "（无）",
    "panel.byScope": "按作用域", "panel.byType": "按类型",
    "panel.activity": "最近动态", "panel.content": "内容", "panel.markdown": "Markdown 投影",
    "panel.audit": "审计记录", "panel.phases": "阶段历史", "panel.driver": "驱动与运行时",
    "panel.maintenance": "维护",
    "kv.driver": "驱动", "kv.driverNote": "驱动说明", "kv.mode": "模式", "kv.vectorSearch": "向量检索",
    "kv.vectorInfo": "向量信息", "kv.queuePending": "队列待处理", "kv.cacheHitRate": "缓存命中率",
    "kv.lastValidation": "最近校验", "kv.cacheMode": "缓存模式", "kv.cacheStore": "缓存存储",
    "kv.enabled": "已启用", "kv.disabled": "已禁用",
    "prompt.advance": "目标阶段（留空自动选择）：",
    "prompt.resolve": "解决方式（merge | link | supersede | keep_separate）：",
    "prompt.merged": "合并后的内容：", "prompt.rejectNote": "拒绝备注（可选）：",
    "error.unknownResolution": "未知的解决方式：{v}（merge | link | supersede | keep_separate）",
    "error.mergeRequired": "merge 方式必须提供合并内容",
    "confirm.resolve": "以 {how} 方式解决冲突 {id}？merge 或 supersede 会改写/归档落败方记忆行。",
    "confirm.discard": "忽略这对冲突（保留两条记忆）？",
    "confirm.promote": "把这条隔离记忆恢复到上下文中？",
    "confirm.reject": "拒绝这条隔离记忆？它会被标记为 rejected/historical 且不再进入上下文（审计保留）。",
    "flash.archived": "记忆已归档", "flash.restored": "记忆已恢复", "flash.advanced": "经验已推进",
    "flash.resolved": "冲突已解决", "flash.discarded": "冲突已忽略", "flash.promoted": "已恢复",
    "flash.rejected": "已拒绝", "flash.opOk": "操作完成",
  };

  var UI = { en: UI_EN, zh: UI_ZH };

  // ---- i18n：数据状态词/审计 token 映射（未收录的值原样显示） ----
  var E_EN = {
    type: { personal: "Personal", project_knowledge: "Project knowledge", experience: "Experience", negative: "Negative", generalized: "Generalized" },
    scope: { session: "Session", project: "Project", global: "Global", generalized: "Generalized" },
    importance: { critical: "Critical", high: "High", normal: "Normal", low: "Low", disposable: "Disposable" },
    temporal: { current: "Current", historical: "Historical", planned: "Planned", expired: "Expired", uncertain: "Uncertain", superseded: "Superseded" },
    source: { explicit: "Explicit", "user-edited": "User edited", derived: "Derived", inferred: "Inferred" },
    phase: { candidate: "Candidate", investigating: "Investigating", "solution-found": "Solution found", verified: "Verified", validated: "Validated" },
    status: { open: "Open", resolved: "Resolved", discarded: "Discarded" },
    actor: { user: "User", system: "System" },
    entity: { memory_item: "Memory", memory: "Memory", experience: "Experience", conflict: "Conflict", system: "System" },
    action: {
      "memory.create": "Create memory", "memory.update": "Update memory", "memory.archive": "Archive memory",
      "memory.restore": "Restore memory", "memory.quarantine": "Quarantine memory", "memory.promote": "Promote memory",
      "memory.reject": "Reject memory", "memory.delete": "Delete memory",
      "conflict.open": "Open conflict", "conflict.resolve": "Resolve conflict", "conflict.discard": "Discard conflict",
      "experience.advance": "Advance experience", "experience.validate": "Validate experience",
      "generalize.candidate": "Generalize candidate", "generalize.promote": "Promote generalization",
      "consolidation.merge": "Consolidate memories",
    },
  };
  var E_ZH = {
    type: { personal: "个人资料", project_knowledge: "项目知识", experience: "经验", negative: "负面反馈", generalized: "泛化记忆" },
    scope: { session: "会话", project: "项目", global: "全局", generalized: "通用" },
    importance: { critical: "关键", high: "重要", normal: "普通", low: "较低", disposable: "可舍弃" },
    temporal: { current: "当前", historical: "历史", planned: "计划", expired: "已过期", uncertain: "不确定", superseded: "已取代" },
    source: { explicit: "用户明确", "user-edited": "用户编辑", derived: "系统派生", inferred: "系统推断" },
    phase: { candidate: "候选", investigating: "调查中", "solution-found": "已找到方案", verified: "已验证", validated: "已确认有效" },
    status: { open: "待处理", resolved: "已解决", discarded: "已忽略" },
    actor: { user: "用户", system: "系统" },
    entity: { memory_item: "记忆", memory: "记忆", experience: "经验", conflict: "冲突", system: "系统" },
    action: {
      "memory.create": "创建记忆", "memory.update": "更新记忆", "memory.archive": "归档记忆",
      "memory.restore": "恢复记忆", "memory.quarantine": "隔离记忆", "memory.promote": "恢复记忆入上下文",
      "memory.reject": "拒绝记忆", "memory.delete": "删除记忆",
      "conflict.open": "打开冲突", "conflict.resolve": "解决冲突", "conflict.discard": "忽略冲突",
      "experience.advance": "推进经验", "experience.validate": "验证经验",
      "generalize.candidate": "泛化候选", "generalize.promote": "提升泛化",
      "consolidation.merge": "整合记忆",
    },
  };
  var E = { en: E_EN, zh: E_ZH };

  var LANG_KEY = "dsh-memory.lang";

  function storeLang(v) {
    try { window.localStorage.setItem(LANG_KEY, v); } catch (err) { /* 隐私模式等场景忽略 */ }
  }
  function readLang() {
    try {
      var s = window.localStorage.getItem(LANG_KEY);
      if (s === "zh" || s === "en") return s;
    } catch (err) { /* ignore */ }
    return null;
  }
  function browserLang() {
    var nav = String(window.navigator && navigator.language || "").toLowerCase();
    return nav.indexOf("zh") === 0 ? "zh" : "en";
  }
  function parseQueryLocale() {
    try {
      var p = new URLSearchParams(window.location.search);
      var q = p.get("locale");
      if (!q) return null;
      return q.toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
    } catch (err) { return null; }
  }
  // 语言来源优先级：URL ?locale=（嵌入视图/新标签由宿主带语言）> 本地记忆（手动选择）> 浏览器语言 > en。
  function detectLang() {
    return parseQueryLocale() || readLang() || browserLang();
  }
  var cur = detectLang();
  var ui = function (key) {
    var dict = UI[cur] || UI.en;
    return Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
  };
  var et = function (cat, val) {
    if (val === null || val === undefined || val === "") return "";
    var maps = (E[cur] || E.en)[cat];
    return maps && Object.prototype.hasOwnProperty.call(maps, String(val))
      ? maps[String(val)] : String(val);
  };
  function fmt(text, vars) {
    return String(text).replace(/\{(\w+)\}/g, function (m, name) {
      return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : m;
    });
  }
  function applyLang(lang) {
    if (lang === cur) return;
    cur = lang === "zh" ? "zh" : "en";
    document.documentElement.lang = cur === "zh" ? "zh-CN" : "en";
    document.title = ui("meta.title");
    var flashEl = document.getElementById("flash");
    if (flashEl) { flashEl.setAttribute("hidden", ""); flashEl.textContent = ""; }
    shell();
    refresh();
  }


  function esc(v) {
    return String(v === null || v === undefined ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function pick(row, keys) {
    if (!row || typeof row !== "object") return "";
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = row[k];
      if (v === undefined && row.row && typeof row.row === "object") v = row.row[k];
      if (v !== undefined) return v;
    }
    return "";
  }
  function str(v) { return String(v === null || v === undefined ? "" : v); }
  function arrOf(data, keys) {
    for (var i = 0; i < keys.length; i++) {
      var a = data ? data[keys[i]] : null;
      if (Array.isArray(a)) return a;
    }
    return [];
  }
  function badge(text) { return '<span class="bd">' + esc(text) + "</span>"; }
  function act(text, data, cls) {
    var attrs = "";
    for (var k in data) {
      if (Object.prototype.hasOwnProperty.call(data, k)) attrs += " data-" + k + '="' + esc(data[k]) + '"';
    }
    return "<button" + (cls ? ' class="' + cls + '"' : "") + attrs + ">" + esc(text) + "</button>";
  }
  function tcell(v) { return "<td>" + esc(v) + "</td>"; }
  function cols(names) { return "<tr>" + names.map(function (n) { return "<th>" + n + "</th>"; }).join("") + "</tr>"; }

  function request(path, opts) {
    return fetch(API + path, opts).then(function (res) {
      return res.json().then(function (p) {
        if (!res.ok || !p || p.ok === false) {
          throw new Error(p && p.error ? p.error : "HTTP " + res.status);
        }
        return p.data;
      });
    });
  }
  function get(path) { return request(path); }
  function post(path, body) { return request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }); }

  var root = document.getElementById("mc-root");
  function flash(msg, isErr) {
    var box = document.getElementById("flash");
    if (!box) return;
    if (!msg) {
      box.setAttribute("hidden", "");
      box.textContent = "";
      return;
    }
    box.removeAttribute("hidden");
    box.className = isErr ? "err" : "msg";
    box.textContent = msg;
  }
  function setTitle(title, sub) {
    document.getElementById("pageTitle").textContent = title;
    document.getElementById("pageSub").textContent = sub || "";
  }
  function body(html) { document.getElementById("content").innerHTML = html; }
  function fail(e) {
    body('<div class="err">' + esc(str(e && e.message)) + "</div>");
  }

  function navActiveId() {
    var map = { overview: "overview", memories: "memories", "memory-detail": "memories",
      experiences: "experiences", "experience-detail": "experiences", conflicts: "conflicts",
      quarantine: "quarantine", system: "system" };
    return map[state.view] || "overview";
  }
  function langButton(tag, actName, on) {
    return '<button class="langbtn' + (on ? " on" : "") + '" data-act="' + actName + '">' + tag + "</button>";
  }
  function shell() {
    var groups = {};
    screens.forEach(function (s) { (groups[s.group] = groups[s.group] || []).push(s); });
    var order = ["library", "review", "operations"];
    var activeId = navActiveId();
    var nav = order.map(function (g) {
      if (!groups[g]) return "";
      return '<div class="ng">' + ui("group." + g) + "</div>" +
        groups[g].map(function (s) {
          var title = ui("screen." + s.id + ".title");
          var on = s.id === activeId ? " on" : "";
          return '<button class="nav' + on + '" data-view="' + esc(s.id) + '">' + esc(title) + "</button>";
        }).join("");
    }).join("");
    root.innerHTML =
      '<aside><h1>' + ui("wordmark.main") + '<span>' + ui("wordmark.sub") + '</span></h1>' + nav + "</aside>" +
      "<main>" +
      '<div class="langbar">' +
      langButton("中文", "lang-zh", cur === "zh") +
      langButton("EN", "lang-en", cur === "en") +
      "</div>" +
      '<div id="flash" hidden></div>' +
      '<h2 id="pageTitle">' + ui("screen.overview.title") + "</h2>" +
      '<p id="pageSub" class="sub"></p>' +
      '<div id="content"></div>' +
      "</main>";
  }

  function cards(list) {
    return '<div class="cards">' + list.map(function (c) {
      return '<div class="card"><b>' + esc(c[1]) + "</b><span>" + esc(c[0]) + "</span></div>";
    }).join("") + "</div>";
  }
  function bars(dims, cat) {
    if (!dims || !dims.length) return '<p class="muted">' + ui("empty.bars") + "</p>";
    var total = dims.reduce(function (a, d) { return a + (d.count || 0); }, 0) || 1;
    return '<div class="bars">' + dims.map(function (d) {
      var pct = Math.round(((d.count || 0) / total) * 100);
      var label = (d.value === null || d.value === undefined || d.value === "")
        ? ui("bar.none") : et(cat || "", String(d.value));
      return '<div class="bar"><div class="cap"><span>' + esc(label) +
        '</span><span>' + (d.count || 0) + "</span></div>" +
        '<div class="track"><i style="width:' + pct + '%"></i></div></div>';
    }).join("") + "</div>";
  }

  function renderOverview() {
    setTitle(ui("screen.overview.title"), ui("screen.overview.sub"));
    get("/overview").then(function (d) {
      var m = d.memory || {}, x = d.experience || {}, r = d.review || {}, cf = r.conflicts || {};
      var html = cards([
        [ui("card.memories"), m.total], [ui("card.active"), m.active],
        [ui("card.quarantinedPending"), m.quarantinedPending],
        [ui("card.archived"), m.archived], [ui("card.experiences"), x.active],
        [ui("card.conflictsOpen"), cf.open], [ui("card.conflictsResolved"), cf.resolved],
        [ui("card.conflictsDiscarded"), cf.discarded]
      ]);
      html += '<div class="panel"><h3>' + ui("panel.byScope") + "</h3>" + bars(m.byScope, "scope") + "</div>";
      html += '<div class="panel"><h3>' + ui("panel.byType") + "</h3>" + bars(m.byType, "type") + "</div>";
      var rows = arrOf(d, ["activity"]).slice(0, 15).map(function (a) {
        return "<tr>" + tcell(pick(a, ["ts"])) + tcell(et("actor", pick(a, ["actor"]))) +
          tcell(et("action", pick(a, ["action"]))) + tcell(et("entity", pick(a, ["entityType"]))) +
          tcell(pick(a, ["entityId"])) + "</tr>";
      });
      html += '<div class="panel"><h3>' + ui("panel.activity") + "</h3><table>" +
        cols([ui("col.time"), ui("col.actor"), ui("col.action"), ui("col.entity"), ui("col.id")]) +
        rows.join("") + "</table></div>";
      body(html);
    }).catch(fail);
  }

  function memOpenRow() {
    return { action: "open", base: "/memories" };
  }
  function memTable(items, withActions) {
    var rows = items.map(function (it) {
      var id = str(pick(it, ["id"]));
      var actions = "";
      if (withActions) {
        actions = act(ui("act.open"), { act: "open", base: "/memories", id: id }, "primary");
        actions += act(ui("act.archive"), { act: "archive", base: "/memories", id: id });
        actions += act(ui("act.restore"), { act: "restore", base: "/memories", id: id });
      }
      return "<tr>" + tcell(et("type", pick(it, ["type"]))) + tcell(et("scope", pick(it, ["scope"]))) +
        tcell(pick(it, ["projectId", "project"])) +
        '<td class="wide">' + esc(pick(it, ["content", "summary"])) + "</td>" +
        tcell(et("importance", pick(it, ["importance"]))) +
        tcell(et("temporal", pick(it, ["temporalState"]))) +
        (withActions ? "<td>" + actions + "</td>" : "") + "</tr>";
    });
    var names = [ui("col.type"), ui("col.scope"), ui("col.project"), ui("col.content"),
      ui("col.importance"), ui("col.state")];
    if (withActions) names.push(ui("col.actions"));
    return '<table>' + cols(names) + rows.join("") + "</table>";
  }

  function renderMemories() {
    setTitle(ui("screen.memories.title"), ui("screen.memories.sub"));
    get("/memories?limit=200").then(function (d) {
      var items = arrOf(d, ["items", "rows"]);
      body(items.length
        ? '<div class="panel">' + memTable(items, true) + "</div>"
        : '<p class="muted">' + esc(ui("empty.memories")) + "</p>");
    }).catch(fail);
  }

  function renderDetail() {
    if (!state.id) return renderMemories();
    setTitle(ui("screen.memory-detail.title"), state.id);
    get("/memories/" + encodeURIComponent(state.id)).then(function (d) {
      var m = d.memory || d || {};
      var html = '<div class="panel"><h3>' + ui("panel.content") + "</h3><p>" +
        esc(pick(m, ["content"])) + "</p>" +
        '<p class="muted">' + ui("col.type") + ": " + et("type", pick(m, ["type"])) +
        " · " + ui("col.scope") + ": " + et("scope", pick(m, ["scope"])) +
        " · " + ui("col.project") + ": " + esc(pick(m, ["projectId", "project"])) +
        " · " + ui("col.confidence") + ": " + esc(pick(m, ["confidence"])) + "</p>" +
        act(ui("act.back"), { act: "back", view: "memories" }) +
        act(ui("act.archive"), { act: "archive", base: "/memories", id: state.id }) +
        act(ui("act.restore"), { act: "restore", base: "/memories", id: state.id }) + "</div>";
      if (typeof d.markdown === "string" && d.markdown) {
        html += '<div class="panel"><h3>' + ui("panel.markdown") + "</h3><pre>" +
          esc(d.markdown) + "</pre></div>";
      }
      var audit = arrOf(d, ["history", "audit", "events"]).slice(0, 20);
      if (audit.length) {
        html += '<div class="panel"><h3>' + ui("panel.audit") + "</h3><table>" +
          cols([ui("col.time"), ui("col.actor"), ui("col.action"), ui("col.id")]) +
          audit.map(function (a) {
            return "<tr>" + tcell(pick(a, ["ts"])) + tcell(et("actor", pick(a, ["actor"]))) +
              tcell(et("action", pick(a, ["action"]))) + tcell(pick(a, ["entityId", "id"])) + "</tr>";
          }).join("") + "</table></div>";
      }
      body(html);
    }).catch(fail);
  }

  function renderExperiences() {
    setTitle(ui("screen.experiences.title"), ui("screen.experiences.sub"));
    get("/experiences?limit=100").then(function (d) {
      var items = arrOf(d, ["experiences", "items"]);
      var rows = items.map(function (x) {
        x = (x && x.memory) || x || {};
        var id = str(pick(x, ["id"]));
        return "<tr>" + tcell(et("type", pick(x, ["type"]))) +
          tcell(et("phase", pick(x, ["experiencePhase", "phase"]))) +
          tcell(pick(x, ["projectId", "project"])) +
          '<td class="wide">' + esc(pick(x, ["content", "summary"])) + "</td>" +
          "<td>" + act(ui("act.open"), { act: "exp-open", id: id }, "primary") +
          act(ui("act.advance"), { act: "exp-advance", id: id }) + "</td></tr>";
      });
      body(items.length
        ? '<div class="panel"><table>' + cols([ui("col.experience"), ui("col.phase"),
          ui("col.project"), ui("col.summary"), ui("col.actions")]) +
          rows.join("") + "</table></div>"
        : '<p class="muted">' + esc(ui("empty.experiences")) + "</p>");
    }).catch(fail);
  }

  function renderExperienceDetail() {
    setTitle(ui("screen.experience-detail.title"), state.id);
    get("/experiences/" + encodeURIComponent(state.id)).then(function (d) {
      var x = (d && (d.memory || d.experience)) || d || {};
      var events = arrOf(d, ["events", "phases"]);
      var html = '<div class="panel"><h3>' + esc(et("type", pick(x, ["type"]))) + "</h3>" +
        '<p>' + esc(pick(x, ["content"])) + "</p>" +
        '<p class="muted">' + ui("col.phase") + ": " + et("phase", pick(x, ["experiencePhase", "phase"])) +
        " · " + ui("col.project") + ": " + esc(pick(x, ["projectId", "project"])) + "</p>" +
        act(ui("act.back"), { act: "back", view: "experiences" }) +
        act(ui("act.advancePhase"), { act: "exp-advance", id: state.id }, "primary") + "</div>";
      if (events.length) {
        html += '<div class="panel"><h3>' + ui("panel.phases") + "</h3><table>" +
          cols([ui("col.phase"), ui("col.date"), ui("col.note")]) +
          events.map(function (e) {
            return "<tr>" + tcell(et("phase", pick(e, ["phase"]))) +
              tcell(pick(e, ["createdAt", "ts", "date"])) +
              tcell(pick(e, ["note"])) + "</tr>";
          }).join("") + "</table></div>";
      }
      body(html);
    }).catch(fail);
  }

  function sideContent(c, which, legacy) {
    var nested = c && c[which];
    if (nested && typeof nested.content === "string") return nested.content;
    return pick(c, legacy);
  }

  function renderConflicts() {
    setTitle(ui("screen.conflicts.title"), ui("screen.conflicts.sub"));
    get("/conflicts?limit=100").then(function (d) {
      var items = arrOf(d, ["conflicts", "items"]);
      var rows = items.map(function (c) {
        var id = str(pick(c, ["id"]));
        return "<tr>" + tcell(pick(c, ["createdAt", "ts"])) +
          tcell(et("status", pick(c, ["status"]))) +
          '<td class="wide">A · ' + esc(sideContent(c, "memoryA", ["aContent", "left"])) +
          "<br/>B · " + esc(sideContent(c, "memoryB", ["bContent", "right"])) + "</td>" +
          '<td>' + act(ui("act.resolve"), { act: "resolve", id: id }, "primary") +
          act(ui("act.discard"), { act: "discard", id: id }, "danger") + "</td></tr>";
      });
      body(items.length
        ? '<div class="panel"><table>' +
          cols([ui("col.created"), ui("col.status"), ui("col.conflicting"), ui("col.decision")]) +
          rows.join("") + "</table></div>"
        : '<p class="muted">' + esc(ui("empty.conflicts")) + "</p>");
    }).catch(fail);
  }

  function renderQuarantine() {
    setTitle(ui("screen.quarantine.title"), ui("screen.quarantine.sub"));
    get("/quarantine?limit=100").then(function (d) {
      var items = arrOf(d, ["items", "quarantined"]);
      var rows = items.map(function (q) {
        var id = str(pick(q, ["id"]));
        return "<tr>" + tcell(pick(q, ["createdAt", "ts"])) + tcell(et("type", pick(q, ["type"]))) +
          '<td class="wide">' + esc(pick(q, ["content"])) + "</td>" +
          "<td>" + act(ui("act.promote"), { act: "promote", id: id }, "primary") +
          act(ui("act.reject"), { act: "reject", id: id }, "danger") + "</td></tr>";
      });
      body(items.length
        ? '<div class="panel"><table>' +
          cols([ui("col.date"), ui("col.type"), ui("col.content"), ui("col.decision")]) +
          rows.join("") + "</table></div>"
        : '<p class="muted">' + esc(ui("empty.quarantine")) + "</p>");
    }).catch(fail);
  }

  function renderSystem() {
    setTitle(ui("screen.system.title"), ui("screen.system.sub"));
    get("/system").then(function (d) {
      var counts = d.counts || {};
      var runtime = d.runtime || {};
      var cache = runtime.cache || {};
      var html = cards([
        [ui("card.schemaVersion"), d.schemaVersion], [ui("card.memoryItems"), counts.memoryItems],
        [ui("card.conflictsOpen"), counts.conflictsOpen],
        [ui("card.experiencesActive"), counts.experiencesActive],
        [ui("card.auditEntries"), counts.auditEntries], [ui("card.eventsTotal"), counts.eventsTotal],
        [ui("card.cacheRows"), cache.rows], [ui("card.cacheHits"), cache.hits]
      ]);
      var vectorVal = d.vectorEnabled === true ? ui("kv.enabled") : ui("kv.disabled");
      html += '<div class="panel"><h3>' + ui("panel.driver") + "</h3><table>" +
        cols([ui("col.key"), ui("col.value")]) + [
          [ui("kv.driver"), d.driver], [ui("kv.driverNote"), d.driverNote],
          [ui("kv.mode"), d.mode], [ui("kv.vectorSearch"), vectorVal],
          [ui("kv.vectorInfo"), d.vectorInfo],
          [ui("kv.queuePending"), runtime.queue && runtime.queue.pending],
          [ui("kv.cacheHitRate"), cache.hitRate],
          [ui("kv.lastValidation"), runtime.validation && runtime.validation.lastRunAt],
          [ui("kv.cacheMode"), cache.mode], [ui("kv.cacheStore"), cache.store]
        ].map(function (kv) {
          return "<tr><td>" + esc(kv[0]) + "</td><td>" + esc(kv[1]) + "</td></tr>";
        }).join("") + "</table></div>";
      html += '<div class="panel"><h3>' + ui("panel.maintenance") + "</h3>" +
        act(ui("act.validation"), { act: "validation" }, "primary") +
        act(ui("act.consolidation"), { act: "consolidation" }) +
        act(ui("act.cacheClear"), { act: "cache-clear" }) +
        act(ui("act.projection"), { act: "projection" }) + "</div>";
      body(html);
    }).catch(fail);
  }

  function refresh() {
    if (state.view === "overview") renderOverview();
    else if (state.view === "memories") renderMemories();
    else if (state.view === "memory-detail") renderDetail();
    else if (state.view === "experiences") renderExperiences();
    else if (state.view === "experience-detail") renderExperienceDetail();
    else if (state.view === "conflicts") renderConflicts();
    else if (state.view === "quarantine") renderQuarantine();
    else if (state.view === "system") renderSystem();
  }

  function describe() {
    return new Promise(function (res) { setTimeout(res, 350); });
  }
  function runAction(btn) {
    var actName = btn.getAttribute("data-act");
    var base = btn.getAttribute("data-base") || "";
    var id = btn.getAttribute("data-id") || "";
    var view = btn.getAttribute("data-view") || "";
    var idPath = id ? "/" + encodeURIComponent(id) : "";
    if (actName === "lang-zh" || actName === "lang-en") {
      var nextLang = actName === "lang-zh" ? "zh" : "en";
      storeLang(nextLang);
      applyLang(nextLang);
      return;
    }
    if (actName === "open") { state.view = "memory-detail"; state.id = id; refresh(); return; }
    if (actName === "exp-open") { state.view = "experience-detail"; state.id = id; refresh(); return; }
    if (actName === "back") { state.view = view; state.id = null; refresh(); return; }
    if (actName === "archive" || actName === "restore") {
      post(base + idPath + "/" + actName).then(function () {
        flash(actName === "archive" ? ui("flash.archived") : ui("flash.restored"), false);
        describe().then(refresh);
      }).catch(function (e) { flash(str(e && e.message), true); });
      return;
    }
    if (actName === "exp-advance") {
      var next = window.prompt(ui("prompt.advance"), "");
      post("/experiences" + idPath + "/advance", next ? { next: next } : {})
        .then(function () { flash(ui("flash.advanced"), false); describe().then(refresh); })
        .catch(function (e) { flash(str(e && e.message), true); });
      return;
    }
    if (actName === "resolve") {
      var how = window.prompt(ui("prompt.resolve"), "merge");
      if (how === null) return;
      how = how.trim().toLowerCase();
      if (!({ merge: 1, link: 1, supersede: 1, keep_separate: 1 }[how])) {
        flash(fmt(ui("error.unknownResolution"), { v: how }), true);
        return;
      }
      var payload = { resolution: how };
      if (how === "merge") {
        var merged = window.prompt(ui("prompt.merged"), "");
        if (merged === null) return;
        if (!merged.trim()) { flash(ui("error.mergeRequired"), true); return; }
        payload.mergedContent = merged;
      }
      if (!window.confirm(fmt(ui("confirm.resolve"), { id: id, how: how }))) return;
      post("/conflicts" + idPath + "/resolve", payload)
        .then(function () { flash(ui("flash.resolved"), false); describe().then(refresh); })
        .catch(function (e) { flash(str(e && e.message), true); });
      return;
    }
    if (actName === "discard") {
      if (!window.confirm(ui("confirm.discard"))) return;
      post("/conflicts" + idPath + "/discard").then(function () {
        flash(ui("flash.discarded"), false); describe().then(refresh);
      }).catch(function (e) { flash(str(e && e.message), true); });
      return;
    }
    if (actName === "promote") {
      if (!window.confirm(ui("confirm.promote"))) return;
      post("/quarantine" + idPath + "/promote").then(function () {
        flash(ui("flash.promoted"), false); describe().then(refresh);
      }).catch(function (e) { flash(str(e && e.message), true); });
      return;
    }
    if (actName === "reject") {
      var note = window.prompt(ui("prompt.rejectNote"), "");
      if (note === null) return;
      if (!window.confirm(ui("confirm.reject"))) return;
      post("/quarantine" + idPath + "/reject", note ? { note: note } : {}).then(function () {
        flash(ui("flash.rejected"), false); describe().then(refresh);
      }).catch(function (e) { flash(str(e && e.message), true); });
      return;
    }
    var opUrl = { validation: "/system/validation", consolidation: "/system/consolidation",
      "cache-clear": "/system/cache/clear", projection: "/system/projection/rebuild" }[actName];
    if (opUrl) {
      post(opUrl, actName === "validation" ? { dryRun: true } : {}).then(function (d) {
        flash(ui("flash.opOk") + (d && d.message ? " — " + d.message : ""), false);
        describe().then(refresh);
      }).catch(function (e) { flash(str(e && e.message), true); });
    }
  }

  document.addEventListener("click", function (ev) {
    var t = ev.target;
    while (t && t !== document && !t.classList.contains("nav")) t = t.parentNode;
    if (t && t !== document && t.classList.contains("nav")) {
      state.view = t.getAttribute("data-view"); state.id = null;
      document.querySelectorAll(".nav.on").forEach(function (n) { n.classList.remove("on"); });
      t.classList.add("on");
      flash("", false);
      refresh();
      return;
    }
    var btn = ev.target.closest ? ev.target.closest("button[data-act]") : null;
    if (btn) runAction(btn);
  });

  // 嵌入设置面板时，宿主（dsh GUI）语言变化会以 postMessage 实时推送。
  window.addEventListener("message", function (ev) {
    if (!ev || ev.origin !== window.location.origin) return;
    var payload = ev.data;
    if (!payload || payload.source !== "dsh-memory" || payload.type !== "locale") return;
    applyLang(payload.lang === "zh" ? "zh" : "en");
  });

  // 右上角语言切换器的样式（注入 <style>，无需改动服务端页面模板）。
  var styleEl = document.createElement("style");
  styleEl.textContent =
    "main{position:relative}" +
    ".langbar{position:absolute;top:16px;right:22px;display:flex;gap:4px;z-index:3}" +
    ".langbar button{margin:0;padding:2px 9px;font-size:11px;line-height:1.5;border-radius:999px;opacity:.8}" +
    ".langbar button.on{opacity:1;background:#35507f;border-color:#35507f;color:#fff}";
  (document.head || document.documentElement).appendChild(styleEl);

  document.documentElement.lang = cur === "zh" ? "zh-CN" : "en";
  document.title = ui("meta.title");
  shell();
  refresh();
})();
