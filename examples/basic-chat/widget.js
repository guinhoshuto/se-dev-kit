(() => {
  "use strict";

  const elements = {
    card: document.querySelector("#chat-widget"),
    cardTitle: document.querySelector("#card-title"),
    channelName: document.querySelector("#channel-name"),
    channelInitials: document.querySelector("#channel-initials"),
    footerLabel: document.querySelector("#footer-label"),
    messageCount: document.querySelector("#message-count"),
    messageList: document.querySelector("#message-list")
  };

  const defaults = {
    cardTitle: "Studio Chat",
    footerLabel: "Synthetic preview data",
    accentColor: "#72f1b8",
    panelColor: "#0d1222",
    panelOpacity: 94,
    textColor: "#f6f8ff",
    mutedColor: "#9ba7bf",
    viewerBubbleColor: "#273044",
    creatorBubbleColor: "#7357ff",
    bubbleStyle: "tail",
    density: "comfortable",
    fontSize: 15,
    showTimestamps: true,
    maxMessages: 7,
    welcomeText: "Preview connected. Send a synthetic event to begin."
  };

  let fieldData = {...defaults};
  let messageTotal = 0;

  function clamp(value, min, max) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : min;
  }

  function hexToRgba(hex, alpha) {
    const normalized = String(hex).trim().replace(/^#/, "");
    const expanded = normalized.length === 3
      ? normalized.split("").map((part) => part + part).join("")
      : normalized;
    if (!/^[0-9a-f]{6}$/i.test(expanded)) return `rgba(13, 18, 34, ${alpha})`;
    const value = Number.parseInt(expanded, 16);
    const red = (value >> 16) & 255;
    const green = (value >> 8) & 255;
    const blue = value & 255;
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }

  function initials(value) {
    const parts = String(value || "streamer")
      .replace(/^@/, "")
      .split(/[^a-z0-9]+/i)
      .filter(Boolean);
    return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : parts[0]?.slice(0, 2) || "ST").toUpperCase();
  }

  function updateCount() {
    const visible = elements.messageList.querySelectorAll(".chat-message").length;
    elements.messageCount.textContent = `${visible} ${visible === 1 ? "message" : "messages"}`;
  }

  function applyFields(nextFields) {
    fieldData = {...fieldData, ...(nextFields || {})};
    const panelOpacity = clamp(fieldData.panelOpacity, 0, 100) / 100;
    elements.card.style.setProperty("--accent", String(fieldData.accentColor));
    elements.card.style.setProperty("--accent-soft", hexToRgba(fieldData.accentColor, 0.22));
    elements.card.style.setProperty("--panel", hexToRgba(fieldData.panelColor, panelOpacity));
    elements.card.style.setProperty("--text", String(fieldData.textColor));
    elements.card.style.setProperty("--muted", String(fieldData.mutedColor));
    elements.card.style.setProperty("--viewer-bubble", String(fieldData.viewerBubbleColor));
    elements.card.style.setProperty("--creator-bubble", String(fieldData.creatorBubbleColor));
    elements.card.style.setProperty("--font-size", `${clamp(fieldData.fontSize, 11, 24)}px`);
    elements.card.dataset.bubbleStyle = String(fieldData.bubbleStyle);
    elements.card.dataset.density = String(fieldData.density);
    elements.cardTitle.textContent = String(fieldData.cardTitle);
    elements.footerLabel.textContent = String(fieldData.footerLabel);
    elements.card.querySelectorAll(".message-time").forEach((node) => {
      node.hidden = !fieldData.showTimestamps;
    });

    const maxMessages = Math.round(clamp(fieldData.maxMessages, 1, 20));
    while (elements.messageList.children.length > maxMessages) {
      elements.messageList.firstElementChild?.remove();
    }
    updateCount();
  }

  function normalizedRole(payload) {
    const role = String(payload.role || "viewer").toLowerCase();
    if (["creator", "moderator", "subscriber"].includes(role)) return role;
    return "viewer";
  }

  function createMessage(payload) {
    const displayName = String(payload.displayName || payload.nick || "Viewer");
    const text = String(payload.text || payload.message || "");
    if (!text) return;

    const role = normalizedRole(payload);
    const article = document.createElement("article");
    article.className = "chat-message";
    article.dataset.role = role;
    article.dataset.messageId = String(payload.messageId || payload.msgId || `message-${++messageTotal}`);

    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = initials(displayName);

    const column = document.createElement("div");
    column.className = "message-column";

    const meta = document.createElement("div");
    meta.className = "message-meta";

    const name = document.createElement("span");
    name.className = "message-name";
    name.textContent = displayName;
    meta.append(name);

    if (role !== "viewer") {
      const badge = document.createElement("span");
      badge.className = "role-badge";
      badge.textContent = role;
      meta.append(badge);
    }

    const time = document.createElement("time");
    time.className = "message-time";
    time.hidden = !fieldData.showTimestamps;
    time.textContent = String(payload.timestamp || "now");
    meta.append(time);

    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    bubble.textContent = text;

    column.append(meta, bubble);
    article.append(avatar, column);
    elements.messageList.append(article);

    const maxMessages = Math.round(clamp(fieldData.maxMessages, 1, 20));
    while (elements.messageList.children.length > maxMessages) {
      elements.messageList.firstElementChild?.remove();
    }
    updateCount();
  }

  function handleEvent(listener, event) {
    const payload = event && typeof event === "object" && event.data && typeof event.data === "object"
      ? event.data
      : event || {};

    if (listener === "message") {
      createMessage(payload);
      return;
    }

    if (listener === "delete-message") {
      const messageId = String(payload.messageId || payload.msgId || "");
      if (messageId) {
        const target = Array.from(elements.messageList.querySelectorAll(".chat-message"))
          .find((node) => node.dataset.messageId === messageId);
        target?.remove();
        updateCount();
      }
      return;
    }

    if (listener === "delete-messages") {
      elements.messageList.replaceChildren();
      updateCount();
    }
  }

  window.addEventListener("onWidgetLoad", (event) => {
    const detail = event.detail || {};
    fieldData = {...defaults};
    elements.messageList.replaceChildren();
    messageTotal = 0;
    applyFields(detail.fieldData);

    const username = String(detail.channel?.username || "streamer").replace(/^@/, "");
    elements.channelName.textContent = `@${username}`;
    elements.channelInitials.textContent = initials(username);

    if (fieldData.welcomeText) {
      createMessage({
        displayName: "Widget Studio",
        text: fieldData.welcomeText,
        role: "moderator",
        messageId: "studio-welcome",
        timestamp: "ready"
      });
    }
    elements.card.dataset.loaded = "true";
  });

  window.addEventListener("onWidgetUpdate", (event) => {
    applyFields(event.detail?.fieldData || event.detail || {});
  });

  window.addEventListener("onEventReceived", (event) => {
    handleEvent(event.detail?.listener, event.detail?.event);
  });
})();
