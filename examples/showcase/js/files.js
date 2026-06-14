/* Files — upload, list (with thumbnails), delete. */
import { $, cd, escapeHtml, fmtBytes, guard, onAct } from "./lib.js";

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;

function row(f) {
  const li = document.createElement("li");
  const isImg = f.mime?.startsWith("image/") || IMAGE_RE.test(f.name);
  const thumb = isImg
    ? `<img class="thumb" src="${escapeHtml(cd().files.url(f.id))}" alt="" loading="lazy" />`
    : `<span class="thumb">⎙</span>`;
  li.innerHTML = `
    ${thumb}
    <span class="meta">
      <span class="name">${escapeHtml(f.name)}</span>
      <span class="sub">${fmtBytes(f.size)}${f.mime ? ` · ${escapeHtml(f.mime)}` : ""}</span>
    </span>
    <button class="ghost" data-act="file-open">Open</button>
    <button class="ghost" data-act="file-del">Delete</button>`;
  li.dataset.id = f.id;
  li.dataset.url = cd().files.url(f.id);
  return li;
}

async function refresh() {
  const list = $("#file-list");
  const files = await guard(() => cd().files.list(), $("#files-state"));
  if (!files) return; // disabled/limited — state card already shown
  list.innerHTML = "";
  if (!files.length) {
    list.innerHTML = `<li><span class="meta"><span class="sub">No files yet — upload one above.</span></span></li>`;
    return;
  }
  for (const f of files) list.appendChild(row(f));
}

export function mount() {
  const sec = $("#sec-files");

  onAct(sec, {
    "file-upload": async (btn) => {
      const input = $("#file-input");
      const file = input.files?.[0];
      if (!file) {
        $("#files-state").innerHTML =
          `<div class="state off"><span class="ico">○</span><span>Choose a file first.</span></div>`;
        return;
      }
      btn.disabled = true;
      const old = btn.textContent;
      btn.textContent = "Uploading…";
      await guard(() => cd().files.upload(file), $("#files-state"));
      btn.disabled = false;
      btn.textContent = old;
      input.value = "";
      await refresh();
    },
    "file-refresh": () => refresh(),
    "file-del": async (btn) => {
      const li = btn.closest("li");
      await guard(() => cd().files.delete(li.dataset.id), $("#files-state"));
      await refresh();
    },
    "file-open": (btn) => {
      const li = btn.closest("li");
      window.open(li.dataset.url, "_blank", "noopener");
    },
  });

  refresh();
}
