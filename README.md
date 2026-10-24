# JLC Browser

A local Chromium browser for JLC, with network diagnostics and smaller upload copies.

JLC Browser was originally built to optimize the JLC browsing and upload workflow, but its tabs, translation, network diagnostics, and upload tools can support many other websites and workflows.

This repository contains the source code and tests. Local browser profiles, login/session data, diagnostic logs, prepared uploads, screenshots, translation caches, and packaged builds are excluded from version control.

## Run

For the packaged Windows app, double-click **JLC Browser** on the desktop, or run `release/JLCBrowser-0.3.0-win-x64/JLCBrowser.exe`. Keep the whole release folder together. Node.js and npm are not needed to run it. This local build is unsigned.

The packaged app stores its profile and logs under `%APPDATA%\JLCBrowser`, separately from the development profile. Sign in once when first opening it. The same DNS and performance-script exclusions are enabled without command-line arguments. `JLCBrowser.exe --baseline --system-dns` restores the baseline settings.

To run from source:

```powershell
npm.cmd install
npm.cmd start
```

The browser opens JLC's standard 3D upload page. It uses a local profile in `profile/`; sign in yourself when required. TLS verification, sandboxing, and normal site security remain enabled. It does not change JLC's upload endpoint, retry files automatically, or extend server timeouts.

The browser uses Cloudflare DNS-over-HTTPS at `https://1.1.1.1/dns-query`. Public hostname queries from this browser go to Cloudflare. This addresses observed DNS failures for JLC's login host: the configured DNS server refused direct queries while Cloudflare resolved them successfully. Windows DNS and other applications are not modified. It does not establish that DNS caused the upload's server-side timeout.

The default run skips two specific performance-monitoring scripts that each stalled for approximately 85 seconds during diagnosis. `npm.cmd run start:baseline` restores their normal loading and the default system resolver. No other scripts are blocked.

To create a new Windows x64 release, run `npm.cmd run build:win`. This uses Electron's bundled Windows runtime and an explicit list of app files; profiles, credentials, uploads and diagnostic logs are excluded. It checks the resulting application files and refuses to overwrite an existing release. Increment `package.json`'s version before making another release.

## Tabs

Website links and buttons that open a new page now open a visible tab in the same window. This includes `target="_blank"`, `window.open`, blank popups that navigate afterward, and form POST popups. Chromium's popup handling retains normal opener messaging, referrer and form data. Ctrl-click/middle-click links open background tabs; tabs share the same login/session and each has its own network capture. Switching tabs keeps the other pages alive, with background throttling disabled.

Use **+** or **Ctrl+T** for a new tab, **Ctrl+W** to close it, **Ctrl+Tab** / **Ctrl+Shift+Tab** to switch, and **Ctrl+L** to enter an address. The toolbar provides back, forward and reload for the active tab. Closing the last tab closes the browser. A page that prevents unloading can ask you to stay before closing. Open tabs are not restored after restarting; login data still persists in the existing profile.

## Translation

Click **Translate** beside Reload to translate the active page into English in place. The button changes to **Original**; click it to restore original text without navigating, reloading, replacing elements or interrupting a pending upload. Each tab has independent translation state. New documents start in their original language; changing content and newly visible text are checked while translation is enabled.

The requested hybrid mode looks up exact source text in a persistent local cache first. Only missing text is sent to Google over HTTPS, without website cookies, credentials, URLs, form values or file contents. Successfully translated text is saved to `%APPDATA%\JLCBrowser\translations.json` (or the project directory in development) and reused after restarting, including offline. The cache is plain JSON containing source/translated text and should be treated as private. It retains up to 10,000 entries / approximately 16 MiB, evicting the oldest entries if needed. The build excludes this cache.

Offline mode can translate previously cached labels, not unseen text. If Google is unreachable or rejects a request, cached text remains usable and the toolbar reports a partial/unavailable translation. Toggle off and on to retry. The implementation uses Google's public web translation endpoint, which is not the authenticated Google Cloud Translation API and may change or be rate-limited; no availability guarantee or API key is provided.

Translation covers ordinary visible text, placeholders/tooltips and accessible frames on the same origin. It skips editable text, input values, native select options, code blocks, `translate="no"` / `.notranslate` regions, images, canvas, closed shadow roots and cross-origin frames. Live form controls and page handlers are preserved. Original text that the site has changed independently is not overwritten when restoring.

## Smaller uploads

Choose **Upload → Create smaller 3MF copy (millimeters)…** and select a binary STL of up to 50 MiB. Save to a new `.3mf` filename, then select that copy in JLC's uploader. Conversion runs in a worker so the browser remains responsive. No file is uploaded automatically.

The converter stores the same ordered triangles, vertex coordinates and winding in a Deflate-compressed 3MF package. It does not simplify, scale, rotate or repair the mesh. Units are explicitly millimeters, matching the intended JLC workflow. Facet attributes, colored STL, malformed records and non-finite coordinates are rejected. Existing destination files are never overwritten.

The prepared Top copies in `prepared-uploads/` are approximately 6.75 MB each, down from 24.6 MB (about 73% smaller). Both were independently opened with Python's ZIP/XML readers and compared against every original triangle coordinate, including exact float32 bits and winding. Triangle counts remain 492,222 for the 0.8 mm file and 492,006 for the 0.9 mm file. Both retain approximately 63.7133 × 63.7133 × 27.0747 mm extents.

JLC's uploader lists 3MF as supported, but both live tests of the prepared copies returned HTTP 200 with application code `500`, `success: false`, and `输入失败，请更新内容后重试` after approximately 36 seconds. The request send phase took approximately 35 seconds. The server did not give a specific reason, so this does not establish whether the package, model, or backend caused the rejection. The original server timeout has not been repaired by this client application.

Two ZIP copies of the original Top STLs are also in `prepared-uploads/`. Each is approximately 11.42 MB, about 54% smaller than its source. Each ZIP contains just the original STL; extracting it was verified to reproduce every original byte. JLC's upload code accepts ZIP archives. The next user test also returned the same application rejection, after 60.7 seconds (send phase approximately 59.8 seconds). Diagnostics intentionally omit filenames, so the selected format is inferred from the test sequence rather than recorded directly.

`prepared-uploads/diagnostic-cube-10mm.stl` is a 684-byte binary STL control model, not a replacement for the user's part. Its 12 triangles, exact 10 mm coordinates, opposing paired edges and positive 1,000 mm³ signed volume were checked locally. A user upload can help distinguish a general upload/session/backend rejection from a model-dependent failure; it has not yet been tested on JLC.

## Diagnostics

Each run writes a JSONL file in `diagnostics/`. It records endpoint paths, HTTP statuses, durations, Chromium timing fields and transport failures. WebSocket events include handshake status, errors, frame direction, opcode and length, without frame contents.

For the two JLC upload endpoints, `upload-receipt` records only JSON `code`, `success` and `message` fields. A response with HTTP 200 can contain an application-level rejection. Whole response bodies, request bodies, headers, signed storage URLs and query strings are excluded. Paths and error messages can still identify documents; treat logs as private. Diagnostics attach before the initial navigation; a popup may begin loading before capture is ready. Opening DevTools detaches the capture; restart to resume it.

## Verify

```powershell
npm.cmd test
npm.cmd run test:browser
npm.cmd run test:tabs
npm.cmd run test:translation
npm.cmd run test:dns
```

Unit checks cover the converter's exact triangle-coordinate round trip, malformed and colored inputs, worker conversion, overwrite protection, and diagnostic privacy boundaries. The browser integration test uses a local server to simulate HTTP 594, a canceled request and WebSocket frames; it uploads nothing to JLC.

The tab integration test uses a local server to verify real popup links, POST body preservation, shared cookies, opener messaging, script-closing popups, switching, closing, navigation, toolbar IPC isolation, resize, per-tab diagnostics and cleanup. It does not submit real JLC orders or uploads.

Translation tests cover persistent cache reuse with the network unavailable, batching/alignment, invalid inputs, cancellation, corrupt-cache preservation, exact DOM restoration, dynamic text, same-origin frames, private form values, selected files, page handlers, pending requests, isolated script execution and late responses after toggling off. Automated integration fixtures use a fake provider and submit no private data to Google.

The separate DNS test makes fresh public hostname lookups for JLC's login and upload hosts through the configured encrypted resolver. It requires network access.

`test/verify-copy.py SOURCE.stl COPY.3mf` independently checks ZIP integrity, package relationships, units, every ordered triangle and coordinate, counts, dimensions and geometry hashes, using only Python's standard library.

## Captured failures — 22 October 2026

- The standard HTTP/2 upload returned HTTP 594 after 952.5 seconds. Its analysis WebSocket remained responsive.
- HTTP/1.1 also returned 594, after 487.2 seconds, with JSON message `请求处理超时` (request processing timed out). Connection readiness was reported around 188.9 seconds and the send phase ended around 487.2 seconds; this does not prove the entire file was transmitted.
- Forcing JLC's large-file storage route for the smaller file was rejected during upload-URL setup. That override was removed. The HTTP/1.1 experiment was also removed from the normal run.
- The two inspected Top STLs are already binary, so converting ASCII STL to binary would not help them. The 3MF copies reduce their encoded size while preserving geometry.
- A subsequent user-selected different STL succeeded in the same session: HTTP 200 with application code `200` and `success: true`, after 50.1 seconds. The source filename and size were not recorded, so this is not a controlled before/after speed comparison.
- Local inspection of both failing Top STLs found finite coordinates, no zero-area or duplicate triangles, no boundary or over-shared edges, and consistent winding across two-face edges. This does not establish corruption; self-intersections and vertex manifoldness were not checked. Details are in `diagnostics/mesh-inspection.json`.
