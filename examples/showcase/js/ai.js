/* AI — streamed chat over canvasdrop.ai.stream(). Keeps a short message history. */
import { $, cd, clearState, onAct, showState } from "./lib.js";

/** role -> [{role, content}] conversation, sent to the model each turn. */
const history = [];

function bubble(who, text = "") {
  const el = document.createElement("div");
  el.className = `bubble ${who}`;
  el.innerHTML = `<span class="who">${who === "user" ? "you" : "assistant"}</span><span class="body"></span>`;
  el.querySelector(".body").textContent = text;
  $("#ai-log").appendChild(el);
  $("#ai-log").scrollTop = $("#ai-log").scrollHeight;
  return el.querySelector(".body");
}

async function send() {
  const input = $("#ai-input");
  const prompt = input.value.trim();
  if (!prompt) return;
  const model = $("#ai-model").value;
  const sendBtn = $('[data-act="ai-send"]');

  clearState($("#ai-state"));
  $("#ai-usage").textContent = "";
  input.value = "";
  bubble("user", prompt);
  history.push({ role: "user", content: prompt });

  const body = bubble("assistant");
  body.parentElement.classList.add("cursor");
  sendBtn.disabled = true;

  let full = "";
  try {
    // Stream deltas as they arrive — the whole point of the AI primitive.
    for await (const delta of cd().ai.stream(history, { model, maxTokens: 512 })) {
      full += delta;
      body.textContent = full;
      $("#ai-log").scrollTop = $("#ai-log").scrollHeight;
    }
    history.push({ role: "assistant", content: full });
    // A second, non-streamed call would re-bill; instead surface that streaming
    // worked. (chat() returns usage+cost if you need exact metering.)
    $("#ai-usage").textContent = `streamed ${full.length} chars · model ${model}`;
  } catch (err) {
    if (err && typeof err.code === "string") {
      showState($("#ai-state"), err);
      body.parentElement.remove();
      history.pop(); // drop the unanswered user turn so retries stay clean
    } else {
      throw err;
    }
  } finally {
    body.parentElement.classList.remove("cursor");
    sendBtn.disabled = false;
  }
}

export function mount() {
  onAct($("#sec-ai"), {
    "ai-send": () => send(),
    "ai-clear": () => {
      history.length = 0;
      $("#ai-log").innerHTML = "";
      $("#ai-usage").textContent = "";
      clearState($("#ai-state"));
    },
  });
  $("#ai-input").addEventListener("keydown", (e) => {
    // Enter sends; Shift+Enter newlines.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
}
