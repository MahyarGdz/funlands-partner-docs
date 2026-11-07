// Sample game client. The Funlands launch handoff page bootstrapped the session on this origin and left it in
// sessionStorage["funlands:partner-session"]; the game takes it, keeps it in memory and calls the real game APIs.
(function () {
  "use strict";
  var config = JSON.parse(document.getElementById("config").textContent);
  var HANDOFF_KEY = "funlands:partner-session";
  var $ = function (id) { return document.getElementById(id); };
  var session = null;
  var dead = false;
  var round = null;

  function log(text, cls) {
    var li = document.createElement("li");
    li.textContent = new Date().toLocaleTimeString() + "  " + text;
    if (cls) li.className = cls;
    $("log").insertBefore(li, $("log").firstChild);
  }
  function setStatus(text, cls) { $("status").textContent = text; $("status").className = "pill " + (cls || ""); }
  function enable(on) { ["start", "leaderboard", "history"].forEach(function (id) { $(id).disabled = !on; }); }

  // Tokens live in this page's memory only; the handoff entry is removed as soon as it is read.
  function takeSession() {
    var raw = sessionStorage.getItem(HANDOFF_KEY);
    if (!raw) return false;
    sessionStorage.removeItem(HANDOFF_KEY);
    var tokens = JSON.parse(raw);
    session = { access: tokens.access_token, refresh: tokens.refresh_token };
    log("session received from the launch handoff (bootstrap done on " + location.origin + ")", "ok");
    return true;
  }

  // No session (reload, or the session ended): ask the partner page for a fresh launch (contract §4.9). Only the
  // message type and a request id travel; never a token or sub.
  var pendingRelaunch = null;
  function requestRelaunch() {
    if (window.parent === window) return false;
    pendingRelaunch = "r_" + Math.random().toString(36).slice(2, 12);
    window.parent.postMessage({ type: "funlands:relaunch_requested", request_id: pendingRelaunch }, config.partnerOrigin);
    log("asked the partner page for a fresh launch (" + pendingRelaunch + ")");
    return true;
  }
  window.addEventListener("message", function (event) {
    if (event.origin !== config.partnerOrigin || event.source !== window.parent) return;
    if (event.data && event.data.type === "partner:relaunch_ready" && event.data.request_id === pendingRelaunch)
      log("partner is relaunching (" + pendingRelaunch + ")", "ok");
  });

  function call(method, path, body, retried) {
    return fetch(path, {
      method: method,
      headers: Object.assign(
        { accept: "application/json", authorization: "Bearer " + session.access },
        body ? { "content-type": "application/json" } : {}
      ),
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      credentials: "omit"
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        if (res.status === 401 && !retried) return refresh().then(function (ok) { return ok ? call(method, path, body, true) : { status: 401, body: json }; });
        return { status: res.status, body: json };
      });
    });
  }

  // Access tokens of partner sessions live at most 15 min; rotate at the existing refresh endpoint.
  function refresh() {
    return fetch("/v1/auth/session/refresh", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ refreshToken: session.refresh }),
      credentials: "omit"
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        if (!res.ok) { died("refresh refused: " + res.status + " " + (json.code || "")); return false; }
        session = { access: json.data.accessToken, refresh: json.data.refreshToken };
        log("access token refreshed", "ok");
        return true;
      });
    });
  }

  function died(reason) {
    if (dead) return;
    dead = true;
    enable(false);
    $("star").disabled = true;
    setStatus("session ended", "dead");
    $("player").textContent = "The partner logged this player out (back-channel logout). Funlands now refuses this session.";
    $("player").className = "bad";
    log("session is dead: " + reason, "bad");
    $("relaunch").hidden = false;
  }

  function heartbeat() {
    if (dead || !session) return;
    call("GET", "/v1/profile").then(function (r) {
      if (r.status === 401) died("GET /v1/profile → 401 " + (r.body.code || ""));
    }).catch(function () {});
  }

  function startRound() {
    $("start").disabled = true;
    call("POST", "/v1/user/game/entry", { gameId: config.game }).then(function (r) {
      if (r.status !== 200) { log("game entry → " + r.status + " " + JSON.stringify(r.body), "bad"); $("start").disabled = dead; return; }
      var data = r.body.data || {};
      round = { playSessionId: data.playSessionId || data.play_session_id || null, score: 0, left: 10 };
      log("game entry → 200, play session " + round.playSessionId, "ok");
      $("score").textContent = "0"; $("time").textContent = "10";
      $("star").disabled = false;
      var timer = setInterval(function () {
        round.left -= 1; $("time").textContent = String(round.left);
        if (round.left <= 0 || dead) { clearInterval(timer); finishRound(); }
      }, 1000);
    });
  }

  function finishRound() {
    $("star").disabled = true;
    if (dead) return;
    var payload = { gameId: config.game, score: round.score, playSessionId: round.playSessionId, endSession: true, clientKey: "final-" + round.playSessionId };
    call("POST", "/v1/user/game/score", payload).then(function (r) {
      log("score " + round.score + " → " + r.status + (r.status === 200 ? "" : " " + JSON.stringify(r.body)), r.status === 200 ? "ok" : "bad");
      $("start").disabled = dead;
    });
  }

  $("star").addEventListener("click", function () {
    if (!round) return;
    round.score += 10;
    $("score").textContent = String(round.score);
    $("star").style.left = Math.round(5 + Math.random() * 85) + "%";
    $("star").style.top = Math.round(15 + Math.random() * 65) + "%";
  });
  $("start").addEventListener("click", startRound);
  $("leaderboard").addEventListener("click", function () {
    call("GET", "/v1/userLeaderboard/" + config.game).then(function (r) {
      if (r.status === 403) log("leaderboard → 403 " + (r.body.code || "") + ": the shared board is platform-only; partner players are refused by design", "muted");
      else log("leaderboard → " + r.status + " " + JSON.stringify(r.body.data || r.body).slice(0, 300));
    });
  });
  $("history").addEventListener("click", function () {
    call("GET", "/v1/user/game/" + config.game + "/score-history").then(function (r) {
      log("my scores → " + r.status + " " + JSON.stringify(r.body.data || r.body).slice(0, 400), r.status === 200 ? "ok" : "bad");
    });
  });

  $("relaunch").addEventListener("click", function () { requestRelaunch(); });
  if (!takeSession()) {
    setStatus("no session", "dead");
    $("player").textContent = requestRelaunch()
      ? "No session in this page (reload?): asked the partner page for a fresh launch."
      : "No session: open this game from the partner app (Play), which launches it through Funlands.";
    return;
  }
  call("GET", "/v1/profile").then(function (r) {
    if (r.status !== 200) return died("GET /v1/profile → " + r.status + " " + (r.body.code || ""));
    var p = r.body.data || {};
    setStatus("session live", "live");
    $("player").textContent = "Playing as " + (p.userName || p.user_name || "partner player") + " · Funlands user " + (p.id || p._id || p.userId || "?");
    enable(true);
    log("GET /v1/profile → 200", "ok");
  });
  setInterval(heartbeat, 3000);
})();
