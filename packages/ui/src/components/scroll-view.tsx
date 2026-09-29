import {
  createEffect,
  createMemo,
  mergeProps,
  onCleanup,
  Show,
  splitProps,
  untrack,
  type Accessor,
  type ComponentProps,
} from "solid-js"
import { Portal } from "solid-js/web"
import { createStore } from "solid-js/store"
import { useI18n } from "../context/i18n"

export type ScrollViewThumbVisibility = "hover" | "scroll"

export interface ScrollViewProps extends ComponentProps<"div"> {
  viewportRef?: (el: HTMLDivElement) => void
  viewportClass?: string
  scrollElement?: Accessor<HTMLDivElement | undefined>
  thumbInsetTop?: number
  orientation?: "vertical" | "horizontal" | "both"
  /**
   * `hover`: show while hovered or scrolling. `scroll`: show only while scrolling.
   *
   * In most cases, scrolling a container = hovering over it, so this change has no effect.
   * This is a special case to account for the home page scroll, where scrolling a container != hovering over it
   * */
  thumbVisibility?: ScrollViewThumbVisibility
  /** Mount the thumb into an external track. Scroll metrics still come from this ScrollView. */
  thumbContainer?: HTMLElement | Accessor<HTMLElement | undefined>
  /** Element whose hover reveals the thumb. Defaults to the ScrollView root when unset. */
  thumbHoverTarget?: HTMLElement | Accessor<HTMLElement | undefined>
}

export const scrollKey = (event: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">) => {
  if (event.altKey || event.ctrlKey || event.metaKey) return
  if (event.shiftKey && event.key !== " ") return

  switch (event.key) {
    case "PageDown":
      return "page-down"
    case "PageUp":
      return "page-up"
    case "Home":
      return "home"
    case "End":
      return "end"
    case "ArrowUp":
      return "up"
    case "ArrowDown":
      return "down"
    case " ":
      return event.shiftKey ? "page-up" : "page-down"
  }
}

export function canScrollKey(element: HTMLElement, key: NonNullable<ReturnType<typeof scrollKey>>) {
  const up = key === "up" || key === "page-up" || key === "home"
  return up ? element.scrollTop > 0 : element.scrollTop + element.clientHeight < element.scrollHeight
}

export function scrollKeyOwner(
  root: HTMLElement,
  target: EventTarget | null,
  key: NonNullable<ReturnType<typeof scrollKey>>,
) {
  const element = target instanceof Element ? target : undefined
  const owner = element?.closest<HTMLElement>("[data-scrollable]")
  if (!owner || owner === root) return root
  if (!root.contains(owner)) return owner
  return canScrollKey(owner, key) ? owner : root
}

export function isScrollKeyTarget(target: EventTarget | null, key: NonNullable<ReturnType<typeof scrollKey>>) {
  const element = target instanceof HTMLElement ? target : undefined
  if (!element) return true
  if (["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) || element.isContentEditable) return false
  if ((key === "page-up" || key === "page-down") && element.closest('button, a[href], [role="button"]')) return false
  return true
}

export function scrollTopFromThumbPointer(input: {
  pointer: number
  viewportTop: number
  grabOffset: number
  clientHeight: number
  scrollHeight: number
  thumbHeight: number
  /** Viewport height used for max scroll. Defaults to `clientHeight` (track == viewport). */
  scrollClientHeight?: number
}) {
  const padding = 8
  const maxThumbTop = input.clientHeight - padding * 2 - input.thumbHeight
  if (maxThumbTop <= 0) return 0
  const thumbTop = Math.max(0, Math.min(input.pointer - input.viewportTop - padding - input.grabOffset, maxThumbTop))
  return (thumbTop / maxThumbTop) * Math.max(0, input.scrollHeight - (input.scrollClientHeight ?? input.clientHeight))
}

export function observeScrollView(viewport: HTMLElement, track: HTMLElement | undefined, update: () => void) {
  let frame: number | undefined
  const schedule = () => {
    if (frame !== undefined) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      update()
    })
  }
  const resize = new ResizeObserver(schedule)
  const observe = () => {
    resize.disconnect()
    ;[viewport, ...viewport.children, track].forEach((element) => {
      if (element) resize.observe(element)
    })
    schedule()
  }
  const mutations = new MutationObserver((records) => {
    if (records.some((record) => record.type === "childList" && record.target === viewport)) {
      observe()
      return
    }
    schedule()
  })
  mutations.observe(viewport, { childList: true, characterData: true, subtree: true })
  observe()
  return () => {
    if (frame !== undefined) cancelAnimationFrame(frame)
    resize.disconnect()
    mutations.disconnect()
  }
}

export function ScrollView(props: ScrollViewProps) {
  const i18n = useI18n()
  const merged = mergeProps({ orientation: "both", thumbVisibility: "hover" }, props)
  const [local, events, rest] = splitProps(
    merged,
    [
      "class",
      "children",
      "viewportRef",
      "viewportClass",
      "scrollElement",
      "thumbInsetTop",
      "orientation",
      "thumbVisibility",
      "thumbContainer",
      "thumbHoverTarget",
      "style",
    ],
    [
      "onScroll",
      "onWheel",
      "onTouchStart",
      "onTouchMove",
      "onTouchEnd",
      "onTouchCancel",
      "onPointerDown",
      "onClick",
      "onKeyDown",
    ],
  )

  let contentRef!: HTMLDivElement
  let viewportRef!: HTMLDivElement

  const resolveEl = (value: HTMLElement | Accessor<HTMLElement | undefined> | undefined) => {
    if (typeof value === "function") return value()
    return value
  }

  const thumbMount = createMemo(() => resolveEl(local.thumbContainer))
  const thumbHover = createMemo(() => resolveEl(local.thumbHoverTarget))
  const hoverRoot = () => !local.thumbHoverTarget && !local.thumbContainer

  const [state, setState] = createStore({
    isHovered: false,
    isDragging: false,
    isScrolling: false,
    thumbHeight: 0,
    thumbTop: 0,
    showThumb: false,
    thumbWidth: 0,
    thumbLeft: 0,
    showHorizontal: false,
    above: false,
    below: false,
    before: false,
    after: false,
  })
  const isHovered = () => state.isHovered
  const isDragging = () => state.isDragging
  const isScrolling = () => state.isScrolling
  const thumbHeight = () => state.thumbHeight
  const thumbTop = () => state.thumbTop
  const showThumb = () => state.showThumb

  let scrollIdleTimer: ReturnType<typeof setTimeout> | undefined
  let stopDragging: (() => void) | undefined

  const markScrolling = () => {
    setState("isScrolling", true)
    if (scrollIdleTimer !== undefined) clearTimeout(scrollIdleTimer)
    scrollIdleTimer = setTimeout(() => setState("isScrolling", false), 800)
  }

  const thumbVisible = () => {
    if (isDragging()) return true
    if (isScrolling()) return true
    return local.thumbVisibility === "hover" && isHovered()
  }

  onCleanup(() => {
    if (scrollIdleTimer !== undefined) clearTimeout(scrollIdleTimer)
    stopDragging?.()
  })

  const updateThumb = () => {
    if (!viewportRef) return
    const { scrollTop, scrollHeight, clientHeight } = viewportRef

    const trackHeight = Math.max(0, (thumbMount()?.clientHeight || clientHeight) - (local.thumbInsetTop ?? 0) - 16)
    const height = Math.min(trackHeight, Math.max(32, (clientHeight / Math.max(1, scrollHeight)) * trackHeight))
    const trackWidth = Math.max(0, viewportRef.clientWidth - 16)
    const width = Math.min(
      trackWidth,
      Math.max(32, (viewportRef.clientWidth / Math.max(1, viewportRef.scrollWidth)) * trackWidth),
    )
    const horizontalProgress = Math.min(
      1,
      Math.abs(viewportRef.scrollLeft) / Math.max(1, viewportRef.scrollWidth - viewportRef.clientWidth),
    )
    setState({
      above: scrollTop > 1,
      below: scrollTop + clientHeight < scrollHeight - 1,
      before: Math.abs(viewportRef.scrollLeft) > 1,
      after: Math.abs(viewportRef.scrollLeft) + viewportRef.clientWidth < viewportRef.scrollWidth - 1,
      showThumb: local.orientation !== "horizontal" && clientHeight > 0 && scrollHeight > clientHeight,
      thumbHeight: Math.max(0, height),
      thumbTop:
        8 +
        Math.max(
          0,
          Math.min(
            (scrollTop / Math.max(1, scrollHeight - clientHeight)) * (trackHeight - height),
            trackHeight - height,
          ),
        ),
      showHorizontal:
        local.orientation !== "vertical" &&
        viewportRef.clientWidth > 0 &&
        viewportRef.scrollWidth > viewportRef.clientWidth,
      thumbWidth: Math.max(0, width),
      thumbLeft:
        8 + (viewportRef.matches(":dir(rtl)") ? 1 - horizontalProgress : horizontalProgress) * (trackWidth - width),
    })
  }

  createEffect(() => {
    viewportRef = local.scrollElement?.() ?? contentRef
    if (!viewportRef) return
    untrack(() => local.viewportRef?.(viewportRef))
    const viewport = viewportRef
    const onScroll = (event: Event) => {
      updateThumb()
      markScrolling()
      if (typeof events.onScroll === "function") events.onScroll(event as any)
    }
    viewport.addEventListener("scroll", onScroll, { passive: true })
    const dispose = observeScrollView(viewport, thumbMount(), updateThumb)
    updateThumb()
    onCleanup(() => {
      stopDragging?.()
      viewport.removeEventListener("scroll", onScroll)
      dispose()
    })
  })

  createEffect(() => {
    const target = thumbHover()
    if (!target) return

    const enter = () => setState("isHovered", true)
    const leave = () => setState("isHovered", false)
    target.addEventListener("pointerenter", enter)
    target.addEventListener("pointerleave", leave)
    onCleanup(() => {
      target.removeEventListener("pointerenter", enter)
      target.removeEventListener("pointerleave", leave)
      setState("isHovered", false)
    })
  })

  const onThumbPointerDown = (e: PointerEvent, horizontal = false) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    stopDragging?.()
    setState("isDragging", true)
    const thumbRef = e.currentTarget as HTMLDivElement
    const grabOffset = horizontal
      ? e.clientX - thumbRef.getBoundingClientRect().left
      : e.clientY - thumbRef.getBoundingClientRect().top
    const track = horizontal ? viewportRef : (thumbMount() ?? viewportRef)
    const inset = horizontal ? 0 : (local.thumbInsetTop ?? 0)

    thumbRef.setPointerCapture(e.pointerId)

    const onPointerMove = (e: PointerEvent) => {
      const { scrollHeight, clientHeight } = viewportRef
      const offset = scrollTopFromThumbPointer({
        pointer: horizontal ? e.clientX : e.clientY,
        viewportTop: horizontal ? track.getBoundingClientRect().left : track.getBoundingClientRect().top + inset,
        grabOffset,
        clientHeight: horizontal ? track.clientWidth : track.clientHeight - inset,
        scrollClientHeight: horizontal ? viewportRef.clientWidth : clientHeight,
        scrollHeight: horizontal ? viewportRef.scrollWidth : scrollHeight,
        thumbHeight: horizontal ? state.thumbWidth : thumbHeight(),
      })
      viewportRef[horizontal ? "scrollLeft" : "scrollTop"] =
        horizontal && viewportRef.matches(":dir(rtl)")
          ? offset - (viewportRef.scrollWidth - viewportRef.clientWidth)
          : offset
      updateThumb()
    }

    const done = () => {
      setState("isDragging", false)
      thumbRef.removeEventListener("pointermove", onPointerMove)
      thumbRef.removeEventListener("pointerup", done)
      thumbRef.removeEventListener("pointercancel", done)
      thumbRef.removeEventListener("lostpointercapture", done)
      if (thumbRef.hasPointerCapture(e.pointerId)) thumbRef.releasePointerCapture(e.pointerId)
      stopDragging = undefined
    }

    stopDragging = done
    thumbRef.addEventListener("pointermove", onPointerMove)
    thumbRef.addEventListener("pointerup", done)
    thumbRef.addEventListener("pointercancel", done)
    thumbRef.addEventListener("lostpointercapture", done)
  }

  const renderThumb = (horizontal = false) => (
    <div
      onPointerDown={(event) => onThumbPointerDown(event, horizontal)}
      data-orientation={horizontal ? "horizontal" : "vertical"}
      class="scroll-view__thumb"
      data-visible={thumbVisible()}
      data-dragging={isDragging()}
      style={{
        height: horizontal ? undefined : `${thumbHeight()}px`,
        top: horizontal ? undefined : `${local.thumbInsetTop ?? 0}px`,
        width: horizontal ? `${state.thumbWidth}px` : undefined,
        transform: horizontal ? `translateX(${state.thumbLeft}px)` : `translateY(${thumbTop()}px)`,
        "z-index": 100, // ensure it displays over content
      }}
    />
  )

  // Keybinds implementation
  // We ensure the viewport has a tabindex so it can receive focus
  // We can also explicitly catch PageUp/Down if we want smooth scroll or specific behavior,
  // but native usually handles this perfectly. Let's explicitly ensure it behaves well.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return
    if (e.target instanceof Element && e.target.closest('[role="listbox"], [role="menu"], [role="tablist"]')) return
    // If user is focused on an input inside the scroll view, don't hijack keys
    if (document.activeElement && ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) {
      return
    }
    const next = scrollKey(e)
    if (!next) return
    if (!isScrollKeyTarget(e.target, next)) return
    if (scrollKeyOwner(viewportRef, e.target, next) !== viewportRef) return

    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth"
    const scrollAmount = viewportRef.clientHeight * 0.8
    const lineAmount = 40

    switch (next) {
      case "page-down":
        e.preventDefault()
        viewportRef.scrollBy({ top: scrollAmount, behavior })
        break
      case "page-up":
        e.preventDefault()
        viewportRef.scrollBy({ top: -scrollAmount, behavior })
        break
      case "home":
        e.preventDefault()
        viewportRef.scrollTo({ top: 0, behavior })
        break
      case "end":
        e.preventDefault()
        viewportRef.scrollTo({ top: viewportRef.scrollHeight, behavior })
        break
      case "up":
        e.preventDefault()
        viewportRef.scrollBy({ top: -lineAmount, behavior })
        break
      case "down":
        e.preventDefault()
        viewportRef.scrollBy({ top: lineAmount, behavior })
        break
    }
  }

  return (
    <div
      class={`scroll-view ${local.class || ""}`}
      data-orientation={local.orientation}
      data-scroll-above={state.above || undefined}
      data-scroll-below={state.below || undefined}
      data-scroll-before={state.before || undefined}
      data-scroll-after={state.after || undefined}
      style={local.style}
      onPointerEnter={() => {
        if (hoverRoot()) setState("isHovered", true)
      }}
      onPointerLeave={() => {
        if (hoverRoot()) setState("isHovered", false)
      }}
      {...rest}
    >
      {/* Viewport */}
      <div
        ref={contentRef}
        class={`${local.scrollElement ? "scroll-view__content" : "scroll-view__viewport"} ${local.viewportClass || ""}`}
        data-scrollable={local.scrollElement ? undefined : ""}
        onWheel={(e) => {
          markScrolling()
          const handler = events.onWheel
          if (typeof handler === "function") handler(e as any)
          if (Array.isArray(handler)) handler[0](handler[1], e as any)
        }}
        onTouchStart={events.onTouchStart as any}
        onTouchMove={events.onTouchMove as any}
        onTouchEnd={events.onTouchEnd as any}
        onTouchCancel={events.onTouchCancel as any}
        onPointerDown={events.onPointerDown as any}
        onClick={events.onClick as any}
        tabIndex={0}
        role="region"
        aria-label={i18n.t("ui.scrollView.ariaLabel")}
        onKeyDown={(e) => {
          onKeyDown(e)
          if (typeof events.onKeyDown === "function") events.onKeyDown(e as any)
        }}
      >
        {local.children}
      </div>

      {/* Thumb Overlay — optionally portaled into an external track */}
      <Show when={showThumb()}>
        <Show when={thumbMount()} fallback={renderThumb()}>
          {(mount) => <Portal mount={mount()}>{renderThumb()}</Portal>}
        </Show>
      </Show>
      <Show when={state.showHorizontal}>{renderThumb(true)}</Show>
    </div>
  )
}
