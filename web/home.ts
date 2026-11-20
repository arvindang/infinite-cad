import { $, escapeHtml, forgetModel, prefs, rememberModel, toast, wireCopyButtons, type Recent } from "./shared";

($("#mcpUrl") as HTMLInputElement).value = `${location.origin}/mcp`;
wireCopyButtons();
if (!/Mac|iPhone|iPad/.test(navigator.platform)) document.querySelectorAll(".how kbd").forEach((k) => (k.textContent = "Ctrl+C"));

function renderRecent() {
  const recent = prefs.get<Recent[]>("recent", []);
  $("#recentHead").hidden = !recent.length;
  $("#recent").innerHTML = recent
    .map(
      (r) =>
        `<li><a href="/m/${r.id}"><span>${escapeHtml(r.name)}</span><time>${new Date(r.at).toLocaleDateString()}</time></a>` +
        `<button class="forget" data-id="${r.id}" title="Remove from this list (the model isn't deleted)" aria-label="Remove ${escapeHtml(r.name)} from recent">×</button></li>`,
    )
    .join("");
}
renderRecent();
// tidying the list never touches the model: delete a model from its viewer
$("#recent").addEventListener("click", (e) => {
  const id = (e.target as Element).closest<HTMLElement>(".forget")?.dataset.id;
  if (!id) return;
  forgetModel(id);
  renderRecent();
  toast("Removed from recent. The model itself is still there.");
});

$("#newForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = (new FormData(e.target as HTMLFormElement).get("name") as string).trim() || "Untitled";
  const res = await fetch("/api/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) return void toast("Couldn't make a model. Try again.");
  const model = (await res.json()) as { id: string; name: string };
  rememberModel(model.id, model.name);
  location.href = `/m/${model.id}`;
});
