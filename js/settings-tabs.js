// Settings page sections. Opens on "Account"; #tab=data (or ?tab=data) opens another section.
const tabs = [...document.querySelectorAll("#settingsTabs [data-tab]")], panes = [...document.querySelectorAll(".settings-pane")];
function show(name, focus) {
  if (!panes.some(p => p.dataset.pane === name)) name = "account";
  tabs.forEach(t => { const on = t.dataset.tab === name; t.classList.toggle("on", on); t.setAttribute("aria-selected", on); t.tabIndex = on ? 0 : -1; if (on && focus) t.scrollIntoView({ inline: "center", block: "nearest" }); });
  panes.forEach(p => { p.hidden = p.dataset.pane !== name; });
  window.dispatchEvent(new CustomEvent("qm-settings-tab", { detail: name }));
}
tabs.forEach(t => { t.onclick = () => { show(t.dataset.tab, true); window.scrollTo(0, 0); document.querySelector("main")?.scrollTo?.(0, 0); }; });
tabs.forEach(t => t.addEventListener("keydown", e => { const i = tabs.indexOf(t), n = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0; if (n) { const x = tabs[(i + n + tabs.length) % tabs.length]; x.focus(); show(x.dataset.tab, true); } }));
const q = new URLSearchParams(location.search).get("tab") || (location.hash.match(/tab=(\w+)/) || [])[1];
show(q || "account");
export { show as showSettingsTab };
