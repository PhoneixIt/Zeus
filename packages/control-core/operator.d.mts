/**
 * Type declarations for the operator surface (`operator.mjs`).
 *
 * `control-core` is `.mjs` and `.cs` by long-standing convention, and `operator.mjs` is the largest
 * module in it. The alternative to this file was `as unknown as {...}` casts scattered through the
 * harness, which is how a signature drifts away from the implementation without anything noticing -
 * the cast satisfies the compiler while the runtime call quietly changes shape.
 *
 * So this is deliberately MINIMAL: only the four browser-reading members the mission harness uses.
 * A test-only harness needs a declaration for four functions, not for the whole operator surface,
 * and declaring more would invite calls that nothing has proven.
 *
 * KEEP IN STEP WITH `operator.mjs`. If a signature there changes, change it here. That coupling is
 * the point.
 */

export interface OperatorPage {
  /** Last url observed for this target: seeded from discovery, updated by `goto`. */
  url(): string
  /**
   * Run `fn(arg)` inside the page and return the result by value. `arg` must be JSON-serialisable;
   * an unusable argument is refused before anything reaches the page.
   */
  evaluate<TResult = unknown>(fn: (...args: any[]) => TResult | Promise<TResult>, arg?: unknown): Promise<TResult>
  /** Programmatic navigation. The visible Ctrl+L path remains the default for human-observed runs. */
  goto(url: string): Promise<{ frameId?: string }>
}

export interface ReadPageOptions {
  /** Bound on the returned page text, in characters. */
  max?: number
}

export interface PageRead {
  url: string
  title: string
  /** The page's visible innerText, whitespace-collapsed. */
  text: string
  scrollY: number
  pageHeight: number
  viewport: { w: number; h: number }
  headings: string[]
  links: Array<{ t: string; href: string }>
  inputs: Array<{ tag: string; type: string; id: string; name: string; placeholder: string }>
}

/** A page handle from the currently attached browser. */
export declare function page(): Promise<OperatorPage>

/**
 * Read what is on screen. DOM is used to VERIFY what the user can already see.
 *
 * `max` bounds the returned text. This is a READ: nothing here clicks, types, or navigates.
 */
export declare function readPage(options?: ReadPageOptions): Promise<PageRead>

/**
 * Launch the real headed browser if it is not already up.
 *
 * Opens a WINDOW and is audited as a consequential action. The browser mission harness deliberately
 * does NOT use it - it launches its own headless instance on its own port instead - but the function
 * is declared because it is part of the surface, and hiding it would be misleading.
 */
export declare function launchBrowser(options?: { width?: number; height?: number }): Promise<{ launched: boolean; pids: number[] }>