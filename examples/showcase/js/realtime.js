/* Realtime — one channel, ephemeral presence + pub/sub (chat) + a live poll. */
import { $, cd, escapeHtml, guard, logLine, onAct, showState } from "./lib.js";

const CHANNEL = "lobby";
const POLL_OPTS = ["kv", "files", "ai", "realtime"];
const votes = Object.fromEntries(POLL_OPTS.map((o) => [o, 0]));

let channel = null;

function renderPresence(users) {
  const host = $("#rt-presence");
  host.innerHTML = users.length
    ? users
        .map(
          (u) =>
            `<span class="pill"><span class="swatch"></span>${escapeHtml(u.name || u.id)}</span>`,
        )
        .join("")
    : `<span class="muted" style="font-size:13px">just you, for now</span>`;
}

function renderPoll() {
  const total = Object.values(votes).reduce((a, b) => a + b, 0) || 1;
  $("#rt-poll").innerHTML = POLL_OPTS.map((o) => {
    const pct = Math.round((votes[o] / total) * 100);
    return `<div class="row"><span>${o}</span><span class="bar"><span style="width:${pct}%"></span></span><span class="count">${votes[o]}</span></div>`;
  }).join("");
}

function onMessage(msg) {
  if (msg.event === "vote") {
    const opt = msg.data?.opt;
    if (opt in votes) {
      votes[opt] += 1;
      renderPoll();
    }
    return;
  }
  // chat
  const who = escapeHtml(msg.from?.name || "someone");
  const text = escapeHtml(String(msg.data?.text ?? ""));
  logLine($("#rt-log"), `<b>${who}:</b> ${text}`);
}

export function mount() {
  renderPoll();

  channel = cd().realtime.channel(CHANNEL);
  channel.onPresence(renderPresence);
  channel.onJoin((u) =>
    logLine($("#rt-log"), `<span class="key">→ ${escapeHtml(u.name || u.id)} joined</span>`),
  );
  channel.onLeave((u) =>
    logLine($("#rt-log"), `<span class="key">← ${escapeHtml(u.name || u.id)} left</span>`),
  );
  channel.subscribe(onMessage);

  // Detect a disabled/unauthorized realtime capability: presence() rejects with
  // the terminal error the socket closed on, so the state card explains it.
  guard(() => channel.presence(), $("#rt-state")).then((users) => {
    if (users) renderPresence(users);
  });

  onAct($("#sec-realtime"), {
    "rt-send": () => {
      const input = $("#rt-msg");
      const text = input.value.trim();
      if (!text) return;
      try {
        channel.publish("chat", { text });
        input.value = "";
      } catch (err) {
        if (err && typeof err.code === "string") showState($("#rt-state"), err);
        else throw err;
      }
    },
    "rt-vote": (btn) => {
      try {
        channel.publish("vote", { opt: btn.dataset.opt });
      } catch (err) {
        if (err && typeof err.code === "string") showState($("#rt-state"), err);
        else throw err;
      }
    },
  });

  $("#rt-msg").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $('[data-act="rt-send"]').click();
    }
  });
}
