# Update a sold widget's overlay

The overlay behind a sold widget's StreamElements link, the product's overlay that buyers import, moves to a new commit in the real StreamElements overlay editor (`https://streamelements.com/overlay/<id>/editor`), through a browser tool's page-script runner (`javascript_tool` in Claude in Chrome). Never on the Studio's private editor: the page scripts refuse any page that is not a StreamElements overlay editor, and the `open-editor` rule in SKILL.md stands. Three versioned files in `scripts/` do the work; read each one and paste it as it is, never retyped:

| File | Runs | Does |
|---|---|---|
| `se-editor-plan.mjs` | Node, on the widget repository | the plan: each code tab's SHA-256 at both commits, the new FIELDS labels, and the new files for the upload |
| `se-editor-read.js` | in the editor tab, before the approval and after the reload | reads only: the layer names, each canvas widget's JS and CSS against the plan, the labels in the field panel |
| `se-editor-update.js` | in the editor tab, after the approval | for each layer: opens its code editor and the HTML, CSS, JS, and Fields tabs, writes, clicks Done |

Paste a page script by passing the file's text as the call's code, with the calls after it in the same text; what it defines lasts until the tab reloads. Every call evaluates to a JSON string. The scripts read no input's value (one of them is the overlay's link for OBS, with its key), never click Save, and never open the Data tab.

## Before the approval

1. Plan, on the widget repository, from the commit the overlay has (the product note or the previous update says which) to the new one, into a new folder of the session's scratchpad (the browser tool's file upload reads only what the session can read):

   ```sh
   node <skill>/scripts/se-editor-plan.mjs --repo <widget repository> --from <old commit> --to <new commit> --out <scratchpad>/se-update-<new commit>
   ```

   It reads the two commits, never the working tree, and prints the plan JSON, which goes to the page twice.

   Then look for a `{{field}}` placeholder in the CSS and JS of both commits: `git -C <widget repository> grep -n '{{' <old commit> <new commit> -- <css file> <js file>`. After Done, StreamElements fills each placeholder with the field's value in the canvas, so the canvas check cannot confirm that widget, and `run()` stops after its Done with nothing saved ([#9](https://github.com/guinhoshuto/se-dev-kit/issues/9)). When the command finds any, stop before opening the editor and tell the owner. The editor also fills a single-brace `{field}` inside a JS template literal, `${field}`, when `field` is a FIELDS key: se-dreamychat's `color: ${fontColor};` showed in the canvas as `color: $rgb(242, 242, 242);`, so its JS read `OTHER` before and after a correct update (2026-10-27). Look for it too (`git grep -nE '\$\{(<field>|<field>)\}'` with the FIELDS keys); there, the code editor's tabs still hash as the commit, so the update itself works, and the saved JS is confirmed in the canvas by putting that line back and comparing the whole text's SHA-256 with the plan.
2. Open the overlay's editor link (the note's `se_link`) in one tab, in front: timers stall in a background tab, so the writing script refuses to run there.
3. Paste `se-editor-read.js`, then `seEditor.use(<plan>)`, `seEditor.layers()`, and `await seEditor.canvas()`. For each widget in the canvas, `canvas()` says whether its JS and CSS are the old commit's (`OLD`), the new one's (`NEW`), or neither (`OTHER`). `OTHER` where `OLD` was expected means the overlay is not on `--from`: plan from the commit it has, or ask. Nothing has been clicked or changed yet.

## One approval for every widget

Ask once, in one AskUserQuestion box: name the product note the link comes from, every layer that changes, the two commits, and the tabs that change, and say that DATA stays as it is and that one Save follows. Ask the owner, in the same box, to reload any tab of theirs open on this overlay: a tab opened before the Save keeps the old code, and a Save there undoes this one. Nothing in the editor changes before the answer.

## Write every widget

4. Paste `se-editor-update.js`, then `seEditor.attach()`, which adds a file input labelled `se-editor-update files`. Find it by that label and upload every path in the plan's `upload` with the browser tool's file upload. `await seEditor.files()` checks each file against the plan.
5. `await seEditor.run([<every layer the approval named>])`. For each layer in turn it selects it, opens its code editor, opens the HTML, CSS, JS, and Fields tabs (a tab's code exists only once the tab has opened), and compares each tab's SHA-256 with the plan, FIELDS as parsed JSON because StreamElements reformats them when it saves. A tab with neither commit's code stops the run, with nothing written to that widget and its code editor left open. Otherwise it writes each tab that has the old code, checks the hash after writing (any other result puts back every tab it wrote and stops), clicks Done, and waits until one more widget in the canvas shows the new JS or CSS.
   - `ok: true` with `left: 0` means every widget in the canvas has the new JS and CSS. A `left` above 0 is a widget still on the old commit: a layer not named, or one the editor did not open. Find it before the Save.
   - When `run` cannot select or open a layer (no Open Editor button, a name that two layers share), open that layer's code editor by ref (`find`, then a click on the ref, never by coordinates), then `await seEditor.apply()` and `await seEditor.done()`. `await seEditor.scan()` reads the tabs without writing.
   - With more than about eight widgets, split the names across several `run` calls, so that no call nears the tool's time limit.

## Check the labels before the Save

6. When FIELDS changed, run `seEditor.labels()` with a widget selected (after `run`, the last one is). Each label that the plan lists as new or reworded reads `whole`, or `cut` when it is wider than its box or runs past the panel's edge, and `panel.overflow` is false. A label in a closed group reads `closed group, fits` or `closed group, too wide`, an estimate: open that group by its arrow, measure again, and close the group, since open groups are saved with the overlay. Report every `cut` label, every overflow, and any other visual anomaly before the Save; an update with an anomaly has not passed.

## Save once, then reload the same tab

7. Say what is about to be saved, then click Save once (by ref). The Save went through when the overlay's PUT answers 200 in the network log, or when "Saved!" shows.
8. Check in the same tab: navigate it to the editor URL again, never with `force`. A navigation the page holds back means it still has unsaved changes: stop and report. After the reload, paste `se-editor-read.js` again, then `seEditor.use(<plan>)` and `await seEditor.canvas()`: `ok: true`, with every widget `NEW`, confirms the saved JS and CSS. HTML and FIELDS were checked by their hash before Done; after a FIELDS change, run `seEditor.labels()` again.

## Close the tab

9. Close each editor tab this update opened, one at a time, and list the tabs after each close: closing an editor tab through the extension has timed out and taken its tab group along. No editor tab stays open.

## Report

Name the product note and the overlay's editor link (never the OBS link, which carries the key), each widget with what happened to each tab (`written` or `already new`), the two commits, the Save's answer, and the result of the check after the reload. Report it as a real StreamElements change, separate from any Studio simulation.
