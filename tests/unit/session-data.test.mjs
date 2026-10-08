import assert from "node:assert/strict";
import test from "node:test";

import {defaultSessionData, SESSION_RECENT_LIMIT, SessionTracker} from "../../dist/runtime/frame.js";

const AT = "2025-01-15T12:00:00.000Z";

test("the default session data has every Twitch and common key of the Session Data Reference, empty", () => {
  const data = defaultSessionData();
  // https://docs.streamelements.com/overlays/session-data, read 2026-10-07.
  const documented = [
    "follower-latest", "follower-session", "follower-week", "follower-month", "follower-total", "follower-goal", "follower-recent",
    "subscriber-latest", "subscriber-new-latest", "subscriber-resub-latest", "subscriber-new-session", "subscriber-resub-session",
    "subscriber-session", "subscriber-week", "subscriber-month", "subscriber-total", "subscriber-goal",
    "subscriber-gifted-latest", "subscriber-alltime-gifter", "subscriber-gifted-session", "subscriber-points", "subscriber-recent",
    "host-latest", "host-recent", "raid-latest", "raid-recent",
    "cheer-latest", "cheer-session", "cheer-week", "cheer-month", "cheer-total", "cheer-count", "cheer-goal", "cheer-recent",
    "tip-latest", "tip-session", "tip-week", "tip-month", "tip-total", "tip-count", "tip-goal", "tip-recent",
    "merch-latest", "merch-goal-items", "merch-goal-orders", "merch-goal-total", "merch-recent",
    ...["tip", "cheer"].flatMap((kind) => ["session", "weekly", "monthly", "alltime"].flatMap((period) => [`${kind}-${period}-top-donation`, `${kind}-${period}-top-donator`]))
  ];
  assert.deepEqual(Object.keys(data).sort(), [...documented].sort());
  assert.deepEqual(data["follower-session"], {count: 0});
  assert.deepEqual(data["tip-week"], {amount: 0});
  assert.deepEqual(data["tip-latest"], {name: "", amount: 0, message: ""});
  assert.deepEqual(data["follower-recent"], []);
  // A fixture's key replaces only the fields it names.
  assert.deepEqual(new SessionTracker({"tip-latest": {name: "Zed"}}).data["tip-latest"], {name: "Zed", amount: 0, message: ""});
});

test("a follower, a sub, a resub, and a gifted sub count in every period and the goal; the newest recent entry comes first", () => {
  const tracker = new SessionTracker({"follower-total": {count: 100}, "follower-goal": {amount: 7}});
  assert.equal(tracker.apply("follower-latest", {name: "Ana"}, AT), true);
  assert.deepEqual(tracker.data["follower-latest"], {name: "Ana"});
  for (const period of ["session", "week", "month"]) assert.deepEqual(tracker.data[`follower-${period}`], {count: 1});
  assert.deepEqual(tracker.data["follower-total"], {count: 101}, "the fixture's total goes on");
  assert.deepEqual(tracker.data["follower-goal"], {amount: 8});
  assert.deepEqual(tracker.data["follower-recent"], [{name: "Ana", createdAt: AT, type: "follower"}]);

  tracker.apply("subscriber-latest", {name: "Bo", amount: 1, tier: "1000", message: "first"}, AT);
  tracker.apply("subscriber-latest", {name: "Cy", amount: 6, tier: "2000", message: "six"}, AT);
  tracker.apply("subscriber-latest", {name: "Di", amount: 1, tier: "1000", gifted: true, sender: "Ed", message: ""}, AT);
  assert.deepEqual(tracker.data["subscriber-latest"], {name: "Di", amount: 1, tier: "1000", message: "", sender: "Ed", gifted: true});
  assert.deepEqual(tracker.data["subscriber-session"], {count: 3});
  assert.deepEqual(tracker.data["subscriber-goal"], {amount: 3});
  assert.deepEqual(tracker.data["subscriber-new-session"], {count: 2});
  assert.deepEqual(tracker.data["subscriber-resub-session"], {count: 1});
  assert.deepEqual(tracker.data["subscriber-resub-latest"], {name: "Cy", amount: 6, message: "six"});
  assert.deepEqual(tracker.data["subscriber-gifted-latest"], {name: "Ed", amount: 1});
  assert.deepEqual(tracker.data["subscriber-gifted-session"], {count: 1});
  assert.deepEqual(tracker.data["subscriber-recent"].map((item) => item.name), ["Di", "Cy", "Bo"]);
  // A community gift names the gifter; the gifts themselves arrive as their own events.
  tracker.apply("subscriber-latest", {name: "Ed", amount: 5, tier: "1000", bulkGifted: true, sender: "Ed", message: ""}, AT);
  assert.deepEqual(tracker.data["subscriber-gifted-latest"], {name: "Ed", amount: 5});
  assert.deepEqual(tracker.data["subscriber-session"], {count: 3});
});

test("tips and cheers keep totals, count, goal, the biggest single one, and the biggest sum per name, seeded from the fixture", () => {
  const tracker = new SessionTracker({"cheer-alltime-top-donator": {name: "Old", amount: 5000}, "cheer-total": {amount: 9000}});
  tracker.apply("cheer-latest", {name: "Ana", amount: 3000, message: "a"}, AT);
  tracker.apply("cheer-latest", {name: "Bo", amount: 4000, message: "b"}, AT);
  tracker.apply("cheer-latest", {name: "Ana", amount: 1500, message: "c"}, AT);
  assert.deepEqual(tracker.data["cheer-latest"], {name: "Ana", amount: 1500, message: "c"});
  assert.deepEqual(tracker.data["cheer-session"], {amount: 8500});
  assert.deepEqual(tracker.data["cheer-total"], {amount: 17500});
  assert.deepEqual(tracker.data["cheer-count"], {count: 3});
  assert.deepEqual(tracker.data["cheer-goal"], {amount: 8500});
  assert.deepEqual(tracker.data["cheer-session-top-donation"], {name: "Bo", amount: 4000});
  assert.deepEqual(tracker.data["cheer-session-top-donator"], {name: "Ana", amount: 4500});
  assert.deepEqual(tracker.data["cheer-alltime-top-donator"], {name: "Old", amount: 5000}, "Ana's 4500 does not pass the seeded 5000");
  tracker.apply("cheer-latest", {name: "Ana", amount: 600, message: ""}, AT);
  assert.deepEqual(tracker.data["cheer-alltime-top-donator"], {name: "Ana", amount: 5100});
  assert.deepEqual(tracker.data["tip-session"], {amount: 0}, "cheers leave tips alone");
  tracker.apply("tip-latest", {name: "Cy", amount: "12.5", message: "m"}, AT);
  assert.deepEqual(tracker.data["tip-month"], {amount: 12.5}, "a numeric string amount counts");
  // The fixture's donator keeps their sum: a small tip from them adds to it.
  const seeded = new SessionTracker({"tip-session-top-donator": {name: "Ana", amount: 20}});
  seeded.apply("tip-latest", {name: "Ana", amount: 1, message: ""}, AT);
  assert.deepEqual(seeded.data["tip-session-top-donator"], {name: "Ana", amount: 21});
});

test("raids, hosts, and merch update their keys; other listeners change nothing; recent lists keep the newest entries", () => {
  const tracker = new SessionTracker();
  tracker.apply("raid-latest", {name: "Ana", amount: 40}, AT);
  tracker.apply("host-latest", {name: "Bo", amount: 3}, AT);
  assert.deepEqual(tracker.data["raid-latest"], {name: "Ana", amount: 40});
  assert.deepEqual(tracker.data["host-recent"], [{name: "Bo", amount: 3, createdAt: AT, type: "host"}]);
  tracker.apply("merch-latest", {name: "Cy", amount: 70, items: [{name: "Hoodie", quantity: 2}, {name: "Cap", quantity: 1}]}, AT);
  assert.deepEqual(tracker.data["merch-goal-orders"], {amount: 1});
  assert.deepEqual(tracker.data["merch-goal-items"], {amount: 3});
  assert.deepEqual(tracker.data["merch-goal-total"], {amount: 70});

  const snapshot = structuredClone(tracker.data);
  for (const listener of ["message", "redemption-latest", "event:test", "delete-message"]) assert.equal(tracker.apply(listener, {name: "Di", amount: 1}, AT), false, listener);
  assert.deepEqual(tracker.data, snapshot);

  for (let index = 0; index < SESSION_RECENT_LIMIT + 5; index += 1) tracker.apply("follower-latest", {name: `f${index}`}, AT);
  assert.equal(tracker.data["follower-recent"].length, SESSION_RECENT_LIMIT);
  assert.equal(SESSION_RECENT_LIMIT, 25);
  assert.equal(tracker.data["follower-recent"][0].name, `f${SESSION_RECENT_LIMIT + 4}`);
});
