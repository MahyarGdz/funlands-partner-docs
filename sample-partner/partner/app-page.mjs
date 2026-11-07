// The partner's own web app page: a signed-in player, a game card, the Funlands game frame, and operator panels.
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const SCRIPT_UNSAFE = new RegExp("[<>&\\u2028\\u2029]", "g");
const json = (value) => JSON.stringify(value).replace(SCRIPT_UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

export function renderAppPage({ nonce, player, games, gameOrigin, launchUrl, partnerKey }) {
  const config = { gameOrigin, launchUrl, games };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Arcade Hub — sample Funlands partner</title>
<style nonce="${nonce}">
  :root { --ink:#1d1b26; --muted:#6b6878; --line:#e4e1ec; --bg:#f6f4fa; --brand:#5b3cc4; --ok:#1f8a4c; --bad:#c0392b; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color:var(--ink); background:var(--bg); }
  header { display:flex; align-items:center; justify-content:space-between; padding:12px 20px; background:#fff; border-bottom:1px solid var(--line); }
  header h1 { font-size:17px; margin:0; } header h1 span { color:var(--brand); }
  .who { font-size:12px; color:var(--muted); text-align:right; } .who b { color:var(--ink); }
  main { display:grid; grid-template-columns: minmax(420px, 1.2fr) minmax(360px, 1fr); gap:16px; padding:16px 20px; }
  section { background:#fff; border:1px solid var(--line); border-radius:10px; padding:14px; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:0 0 10px; }
  .game { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px; border:1px solid var(--line); border-radius:8px; }
  button { font:inherit; border:0; border-radius:7px; padding:7px 12px; background:var(--brand); color:#fff; cursor:pointer; }
  button.secondary { background:#ece8f8; color:var(--brand); } button.danger { background:var(--bad); }
  button:disabled { opacity:.5; cursor:default; }
  iframe { width:100%; height:520px; border:1px solid var(--line); border-radius:8px; margin-top:12px; background:#fafafa; }
  .row { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px; }
  pre { margin:0; max-height:260px; overflow:auto; background:#faf9fd; border:1px solid var(--line); border-radius:6px; padding:8px; font-size:11.5px; }
  ul.hooks { list-style:none; margin:0; padding:0; max-height:300px; overflow:auto; }
  ul.hooks li { padding:6px 8px; border-bottom:1px solid var(--line); font-size:12px; }
  .tag { display:inline-block; padding:1px 6px; border-radius:10px; font-size:11px; background:#ece8f8; color:var(--brand); margin-right:4px; }
  .ok { color:var(--ok); } .bad { color:var(--bad); } .muted { color:var(--muted); }
  #notice { margin-top:8px; font-size:12px; } .gap { margin-top:16px; }
</style>
</head>
<body>
<header>
  <h1><span>Arcade Hub</span> · sample Funlands partner</h1>
  <div class="who">Signed in as <b>${esc(player.nickname)}</b><br>sub <code id="sub">${esc(player.sub)}</code> · sid <code id="sid">${esc(player.sid)}</code></div>
</header>
<main>
  <div>
    <section>
      <h2>Games</h2>
      <div id="games"></div>
      <div id="notice" class="muted">Play signs a launch token on the partner backend and form-posts it into the frame below.</div>
      <iframe name="game-frame" id="frame" title="Funlands game" allow="fullscreen"></iframe>
      <form id="launch" method="post" action="${esc(launchUrl)}" target="game-frame">
        <input type="hidden" name="launch_token"><input type="hidden" name="game"><input type="hidden" name="bootstrap_verifier">
      </form>
    </section>
  </div>
  <div>
    <section>
      <h2>Player session</h2>
      <div class="row"><button class="danger" id="logout">Log player out (back-channel)</button></div>
      <pre id="logoutOut" class="muted">Ends the partner session sid at Funlands; the game frame should show the session die.</pre>
    </section>
    <section class="gap">
      <h2>Webhooks received <span class="muted" id="hookCount"></span></h2>
      <ul class="hooks" id="hooks"><li class="muted">none yet</li></ul>
    </section>
    <section class="gap">
      <h2>Partner API (OAuth private_key_jwt)</h2>
      <div class="row"><button class="secondary" id="reports">Reports for this player</button><button class="secondary" id="events">Events feed</button></div>
      <pre id="apiOut" class="muted">—</pre>
    </section>
  </div>
</main>
<script type="application/json" id="cfg">${json(config)}</script>
<script nonce="${nonce}">
(function () {
  var cfg = JSON.parse(document.getElementById("cfg").textContent);
  var form = document.getElementById("launch");
  var frame = document.getElementById("frame");
  var notice = document.getElementById("notice");
  function el(tag, text, cls) { var e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; }
  function post(path, body) {
    return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}), credentials: "same-origin" })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; }); });
  }
  var games = document.getElementById("games");
  cfg.games.forEach(function (g) {
    var row = el("div", undefined, "game");
    var title = el("div"); title.appendChild(el("b", g.title)); title.appendChild(el("div", g.id, "muted"));
    var play = el("button", "Play"); play.id = "play-" + g.id;
    play.addEventListener("click", function () { launch(g.id); });
    row.appendChild(title); row.appendChild(play); games.appendChild(row);
  });
  var currentGame = null;
  // relaunchRequestId: set when the game frame asked for a fresh launch (funlands:relaunch_requested).
  function launch(game, relaunchRequestId) {
    currentGame = game;
    notice.textContent = "Signing launch token…"; notice.className = "muted";
    post("/api/launch", { game: game }).then(function (r) {
      if (!r.ok) { notice.textContent = "Launch refused by partner backend: " + JSON.stringify(r.body); notice.className = "bad"; return; }
      if (relaunchRequestId) frame.contentWindow.postMessage({ type: "partner:relaunch_ready", request_id: relaunchRequestId }, cfg.gameOrigin);
      form.elements.launch_token.value = r.body.launch_token;
      form.elements.game.value = r.body.game;
      form.elements.bootstrap_verifier.value = r.body.bootstrap_verifier;
      document.getElementById("sid").textContent = r.body.sid;
      form.submit();
      notice.textContent = "Launch posted to " + cfg.launchUrl + " for sid " + r.body.sid; notice.className = "ok";
    });
  }
  window.addEventListener("message", function (event) {
    if (event.origin !== cfg.gameOrigin || event.source !== frame.contentWindow) return;
    if (event.data && event.data.type === "funlands:relaunch_requested" && typeof event.data.request_id === "string") {
      if (!currentGame) return;
      notice.textContent = "Game asked for a fresh launch (request " + event.data.request_id + ")"; notice.className = "muted";
      return launch(currentGame, event.data.request_id);
    }
    if (event.data && event.data.type === "funlands:launch_failed") {
      notice.textContent = "Funlands refused the launch: " + event.data.code + " (request " + event.data.request_id + ")"; notice.className = "bad";
    }
  });
  document.getElementById("logout").addEventListener("click", function () {
    var out = document.getElementById("logoutOut");
    out.textContent = "Sending logout token…";
    post("/api/logout").then(function (r) {
      out.textContent = JSON.stringify(r.body, null, 2); out.className = r.ok ? "ok" : "bad";
      if (r.ok) document.getElementById("sid").textContent = r.body.next_sid;
    });
  });
  function show(path) {
    var out = document.getElementById("apiOut"); out.textContent = "Loading " + path + "…"; out.className = "muted";
    fetch(path, { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (b) { out.textContent = JSON.stringify(b, null, 2); out.className = ""; });
  }
  document.getElementById("reports").addEventListener("click", function () { show("/api/reports"); });
  document.getElementById("events").addEventListener("click", function () { show("/api/events?sub=" + encodeURIComponent(document.getElementById("sub").textContent)); });
  function pollHooks() {
    fetch("/api/webhooks", { credentials: "same-origin" }).then(function (r) { return r.json(); }).then(function (b) {
      var list = document.getElementById("hooks");
      document.getElementById("hookCount").textContent = "(" + b.count + ")";
      if (!b.items.length) return;
      list.textContent = "";
      b.items.slice(0, 60).forEach(function (h) {
        var li = el("li");
        li.appendChild(el("span", h.verified ? "verified" : "rejected " + h.status, h.verified ? "ok" : "bad"));
        li.appendChild(document.createTextNode(" " + h.received_at.slice(11, 19) + " "));
        (h.events || []).forEach(function (e) {
          li.appendChild(el("span", e.short_type, "tag"));
          li.appendChild(el("span", e.subject.sub + " #" + e.player_seq + " ", "muted"));
        });
        if (h.error) li.appendChild(el("span", h.error, "bad"));
        list.appendChild(li);
      });
    }).catch(function () {});
  }
  pollHooks(); setInterval(pollHooks, 2000);
})();
</script>
</body>
</html>`;
}
