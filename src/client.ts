// dsh-memory — browser half (served at /plugins/dsh-memory/client.js).
//
// Security contract: this file is static code only. It never contains, never
// receives, and never renders the API key or the raw memory rows. The full
// Memory Center lives on the host's own server page (/dsh-memory/memory),
// so this half renders it inside a same-origin iframe. The iframe lives in a
// draggable floating window (portal) that the user opens from the settings
// page, not inline in the settings panel. Memory data stays host-side; no
// secret ever crosses the browser other than through the page's own fetch
// against the same loopback host.
//
// UI: one settings-page section (`settings.section` slot) titled "倒霉蛋 · 记忆中心 /
// Amnesia · Memory Center". The section shows a launch card only; pressing its primary
// button opens the Memory Center in a movable overlay window styled like the
// settings dialog: semi-transparent mask, draggable header, close via the
// header button / mask click / Escape.
//
// Source of record: `lib/client.js` is generated from this file by the package
// build (`tsc -p tsconfig.json`) and runs as a classic script in the host web
// shell, so this file has no top-level import/export. The ambient declarations
// below type only the browser/host surface this half touches (no DOM lib, no
// @types/react — the plugin compiles with zero extra dependencies).

/** Opaque rendered element produced by the local React subset. */
interface DshMemoryNode {}

/** Point in viewport pixels. */
interface DshMemoryPoint {
  readonly x: number
  readonly y: number
}

type DshMemoryChild = DshMemoryNode | string | number | boolean | null | undefined

/** Every props object is read through an index signature; values stay unknown. */
interface DshMemoryProps {
  readonly [name: string]: unknown
}

/** React value surface used by this half (structural subset; no @types/react). */
interface DshMemoryReact {
  createElement(
    type: string | ((props: never) => DshMemoryNode),
    props: DshMemoryProps | null,
    ...children: readonly DshMemoryChild[]
  ): DshMemoryNode
  useCallback<T extends (...args: never[]) => unknown>(callback: T, deps: readonly unknown[]): T
  useState<S>(initial: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void]
  useRef<T>(initial: T): { current: T }
  useLayoutEffect(effect: () => void | (() => void), deps: readonly unknown[]): void
  useSyncExternalStore<T>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => T,
    getServerSnapshot: () => T,
  ): T
}

/** react-dom value surface used by this half. */
interface DshMemoryReactDom {
  createPortal(children: DshMemoryNode, container: DshMemoryPortalTarget | null): DshMemoryNode
}

/** Element created for the injected stylesheet (only id + textContent are used). */
interface DshMemoryStyleElement {
  id: string
  textContent: string
}

/** Element an overlay can be portaled into (<body>). */
interface DshMemoryPortalTarget {}

/** Readable box used by drag clamping. */
interface DshMemoryDomRect {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** Header/window element the pointer-drag handlers read and capture on. */
interface DshMemoryDragElement {
  getBoundingClientRect(): DshMemoryDomRect
  setPointerCapture?(pointerId: number): void
  releasePointerCapture?(pointerId: number): void
}

/** Iframe element wrapping the server page. */
interface DshMemoryFrameElement {
  readonly contentWindow: { postMessage(message: unknown, targetOrigin: string): void } | null
}

/** Minimal target reached by a pointer event (button/link hit test). */
interface DshMemoryEventTarget {
  closest(selector: string): unknown
}

/** Pointer event fields the drag code reads. */
interface DshMemoryPointerLike {
  readonly button: number
  readonly pointerId: number
  readonly clientX: number
  readonly clientY: number
  readonly target: DshMemoryEventTarget | null
}

/** Key event fields the Escape handler needs. */
interface DshMemoryKeyEventLike {
  readonly key: string
  stopImmediatePropagation(): void
}

/** In-flight drag state captured on pointer-down. */
interface DshMemoryDragState {
  readonly pointerId: number
  readonly startX: number
  readonly startY: number
  readonly baseX: number
  readonly baseY: number
  readonly width: number
  readonly height: number
}

/** DOM subset the injected stylesheet needs. */
interface DshMemoryDocument {
  readonly body: DshMemoryPortalTarget
  readonly head: { appendChild(element: DshMemoryStyleElement): void }
  createElement(tag: 'style'): DshMemoryStyleElement
  getElementById(id: string): unknown
  addEventListener(
    type: 'keydown',
    listener: (event: DshMemoryKeyEventLike) => void,
    capture: boolean,
  ): void
  removeEventListener(
    type: 'keydown',
    listener: (event: DshMemoryKeyEventLike) => void,
    capture: boolean,
  ): void
}

/** Locale service injected by the client runtime (`locale`). */
interface DshMemoryLocaleService {
  subscribe(listener: () => void): () => void
  getSnapshot?(): { readonly active?: unknown }
}

/** Section entry registered into the `settings.section` slot. */
interface DshMemorySlotEntry {
  readonly name: string
  readonly id: string
  readonly order: number
  label(): string
}

/** `slots`/`locale` injected into `apply` by the client runtime. */
interface DshMemoryClientContext {
  readonly slots?: {
    readonly inject?: (name: string, mount: () => unknown) => void
    readonly register: (entry: DshMemorySlotEntry, section: () => DshMemoryNode) => unknown
  }
  readonly locale?: DshMemoryLocaleService
}

/** Exports handed back to the host module loader. */
interface DshMemoryClientModule {
  readonly inject: readonly string[]
  readonly apply: (ctx: DshMemoryClientContext) => void
}

/** Host browser globals (this half runs inside the host's settings page). */
interface DshMemoryWebWindow {
  readonly innerWidth: number
  readonly innerHeight: number
  readonly __ModuleLoader__: {
    load(entry: { readonly id: string; readonly factory: (require: (id: string) => unknown) => unknown }): void
  }
}

/** All i18n keys used by this half. */
type DshMemoryKey = 'nav' | 'desc' | 'launch' | 'launchHint' | 'close' | 'ariaMove'

declare const window: DshMemoryWebWindow
declare const document: DshMemoryDocument
declare const navigator: { readonly language: string }
declare const location: { readonly origin: string }

window.__ModuleLoader__.load({
  id: 'dsh-memory',
  factory: (require) => {
    'use strict'

    const React = require('react') as DshMemoryReact
    const { useState, useRef, useLayoutEffect, useSyncExternalStore, useCallback } = React
    const ReactDOM = require('react-dom') as DshMemoryReactDom
    // The runtime client must be in the module graph for the loader contract.
    require('@deepseek-ai/dsh-client-runtime/client')

    /** Server page route exposed by the host half of this plugin. */
    const PAGE_PATH = '/dsh-memory/memory'

    /** Required client services: slots (UI) + locale (i18n). */
    const inject = ['slots', 'locale']

    /** Local alias to keep the portal/drag tree readable below. */
    const el = React.createElement

    // ------------------------------------------------------------------
    // i18n (zh/en; follows the DSH locale service, browser language fallback)
    // ------------------------------------------------------------------
    const zh: Readonly<Record<DshMemoryKey, string>> = {
      nav: '倒霉蛋 · 记忆中心',
      desc: '本地结构化记忆库：创建记忆、语义检索与记忆管理。数据仅保存在本地主机端。',
      launch: '打开记忆中心',
      launchHint: '在独立窗口中浏览与整理记忆；窗口可拖动，支持遮罩点击 / 右上角 / Esc 关闭。',
      close: '关闭记忆中心',
      ariaMove: '拖动记忆中心窗口',
    }
    const en: Readonly<Record<DshMemoryKey, string>> = {
      nav: 'Amnesia · Memory Center',
      desc: 'Local structured memory vault: authoring, semantic search and management. Data stays on your local host.',
      launch: 'Open Memory Center',
      launchHint: 'Browse and manage your memory in a separate window. The window is draggable; close via mask click, the header button, or Esc.',
      close: 'Close Memory Center',
      ariaMove: 'Drag the Memory Center window',
    }

    let localeService: DshMemoryLocaleService | undefined
    function attachLocale(service: DshMemoryLocaleService): void {
      localeService = service
    }
    function activeLocale(): string {
      const raw = localeService?.getSnapshot?.()?.active
      return typeof raw === 'string' ? raw : (typeof navigator !== 'undefined' ? navigator.language : '') || 'en'
    }
    function t(key: DshMemoryKey): string {
      const dict = activeLocale().toLowerCase().startsWith('zh') ? zh : en
      return dict[key] ?? key
    }
    function useLocale(): string {
      return useSyncExternalStore(
        (onChange) => (localeService ? localeService.subscribe(onChange) : () => {}),
        () => activeLocale(),
        () => 'en',
      )
    }

    // ------------------------------------------------------------------
    // settings-page section (props: { close })
    // ------------------------------------------------------------------
    const CLOSE_ICON: DshMemoryNode = el(
      'svg',
      {
        viewBox: '0 0 16 16',
        width: 16,
        height: 16,
        'aria-hidden': true,
        className: 'dsh-memcenter-close-svg',
      },
      el('path', {
        d: 'M4 4l8 8m0-8l-8 8',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
      }),
    )

    /**
     * Movable Memory Center window. Rendered through a portal into <body> so it
     * layers above the settings dialog; centered on open, draggable from its
     * header, and closed by the header button / mask click / Escape.
     */
    function MemoryCenterWindow({
      lang,
      onClose,
    }: {
      readonly lang: string
      readonly onClose: () => void
    }): DshMemoryNode {
      const origin = typeof location !== 'undefined' ? location.origin : ''
      const frameRef = useRef<DshMemoryFrameElement | null>(null)
      const winRef = useRef<DshMemoryDragElement | null>(null)
      const headRef = useRef<DshMemoryDragElement | null>(null)
      const dragRef = useRef<DshMemoryDragState | null>(null)
      // null 表示使用 CSS 居中定位；一旦拖动则记录具体像素坐标。
      const [pos, setPos] = useState<DshMemoryPoint | null>(null)
      const [moving, setMoving] = useState(false)
      // 初始语言固定进 src；后续语言变化走 postMessage，避免整页重载。
      const [initialSrc] = useState(() => PAGE_PATH + '?locale=' + lang)
      const prevLang = useRef(lang)
      useLayoutEffect(() => {
        const prev = prevLang.current
        prevLang.current = lang
        if (prev === lang) return
        const target = frameRef.current && frameRef.current.contentWindow
        if (target) {
          target.postMessage({ source: 'dsh-memory', type: 'locale', lang }, origin)
        }
      }, [lang, origin])

      // Esc 仅关闭浮窗（capture 阶段 + stopImmediatePropagation，
      // 确保不触发下层设置弹窗自身的 Esc 处理）。
      useLayoutEffect(() => {
        function onKeyDown(e: DshMemoryKeyEventLike): void {
          if (e.key === 'Escape') {
            e.stopImmediatePropagation()
            onClose()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [onClose])

      function startDrag(e: DshMemoryPointerLike): void {
        if (e.button !== 0) return
        const t = e.target
        if (t && t.closest && t.closest('button, a')) return
        const win = winRef.current
        const head = headRef.current
        if (!win || !head) return
        const rect = win.getBoundingClientRect()
        const base = pos || { x: rect.left, y: rect.top }
        if (!pos) setPos(base)
        dragRef.current = {
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          baseX: base.x,
          baseY: base.y,
          width: rect.width,
          height: rect.height,
        }
        if (head.setPointerCapture) {
          try {
            head.setPointerCapture(e.pointerId)
          } catch {
            /* ignore */
          }
        }
        setMoving(true)
      }

      function moveDrag(e: DshMemoryPointerLike): void {
        const d = dragRef.current
        if (!d || e.pointerId !== d.pointerId) return
        const vw = window.innerWidth
        const vh = window.innerHeight
        const margin = 56
        const rawX = d.baseX + (e.clientX - d.startX)
        const rawY = d.baseY + (e.clientY - d.startY)
        const x = Math.min(Math.max(rawX, margin - d.width), Math.max(vw - margin, margin - d.width))
        const y = Math.min(Math.max(rawY, 0), Math.max(vh - 48, 0))
        setPos({ x, y })
      }

      function endDrag(e: DshMemoryPointerLike): void {
        const d = dragRef.current
        if (!d || e.pointerId !== d.pointerId) return
        dragRef.current = null
        setMoving(false)
        const head = headRef.current
        if (head && head.releasePointerCapture) {
          try {
            head.releasePointerCapture(e.pointerId)
          } catch {
            /* ignore */
          }
        }
      }

      // Drag starts only on the header; pointer capture then routes every
      // move/up back here, so the iframe and the rest of the window never
      // receive the drag interaction.
      const headHandlers: DshMemoryProps = {
        ref: headRef,
        className: 'dsh-memcenter-win-head',
        onPointerDown: startDrag,
        onPointerMove: moveDrag,
        onPointerUp: endDrag,
        onPointerCancel: endDrag,
      }
      const winClass =
        'dsh-memcenter-win' +
        (pos ? ' dsh-memcenter-win--pos' : ' dsh-memcenter-win--center') +
        (moving ? ' dsh-memcenter-win--dragging' : '')
      const winStyle = pos ? { left: pos.x + 'px', top: pos.y + 'px' } : null
      return el(
        'div',
        { className: 'dsh-memcenter-overlay' },
        el('div', { className: 'dsh-memcenter-mask', onClick: onClose }),
        el(
          'div',
          {
            ref: winRef,
            className: winClass,
            style: winStyle,
            role: 'dialog',
            'aria-modal': true,
            'aria-label': t('nav'),
          },
          el(
            'div',
            headHandlers,
            el('div', { className: 'dsh-memcenter-win-title' }, t('nav')),
            el(
              'button',
              { type: 'button', className: 'dsh-memcenter-win-close', onClick: onClose, 'aria-label': t('close') },
              CLOSE_ICON,
            ),
          ),
          el(
            'div',
            { className: 'dsh-memcenter-win-body' },
            el('iframe', {
              ref: frameRef,
              className: 'dsh-memcenter-win-frame',
              src: initialSrc,
              title: t('nav'),
              sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals',
            }),
          ),
        ),
      )
    }

    function MemoryCenterSection(): DshMemoryNode {
      useLocale()
      const lang = activeLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en'
      const [open, setOpen] = useState(false)
      const openWindow = useCallback(() => setOpen(true), [])
      const closeWindow = useCallback(() => setOpen(false), [])
      return el(
        'div',
        { className: 'dsh-memcenter-section' },
        el(
          'div',
          { className: 'dsh-memcenter-copy' },
          el('div', { className: 'dsh-memcenter-title' }, t('nav')),
          el('div', { className: 'dsh-memcenter-desc' }, t('desc')),
        ),
        el(
          'div',
          { className: 'dsh-memcenter-launch-card' },
          el(
            'div',
            { className: 'dsh-memcenter-launch-copy' },
            el('div', { className: 'dsh-memcenter-launch-desc' }, t('launchHint')),
          ),
          el(
            'button',
            { type: 'button', className: 'dsh-memcenter-launch-btn', onClick: openWindow },
            t('launch'),
          ),
        ),
        open
          ? ReactDOM.createPortal(
              el(MemoryCenterWindow, { lang: lang, onClose: closeWindow }),
              typeof document !== 'undefined' ? document.body : null,
            )
          : null,
      )
    }

    const DSH_MEMORY_CSS = `
.dsh-memcenter-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  min-width: 0;
}
.dsh-memcenter-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.dsh-memcenter-title {
  font: 600 16px/24px var(--dsw-font-family, system-ui, sans-serif);
  color: var(--dsw-alias-label-primary, inherit);
}
.dsh-memcenter-desc {
  font: 12px/18px var(--dsw-font-family, system-ui, sans-serif);
  color: var(--dsw-alias-label-tertiary, #888);
}
.dsh-memcenter-launch-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px;
  box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35));
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1, transparent);
}
.dsh-memcenter-launch-copy {
  min-width: 0;
}
.dsh-memcenter-launch-desc {
  font: 12px/18px var(--dsw-font-family, system-ui, sans-serif);
  color: var(--dsw-alias-label-tertiary, #888);
}
.dsh-memcenter-launch-btn {
  flex: none;
  border: 1px solid var(--dsw-alias-state-business-primary, #4176e6);
  border-radius: 10px;
  padding: 8px 18px;
  font: 500 13px/1.6 var(--dsw-font-family, system-ui, sans-serif);
  color: #fff;
  background: var(--dsw-alias-state-business-primary, #4176e6);
  cursor: pointer;
}
.dsh-memcenter-launch-btn:hover {
  background: var(--dsw-alias-state-business-primary-strong, #2f5bd9);
}
/* ---- floating window overlay (portal to body) ---- */
.dsh-memcenter-overlay {
  position: fixed;
  inset: 0;
  z-index: 4000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.dsh-memcenter-mask {
  position: absolute;
  inset: 0;
  background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,.45));
  backdrop-filter: var(--dsw-mask-blur, blur(4px));
}
.dsh-memcenter-win {
  position: absolute;
  display: flex;
  flex-direction: column;
  width: min(900px, calc(100vw - 48px));
  height: min(85vh, calc(100vh - 48px));
  min-height: 320px;
  box-sizing: border-box;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-inverted, rgba(128,128,128,.45));
  border-radius: 20px;
  background: var(--dsw-alias-bg-layer-2, #fff);
  box-shadow: 0 24px 64px rgba(0,0,0,.28);
}
.dsh-memcenter-win--center {
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
}
.dsh-memcenter-win--dragging {
  user-select: none;
}
.dsh-memcenter-win-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 8px 0 16px;
  height: 46px;
  box-sizing: border-box;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.22));
  cursor: grab;
}
.dsh-memcenter-win--dragging .dsh-memcenter-win-head {
  cursor: grabbing;
}
.dsh-memcenter-win-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 600 14px/1.6 var(--dsw-font-family, system-ui, sans-serif);
  color: var(--dsw-alias-label-primary, inherit);
}
.dsh-memcenter-win-close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  color: var(--dsw-alias-label-secondary, #666);
  background: transparent;
  cursor: pointer;
}
.dsh-memcenter-win-close:hover {
  color: var(--dsw-alias-label-primary, inherit);
  background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.15));
}
.dsh-memcenter-win-body {
  flex: 1;
  min-height: 0;
}
.dsh-memcenter-win-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: var(--dsw-alias-bg-layer-1, transparent);
}
`
    /** Inject the plugin stylesheet once; theme vars follow the app theme. */
    function ensureStyles(): void {
      if (typeof document === 'undefined') return
      if (document.getElementById('dsh-memory-style')) return
      const style = document.createElement('style')
      style.id = 'dsh-memory-style'
      style.textContent = DSH_MEMORY_CSS
      document.head.appendChild(style)
    }

    function apply(ctx: DshMemoryClientContext): void {
      const slots = ctx.slots
      if (!slots || typeof slots.inject !== 'function') return
      if (ctx.locale) attachLocale(ctx.locale)
      ensureStyles()
      const register = slots.register
      // Settings-page section embedding the Memory Center page.
      slots.inject('settings.section', () =>
        register({
          name: 'settings.section',
          id: 'dsh-memory',
          order: 90,
          label: () => t('nav'),
        }, MemoryCenterSection),
      )
    }

    const exports: DshMemoryClientModule = { inject, apply }
    return exports
  },
})
