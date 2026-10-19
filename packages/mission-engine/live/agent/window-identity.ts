/**
 * WINDOW IDENTITY: WHICH APPLICATION IS THIS, AND IS IT SAFE TO TYPE INTO?
 * =========================================================================
 *
 * Both halves of this came from live failures on this machine, and both are pure string reasoning
 * about what Windows calls its windows. Nothing here executes anything.
 *
 * 1. A window's TITLE IS A LABEL, NOT ITS IDENTITY.
 *
 *    The goal "open notepad and type hello world from aios" failed at step 1 with
 *
 *        window 1640262 is titled "Untitled - Notepad" now, not "Notepad"
 *
 *    Notepad had launched correctly - real window, real handle, real process - and was rejected
 *    because the verifier demanded a literal string. Because a failed launch satisfies no
 *    dependency, the other five steps were skipped, and the user was told "0 of 7 step(s)
 *    verified" about a mission that had never really been attempted.
 *
 *    Windows titles a window `<document> - <application>`, and an application showing no document
 *    still obeys it: Windows 11 Notepad calls an empty editor "Untitled - Notepad". So the
 *    APPLICATION is the trailing segment.
 *
 * 2. SINGLE-INSTANCE APPS ADOPT A WINDOW, AND THAT CAN MEAN SOMEONE ELSE'S DOCUMENT.
 *
 *    The same goal, once the title check was fixed, produced two verified steps:
 *
 *        s1  launch-app    -> a real Notepad window, verified
 *        s2  desktop-input -> verified: "re-read hwnd ... and found the typed text at the caret"
 *
 *    and the text was in a DIFFERENT Notepad window - one showing `AIOS-TEST-BLANK.txt`, a
 *    document AIOS was never asked to touch - while the window the launch reported sat at
 *    "0 characters".
 *
 *    Windows 11 Notepad is single-instance: launching it again activates the window that is
 *    already open instead of creating one. Both steps reported honest-looking success. The
 *    verifier confirmed the text in the window it was pointed at. And the user's unsaved document
 *    was modified silently.
 *
 *    That is the shape of failure this project is built against: every check passed and something
 *    consequential happened anyway. It is also the clearest available argument that "all steps
 *    verified" is not a sufficient claim about a mission - and it was found by looking at the
 *    actual pixels and the actual window tree after the system said everything was fine.
 */

/** Windows' separator: a hyphen, en dash or em dash, surrounded by whitespace. */
const SEP = /\s+[-\u2013\u2014]\s+/

/**
 * Split a window title into the document it is showing and the application it belongs to.
 *
 * "Untitled - Notepad"       -> { document: "Untitled", app: "Notepad" }
 * "notes.txt - Notepad"      -> { document: "notes.txt", app: "Notepad" }
 * "Notepad"                  -> { document: "",       app: "Notepad" }
 * "*Untitled - Notepad"      -> { document: "Untitled", app: "Notepad" }
 *
 * The leading asterisk is stripped from both halves: Notepad marks a modified document with one,
 * and "was this window modified" is not a question this function is being asked.
 *
 * Only the LAST separator splits. A document whose own name contains " - " stays intact, because
 * only the trailing segment is the application.
 */
export function windowTitleSegments(title: string): { document: string; app: string } {
  const raw = String(title ?? '')
  const parts = raw.split(SEP)
  if (parts.length <= 1) return { document: '', app: raw.replace(/^\*/, '').trim() }
  return {
    document: parts.slice(0, -1).join(' - ').replace(/^\*/, '').trim(),
    app: parts[parts.length - 1].replace(/^\*/, '').trim(),
  }
}

/**
 * Whether two titles name the same APPLICATION.
 *
 * This does not weaken the launch check - the handle, the owning process and the window's
 * continued existence are verified separately, and this decides only which application the window
 * belongs to. A different application is still refused: "Untitled - WordPad" is not Notepad, and
 * "Notepad - Restore Files" is a dialog, not the editor, which is why only the TRAILING segment
 * counts and a substring never does.
 */
export function windowIsSameApp(liveTitle: string, named: string): boolean {
  const a = String(liveTitle ?? '').trim()
  const b = String(named ?? '').trim()
  if (a.length === 0 || b.length === 0) return false
  if (a.toLowerCase() === b.toLowerCase()) return true
  return windowTitleSegments(a).app.toLowerCase() === windowTitleSegments(b).app.toLowerCase()
}

/** The applications this rule knows how to reason about as PAGE-HOSTING rather than DOCUMENT-HOSTING. */
const BROWSER_APPS = /^(google chrome|microsoft edge|chrome|edge|firefox|opera|brave|browser)$/i

/**
 * Why AIOS will not type into an adopted window, or null when it will.
 *
 * `adopted` means the launch did not create a window - it activated one that already existed,
 * which is what single-instance applications do. That alone is not a reason to stop: a person who
 * says "open notepad" and has an EMPTY notepad open plainly wants that window.
 *
 * The reason to stop is the DOCUMENT. An adopted window showing a NAMED document is someone's
 * work, possibly unsaved, and typing into it modifies something the mission was never asked to
 * change. `Untitled` is exempt because it is the platform's own label for an empty scratch buffer:
 * there is nothing in it to lose.
 *
 * THE REFUSAL IS ABOUT TYPING, AND THAT IS THE WHOLE OF ITS PURPOSE.
 * ------------------------------------------------------
 * Observed live: the goal "open a browser on my screen and navigate to https://example.com" ran
 * twice. The first attempt opened Chrome and both steps verified. The replan then re-issued the
 * same launch, Chrome was already showing "Example Domain", and the launch was REFUSED:
 *
 *     browser was already open on "Example Domain", so the launch activated that window rather
 *     than creating a new one. AIOS will not type into a document it was not asked to change
 *
 * Nothing typed. The launch carried a URL and no file path, so the tool's whole action was to ask
 * the shell to navigate a tab. The refusal applied to a case its own message does not describe,
 * and its only remedy - "close that window" - would have destroyed the person's browsing session
 * to protect a document that does not exist.
 *
 * So the exemption is NARROW and is stated as a property of the ACTION, not of the window:
 * a launch that is navigating to a URL and opening no file types nothing, so there is no
 * unsaved-document risk for this rule to police. That is true of a browser and it is NOT true of
 * "open notes.txt in Notepad", which stays refused exactly as before.
 *
 * What is deliberately NOT assumed: that every browser window is safe, or that any title with a
 * dash is a page. The exemption requires the CALLER to have established that this was a browser
 * launch carrying a URL and no path. If the caller cannot establish that, it does not pass the
 * flag, and the refusal stands. Ambiguity fails toward the refusal, which is the direction that
 * costs a retry rather than someone's work.
 *
 * The refusal names the document and the two ways forward, because a refusal a person cannot act
 * on is just an obstacle.
 */
export function adoptedWindowRefusal(
  adopted: boolean,
  liveTitle: string,
  appName: string,
  /** Set by the caller only when it has PROVED this launch navigates a URL and opens no file. */
  opts?: { readonly navigatingUrl?: boolean },
): string | null {
  if (!adopted) return null
  const { document, app } = windowTitleSegments(liveTitle)
  if (document.length === 0) return null
  if (/^untitled$/i.test(document)) return null

  // A URL launch types nothing, so there is no document for this rule to protect. Both halves are
  // required: the caller must have said it is navigating a URL, AND the adopted window must
  // actually belong to a browser. A window whose app is an editor stays refused whatever the
  // caller believes, because an editor is exactly where unsaved work lives.
  //
  // Except when the "document" is plainly a FILE, which makes it a document even inside a browser:
  // "quarterly-report.pdf - Google Chrome" is the built-in viewer showing a file, and typing there
  // carries the same risk this rule exists for. The extension test is deliberately narrow rather
  // than "any title containing a dot", because page titles carry dots routinely - "Node.js",
  // "example.com" - and a general test would refuse the very pages this exemption exists to allow.
  const FILE_EXT = /\.(?:pdf|docx?|xlsx?|pptx?|rtf|odt|ods|odp|txt|md|csv|json|xml|ya?ml|log|ini|sql|ps1|bat)$/i
  if (opts?.navigatingUrl === true
    && BROWSER_APPS.test(app || String(appName ?? ''))
    && !FILE_EXT.test(document)) {
    return null
  }

  return `${appName} was already open on "${document}", so the launch activated that window rather `
    + `than creating a new one. AIOS will not type into a document it was not asked to change - that `
    + `would silently modify work which may not be saved. Close that ${appName} window, or name the `
    + `file you want written so a separate document is opened.`
}