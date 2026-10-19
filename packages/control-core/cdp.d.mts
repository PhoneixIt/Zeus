/**
 * Type declarations for the dependency-free CDP client (`cdp.mjs`).
 *
 * `control-core` holds its operator tooling as `.mjs` beside the C# host, so `cdp.mjs` belongs there
 * rather than in TypeScript. But every test in this repository is TypeScript, and the typecheck gate
 * is configured to require ZERO errors across the project - so an untyped import would put errors in
 * a gate that has no baseline file and therefore no tolerance.
 *
 * These declarations are hand-written and deliberately MINIMAL: they describe the surface a caller
 * may use and nothing else. A wider declaration would let a caller reach into internals this file
 * does not promise to keep, which is how a dependency-free client quietly grows back into the
 * dependency it replaced.
 *
 * If `cdp.mjs` gains a method, this file gains a line. If it loses one, this file loses a line. That
 * coupling is the point - it is the check that keeps the two in step.
 */

export declare class CdpError extends Error {
  readonly name: 'CdpError'
  /** The CDP method that failed, when the failure can be attributed to one. */
  readonly method?: string
  /** Whatever extra detail the browser supplied with its error, verbatim. */
  readonly cdp?: unknown
}

export interface Page {
  /** Last url observed for this target: seeded from discovery, updated by `goto`. */
  url(): string
  /** The page's own `document.title`, read live. */
  title(): Promise<string>
  /**
   * Run `fn(arg)` inside the page and return its result by value.
   * `arg` must be JSON-serialisable - there is no structured-clone bridge, and an unusable argument
   * is refused here rather than failing inside the page.
   */
  evaluate<TResult = unknown>(fn: (...args: any[]) => TResult | Promise<TResult>, arg?: unknown): Promise<TResult>
  /** Programmatic navigation. The visible Ctrl+L path in `operator.mjs` remains the default. */
  goto(url: string): Promise<{ frameId?: string }>
  /**
   * Wait until the document has parsed, and report the state it reached.
   *
   * `goto` resolves when the navigation COMMITS, not when the DOM exists, so anything that
   * inspects the page must ask for the load state rather than infer it.
   */
  waitForLoad(timeoutMs?: number): Promise<string>
  /** Scroll by a pixel delta, through the Input domain - the same path a wheel takes. */
  scroll(deltaY: number, x?: number, y?: number): Promise<{ deltaY: number }>
  /**
   * Click at viewport coordinates through the Input domain, and report what was at those
   * coordinates, sampled BEFORE the click. `anchorHref` is the nearest enclosing link, since
   * `elementFromPoint` returns the innermost node and a logo link would otherwise look like
   * a click on an image.
   */
  clickAt(x: number, y: number): Promise<{
    tag: string; href: string | null; text: string; anchorHref: string | null; anchorText: string | null
  } | null>
  /** Navigate back in history, and report where it went. */
  goBack(): Promise<{ wentBack: boolean; from?: string; to?: string }>
  close(): void
}

export interface Context {
  /** Current page targets, fetched fresh from the browser each call. */
  pages(): Promise<Page[]>
  /** Create a page through the browser, then attach to it the same way as every other page. */
  newPage(url?: string): Promise<Page>
  /** Release every socket this context opened. */
  close(): void
}

export interface Browser {
  contexts(): Context[]
  close(): void
}

export interface CdpDependencies {
  /** Defaults to `fetch` against the CDP endpoint. Injected so discovery is testable offline. */
  httpGet?: (url: string, opts?: { method?: string }) => Promise<any>
  /** Defaults to Node's built-in `WebSocket`. Injected so the protocol is testable offline. */
  openSocket?: (url: string, opts?: unknown) => Promise<any>
  /** Per-command deadline. Every command rejects rather than hanging if it passes. */
  timeoutMs?: number
}

/**
 * Attach to a browser already listening on `baseUrl` (e.g. `http://127.0.0.1:9333`).
 *
 * Launches nothing: attaching to a browser someone else started is a smaller act than starting one.
 * Rejects with `CdpError` when nothing is listening, when discovery answers non-JSON, or when the
 * status is not OK.
 */
export declare function connectOverCDP(baseUrl: string, deps?: CdpDependencies): Promise<Browser>