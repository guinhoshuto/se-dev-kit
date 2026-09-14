import {defineConfig} from "se-widget-studio";

export default defineConfig({
  schemaVersion: 1,
  widget: {
    root: ".",
    files: {
      html: "widget.html",
      css: "widget.css",
      js: "widget.js",
      fields: "widget.json"
    },
    assets: [],
    viewport: {
      width: 430,
      height: 640,
      deviceScaleFactor: 1
    },
    ready: {
      selector: "#chat-widget[data-loaded=\"true\"]",
      timeoutMs: 10000
    }
  },
  channel: {
    username: "studio_channel"
  },
  themes: {
    glob: "themes/*.json"
  },
  fixtures: {
    glob: "fixtures/*.json"
  },
  scenes: {
    glob: "scenes/*.json"
  },
  scenarios: {
    glob: "scenarios/*.json"
  },
  recipes: {
    glob: "recipes/*.json"
  },
  output: {
    root: ".se-widget-studio/output"
  }
});
