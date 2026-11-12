# Update a sold widget's overlay

The overlay behind a sold widget's StreamElements link, the product's overlay that buyers import, moves to a new commit in the real StreamElements overlay editor (`https://streamelements.com/overlay/<id>/editor`), through a browser tool's page-script runner (`javascript_tool` in Claude in Chrome). Never on the Studio's private editor: the page scripts refuse any page that is not a StreamElements overlay editor, and the `open-editor` rule in SKILL.md stands. Four versioned files in `scripts/` do the work, and none is ever retyped:

| File | Runs | Does |
|---|---|---|
| `se-editor-plan.mjs` | Node, on the widget repository | the plan: each code tab's SHA-256 at both commits, the template of each JS or CSS tab with `{{field}}` placeholders, the new FIELDS labels, and the new files for the upload |
| `se-editor-load.js` | in the editor tab, before a page script | the loader, the only one whose text goes in a call: it adds a file input, and `seEditorLoad()` runs the page scripts uploaded to it |
| `se-editor-read.js` | in the editor tab, before the approval and after the reload | reads only: the layer names, each canvas widget's JS and CSS against the plan, the labels in the field panel |
| `se-editor-update.js` | in the editor tab, after the approval | for each layer: opens its code editor and the HTML, CSS, JS, and Fields tabs, writes, clicks Done; and [one field's value](#write-one-fields-value), by its label |

Every call evaluates to a JSON string. The scripts read no input's value (one of them is the overlay's link for OBS, with its key), but for `readField` and `setField`, which read only a field's own input; they never click Save, and never open the Data tab.

## Load a page script

No call carries a page script's text: each is 12 to 20 KB, and seven pastes on three updates cost 99,438 characters on 2026-11-03. Three calls load them instead, and what they define lasts until the tab reloads:

1. Read `se-editor-load.js` (under 1,000 characters) and pass its text as the call's code. It answers `{ok: true, label}`, and on a page that is no overlay editor it adds nothing.
2. `find` the input labelled `se-editor-load files`, and upload `<skill>/scripts/se-editor-read.js`, `se-editor-update.js`, or both with the browser tool's file upload, in a call of its own: inside `browser_batch` it failed with "Couldn't determine which page this action targets". The upload took the path `~/.claude/skills/se-widget-studio/scripts/` on 2026-11-05 and refused it on 2026-11-12 ("only files this session is allowed to read"): copy the page scripts to the session's scratchpad first and upload the copies.
3. `await seEditorLoad()` runs each uploaded page script in the page, `se-editor-read.js` first, whichever order they came in, and answers as the last script does: `{ok: true, version, calls}`, or the first refusal. The input leaves once they have run. Any other file it ignores, and with no page script uploaded it answers `ok: false`.

The loader evaluates the files' text, which a Content Security Policy without `unsafe-eval` would forbid. The editor has none: on the test overlay on 2026-11-05 no header and no `meta` set one, and the loader defined both page scripts, also after a reload. If `seEditorLoad()` ever throws an `EvalError`, nothing was defined and the editor has gained a policy: say so in the report, and pass the file's text as the call's code instead.

The code editor's dialog was found redesigned on 2026-11-11 (the script had last written through the old one on 2026-11-03): the AngularJS Material `md-dialog.code-editor-dialog`, with `li.md-nav-item[name]` tabs and an `.exit-code-editor` Done button, became a React `[role="dialog"]` holding a Monaco editor, with `button[role="tab"]` tabs (HTML, CSS, JS, Fields, Data) and a `button` that reads "Done". When measured on 2026-11-11 it left the page once Done returned, but a closing dialog can still be in the page for a moment, so only one that is on screen counts as open. `se-editor-update.js` finds both: `dialog()` takes the old dialog, else a `[role="dialog"]` that holds a `.monaco-editor` and is on screen, and `tabButton` and `doneButton` do the same for the tabs and Done. If StreamElements redesigns it again, `run` answers "Open Editor did not open the code editor" and `scan` answers "No code editor is open" while the dialog is on the screen: read the new dialog's markup in the tab, change those three finders in `se-editor-update.js`, and prove it on the test overlay before any sold one.

## Before the approval

1. Plan, on the widget repository, from the commit the overlay has (the product note or the previous update says which) to the new one, into a new folder of the session's scratchpad (the browser tool's file upload reads only what the session can read):

   ```sh
   node <skill>/scripts/se-editor-plan.mjs --repo <widget repository> --from <old commit> --to <new commit> --out <scratchpad>/se-update-<new commit>
   ```

   It reads the two commits, never the working tree, and prints the plan JSON, which goes to the page twice.

   For a build in a subfolder of the repository (a customer's, like se-wheel's `ashlychalupnik/`), add `--dir <subfolder>`, its path from the repository root, and keep `--repo` on the repository's top folder: pointed at the subfolder, the plan refuses and names `--dir`. `--from` and `--to` are commits of the repository, and the plan refuses a commit without the widget in that subfolder.

   The canvas shows each widget's JS and CSS with every `{{field}}` placeholder filled with the field's value, and also every single-brace `{field}` whose `field` is a FIELDS key: se-dreamychat's `color: ${fontColor};`, in a JS template literal, showed in the canvas as `color: $rgb(242, 242, 242);` (2026-10-27). So for a JS or CSS tab whose code has either at a commit, the plan carries that commit's template, the literal pieces between the placeholders, and the canvas recognizes the commit by those pieces in order, whatever the values ([#9](https://github.com/guinhoshuto/se-dev-kit/issues/9)). `seEditor.use()` lists those tabs under `placeholders`.
2. Open the overlay's editor link (the note's `se_link`) in one tab, in front: timers stall in a background tab, so the writing script refuses to run there.
3. [Load](#load-a-page-script) `se-editor-read.js`, then `seEditor.use(<plan>)`, `seEditor.layers()`, and `await seEditor.canvas()`. For each widget in the canvas, `canvas()` says whether its JS and CSS are the old commit's (`OLD`), the new one's (`NEW`), or neither (`OTHER`). `OTHER` where `OLD` was expected means the overlay is not on `--from`: plan from the commit it has, or ask. `UNVERIFIABLE` is code that, once its placeholders are filled, fits both commits, because they differ only right next to a placeholder (`{{size}}` becoming `{{size}}px`): the canvas cannot tell them apart, and the hash check of the code editor's tabs before Done decides. Nothing has been clicked or changed yet.

## One approval for every widget

Ask once, in one AskUserQuestion box: name the product note the link comes from, every layer that changes, the two commits, and the tabs that change, and say that DATA stays as it is and that one Save follows. Ask the owner, in the same box, to reload any tab of theirs open on this overlay: a tab opened before the Save keeps the old code, and a Save there undoes this one. Nothing in the editor changes before the answer.

## Write every widget

4. [Load](#load-a-page-script) `se-editor-update.js`, then `seEditor.attach()`, which adds a file input labelled `se-editor-update files`. Find it by that label and upload every path in the plan's `upload` with the browser tool's file upload. `await seEditor.files()` checks each file against the plan.
5. `await seEditor.run([<every layer the approval named>])`. For each layer in turn it selects it, opens its code editor, opens the HTML, CSS, JS, and Fields tabs (a tab's code exists only once the tab has opened), and compares each tab's SHA-256 with the plan, FIELDS as parsed JSON because StreamElements reformats them when it saves. A tab with neither commit's code stops the run, with nothing written to that widget and its code editor left open. Otherwise it writes each tab that has the old code, checks the hash after writing (any other result puts back every tab it wrote and stops), clicks Done, and waits until one more widget in the canvas shows the new JS or CSS (or, for code that fits both commits, reads `UNVERIFIABLE`).
   - `ok: true` with `left: 0` means every widget in the canvas has the new JS and CSS. A `left` above 0 is a widget still on the old commit: a layer not named, or one the editor did not open. Find it before the Save.
   - The canvas proves only JS and CSS, so read the four tabs back for the first widget written (on 2026-11-11 this proved all four, on the test overlay of se-wheel's Ashley build, before the Save): `await seEditor.open(name)`, `await seEditor.scan()` (all four tabs `NEW`), then `await seEditor.done()`. Do it before the Save.
   - When `run` cannot select or open a layer (no Open Editor button, a name that two layers share), open that layer's code editor by ref (`find`, then a click on the ref, never by coordinates), then `await seEditor.apply()` and `await seEditor.done()`. `await seEditor.scan()` reads the tabs without writing.
   - With more than about eight widgets, split the names across several `run` calls, so that no call nears the tool's time limit.

## Check the labels before the Save

6. When FIELDS changed, run `seEditor.labels()` with a widget selected (after `run`, the last one is). Each label that the plan lists as new or reworded reads `whole`, or `cut` when it is wider than its box or runs past the panel's edge, and `panel.overflow` is false. A label in a closed group reads `closed group, fits` or `closed group, too wide`, an estimate: open that group by its arrow, measure again, and close the group, since open groups are saved with the overlay. Report every `cut` label, every overflow, and any other visual anomaly before the Save; an update with an anomaly has not passed.

## Save once, then reload the same tab

7. Say what is about to be saved, then click Save once (by ref). The Save went through when the overlay's PUT answers 200 in the network log, or when "Saved!" shows.
8. Check in the same tab: navigate it to the editor URL again, never with `force`. A navigation the page holds back means it still has unsaved changes: stop and report. After the reload, [load](#load-a-page-script) `se-editor-read.js` again, then `seEditor.use(<plan>)` and `await seEditor.canvas()`: `ok: true`, with every widget `NEW`, confirms the saved JS and CSS. A widget `UNVERIFIABLE` here is confirmed only by the hash check before Done, not by the canvas: say so in the report. HTML and FIELDS were checked by their hash before Done; after a FIELDS change, run `seEditor.labels()` again.

## Close the tab

9. Close each editor tab this update opened, one at a time, and list the tabs after each close: closing an editor tab through the extension has timed out and taken its tab group along. No editor tab stays open.

## Write one field's value

For example values in a customer build tested on an overlay, or any other value in a widget's fields, with no plan and no new commit. Use the test overlay, or the overlay the owner named: a product's overlay is touched only when the owner asks for it by name. Open its editor in one tab, in front, and [load](#load-a-page-script) `se-editor-read.js` and `se-editor-update.js` together, skipping `seEditor.use()`.

```js
await seEditor.readField('Mystery items', 'Custom widget 1')
await seEditor.setField('Mystery items', '$10[$5 FEE], $20', 'Custom widget 1')
```

- The third argument (the second for `readField`) is the layer's name, and may be left out only on an overlay with one layer. A layer not yet selected gets selected, and the call waits for the layer list to mark it: the list marks a layer last, after its fields show (43 to 69 ms after the click, measured on 2026-11-05), and until then it still names the previous layer.
- `setField` answers `{ok: true, layer, label, old, value}`, with `value` as the field shows it (`1,500` for 1500). Keep `old`: it is what the owner gets back if the example goes. A value the editor shows differently (a number above the field's `max`) answers `ok: false` with `shown`, and the old value put back; `restored: false` means it did not come back, and then nothing may be saved.
- The label is the field's whole label, as the panel shows it, or the call says no field has it and changes nothing. So does a field hidden now by a visibility condition in its FIELDS. Two fields with one label are refused.
- Only a field with one text or number input (text, textarea, number, slider, and any type the editor shows as a plain input) is read or written; a dropdown, a checkbox, a color, a font, or an asset is refused, as are a password, hidden, or read-only input. Set those by hand or in DATA.
- Each call looks only inside a custom widget's fields (`.widget-form custom-widget-fields-group`), never `.widget-form` alone: the panel with the overlay's link for OBS, with its key, has that class too. A value holding such a link answers as `/overlay/<id>/<key>`, and the field keeps what it holds.
- A group stays as it was: a closed group keeps its inputs in the page, and a group left open would be saved with the overlay. Settings need not be open either.

The value lives in the open tab until a Save: neither call clicks it. Saving needs the owner's request: say what is about to be saved (each label, old and new), then follow [Save once, then reload the same tab](#save-once-then-reload-the-same-tab), and confirm with `readField` after the reload, loading both scripts again. Without a Save, closing the tab drops the values. A tab that does not close through the extension still holds them, and a Save there would keep them: tell the owner to close it. Report it as a real StreamElements change, separate from any Studio simulation; the overlay's link and its key stay out of the report.

## Report

Name the product note and the overlay's editor link (never the OBS link, which carries the key), each widget with what happened to each tab (`written` or `already new`), the two commits, the Save's answer, and the result of the check after the reload. Report it as a real StreamElements change, separate from any Studio simulation.
