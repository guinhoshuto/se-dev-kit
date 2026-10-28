# Widget frame vendor scripts

StreamElements loads jQuery in every custom widget's `<head>`, before its init script and before the widget's HTML and JS: `<script src="https://cdn.streamelements.com/scripts/jquery_3.3.1.min.js"></script>` (its overlay bundle's custom widget frame, `https://streamelements.com/overlay/assets/index-BN_cOSxV.js`, read 2026-10-28). The widget frame runtime loads the same file from here before any widget script, so a widget that uses `$` without shipping jQuery runs as it does on StreamElements; nothing is downloaded at runtime. The local frame server serves it at `/__sws/runtime/vendor/`, hosted previews at `/engine/runtime/vendor/`.

| File | Source | SHA-256 |
| --- | --- | --- |
| `jquery-3.3.1.min.js` | `jquery` 3.3.1 on npm, `dist/jquery.min.js`, byte-identical to StreamElements' CDN file | `160a426ff2894252cd7cebbdd6d6b7da8fcd319c65b70468f10b6690c45d02ef` |

License: `jquery-LICENSE.txt` (MIT), copied from the package's `LICENSE.txt` (SHA-256 `2b3ed8ba424423a50b023e728530d94bc385cfc7c328ad65a3dfee9c7c0531c5`). Neither this file nor the license is served.
