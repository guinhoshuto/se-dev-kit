# Editor replica fonts

The tutorial's StreamElements editor replica draws its UI in Nunito Sans and its Twitch chat in Inter. Both ship here, under the SIL Open Font License 1.1, so every machine and every Sandbox renders the same glyphs; nothing is downloaded at runtime. The control server serves the `.woff2` files at `/__sws/ui/fonts/`, and the tutorial setup loads every face before it measures anything.

| File | Source | SHA-256 |
| --- | --- | --- |
| `nunito-sans-latin-wght-normal.woff2` | `@fontsource-variable/nunito-sans` 5.3.0, `files/` | `29e3890496844a9ea81975c52771c587c872b4eb317026422d1995b88d21b57d` |
| `nunito-sans-latin-ext-wght-normal.woff2` | `@fontsource-variable/nunito-sans` 5.3.0, `files/` | `c648ee5bfda70d44b9fb628f4114d1cc4f984d050cbb4881052237ede3638a2e` |
| `inter-latin-wght-normal.woff2` | `@fontsource-variable/inter` 5.3.0, `files/` | `3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62` |
| `inter-latin-ext-wght-normal.woff2` | `@fontsource-variable/inter` 5.3.0, `files/` | `34b9c504cab7a73e37b746343a449132e56cf7b5481af2cb81dc74dcff25c956` |

Licenses: `NunitoSans-OFL.txt` and `Inter-OFL.txt`, copied from each package's `LICENSE`. The family names (`Nunito Sans Variable`, `Inter Variable`) and `unicode-range` values follow the packages' `index.css`. Text outside Latin and Latin Extended falls back to the system font.
