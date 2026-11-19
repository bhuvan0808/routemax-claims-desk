#!/usr/bin/env node
/**
 * One-shot publish + deploy, driven by .env (gitignored). Tokens are read from the
 * environment only: never printed, never written to git config or to disk.
 *
 *   npm run ship                 # all steps
 *   npm run ship -- github       # create the private repo (if needed) and push
 *   npm run ship -- deploy       # wrangler deploy
 *   npm run ship -- secret       # wrangler secret put GROQ_API_KEY (value piped via stdin)
 *   npm run ship -- smoke        # smoke-test the deployed URL
 *
 * .env keys: GITHUB_TOKEN, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, GROQ_API_KEY
 * (with the gh CLI you can instead run: gh repo create routemax-claims-desk --private --source=. --push)
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

try {
  process.loadEnvFile(".env");
} catch {
  /* no .env */
}

const REPO = "routemax-claims-desk";
const URL_FILE = ".wrangler/live-url.txt";
const steps = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const want = (s) => steps.length === 0 || steps.includes(s);
const env = (k) => (process.env[k] ?? "").trim();
// Run wrangler through node directly: no shell, so it behaves the same on Windows, macOS and Linux.
const wrangler = (args, opts) => run(process.execPath, ["node_modules/wrangler/bin/wrangler.js", ...args], opts);

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return { code: res.status ?? 1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}
/** Remove anything that looks like a credential before echoing tool output. */
function redact(text) {
  let t = text;
  for (const k of ["GITHUB_TOKEN", "CLOUDFLARE_API_TOKEN", "GROQ_API_KEY"]) {
    if (env(k)) t = t.split(env(k)).join("***");
  }
  return t.replace(/(basic|bearer)\s+[A-Za-z0-9+/=_-]{12,}/gi, "$1 ***");
}

const done = [];
const skipped = [];

/* ------------------------------------------------------------------ github */
if (want("github")) {
  const token = env("GITHUB_TOKEN");
  if (!token) {
    skipped.push("github: GITHUB_TOKEN is empty in .env");
  } else {
    const gh = (path, init = {}) =>
      fetch(`https://api.github.com${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "claims-desk-ship-script",
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
      });
    const me = await gh("/user");
    if (!me.ok) {
      skipped.push(`github: token rejected (HTTP ${me.status})`);
    } else {
      const login = (await me.json()).login;
      const create = await gh("/user/repos", {
        method: "POST",
        body: JSON.stringify({ name: REPO, private: true, description: "RouteMax Claims Desk Agent" }),
      });
      if (create.status === 201) console.log(`github: created private repo ${login}/${REPO}`);
      else if (create.status === 422) console.log(`github: repo ${login}/${REPO} already exists, pushing to it`);
      else {
        skipped.push(`github: could not create repo (HTTP ${create.status}: ${redact((await create.text()).slice(0, 200))})`);
      }
      if (create.status === 201 || create.status === 422) {
        const remote = `https://github.com/${login}/${REPO}.git`;
        if (run("git", ["remote", "get-url", "origin"]).code === 0) run("git", ["remote", "set-url", "origin", remote]);
        else run("git", ["remote", "add", "origin", remote]);
        const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
        // Auth via a one-off header: the token is never stored in .git/config or the remote URL.
        const push = run("git", [
          "-c", "credential.helper=",
          "-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`,
          "push", "-u", "origin", "main",
        ]);
        console.log(redact(push.out.trim()));
        if (push.code === 0) done.push(`repo: https://github.com/${login}/${REPO}`);
        else skipped.push("github: push failed (see output above)");
      }
    }
  }
}

/* ------------------------------------------------------------------ deploy */
let liveUrl = existsSync(URL_FILE) ? readFileSync(URL_FILE, "utf8").trim() : "";
const cfReady = env("CLOUDFLARE_API_TOKEN") && env("CLOUDFLARE_ACCOUNT_ID");

if (want("deploy")) {
  if (!cfReady) {
    skipped.push("deploy: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID empty in .env");
  } else {
    const dep = wrangler(["deploy"]);
    console.log(redact(dep.out.trim()));
    const m = /https:\/\/[a-z0-9.-]+\.workers\.dev/i.exec(dep.out);
    if (dep.code === 0 && m) {
      liveUrl = m[0];
      writeFileSync(URL_FILE, liveUrl + "\n");
      done.push(`live: ${liveUrl}`);
    } else {
      skipped.push("deploy: wrangler deploy failed (see output above)");
    }
  }
}

if (want("secret")) {
  if (!cfReady) skipped.push("secret: Cloudflare credentials missing");
  else if (!env("GROQ_API_KEY")) skipped.push("secret: GROQ_API_KEY empty in .env (Worker will run in mock mode)");
  else {
    const sec = wrangler(["secret", "put", "GROQ_API_KEY"], { input: env("GROQ_API_KEY") + "\n" });
    console.log(redact(sec.out.trim()));
    if (sec.code === 0) done.push("secret GROQ_API_KEY set on the Worker");
    else skipped.push("secret: wrangler secret put failed");
  }
}

/* ------------------------------------------------------------------- smoke */
if (want("smoke")) {
  if (!liveUrl) skipped.push("smoke: no live URL yet (deploy first)");
  else {
    const smoke = run("node", ["scripts/smoke.mjs", liveUrl]);
    console.log(smoke.out.trim());
    if (smoke.code === 0) done.push("smoke test passed");
    else skipped.push("smoke: FAILED (see output above)");
  }
}

console.log("\n--- ship summary ---");
for (const d of done) console.log(`  OK    ${d}`);
for (const s of skipped) console.log(`  TODO  ${s}`);
process.exit(skipped.length ? 1 : 0);
