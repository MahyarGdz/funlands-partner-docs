// Builds the published site from the plain sources in src/:
//   src/developer-docs.html -> index.html            (+ funlands-partner-developer-docs.pdf with --pdf)
//   src/guide.html          -> guide/index.html      (+ guide/funlands-partner-integration-guide.pdf with --pdf)
// Code blocks are highlighted at build time with Shiki, so the pages need no runtime JS for it and the PDFs carry the
// same colours. The web copy uses the open Vazirmatn font; PDFs use a locally installed font (--font-dir), which is
// embedded by Chrome and never committed.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHighlighter } from "shiki";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const wantPdf = args.includes("--pdf");
const fontDir = argValue("--font-dir") ?? join(process.env.HOME ?? "", "Library/Fonts");
const chrome = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const DOCS = [
  { src: "src/developer-docs.html", out: "index.html", pdf: "funlands-partner-developer-docs.pdf" },
  { src: "src/guide.html", out: "guide/index.html", pdf: "guide/funlands-partner-integration-guide.pdf" },
];

// Tab language -> grammar for the sample code in that tab.
const TAB_LANG = {
  nestjs: "typescript", express: "javascript", fastapi: "python", django: "python", laravel: "php", php: "php",
  go: "go", spring: "java", dotnet: "csharp", curl: "bash",
};
const LANGS = ["typescript", "javascript", "python", "php", "go", "java", "csharp", "bash", "http", "json", "jsonc", "sql", "xml", "yaml", "html", "text"];
const THEMES = { light: "github-light", dark: "github-dark-default" };

// Shiki emits both themes as CSS variables. The developer docs show dark code panels on screen and light ones in
// print; the guide stays light everywhere.
const SHIKI_CSS = `
pre.shiki { direction: ltr; text-align: left; }
pre.shiki code { font-family: "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace; font-variant-ligatures: none; }
pre.shiki span { color: var(--shiki-light); font-style: var(--shiki-light-font-style); font-weight: var(--shiki-light-font-weight); }
@media screen {
  .codeblock pre.shiki span { color: var(--shiki-dark); font-style: var(--shiki-dark-font-style); font-weight: var(--shiki-dark-font-weight); }
}
`;

const highlighter = await createHighlighter({ themes: Object.values(THEMES), langs: LANGS.filter((l) => l !== "text") });

for (const doc of DOCS) {
  const source = readFileSync(join(ROOT, doc.src), "utf8");
  const { html, counts } = highlightBlocks(source);
  const web = forWeb(html);
  mkdirSync(dirname(join(ROOT, doc.out)), { recursive: true });
  writeFileSync(join(ROOT, doc.out), web);
  console.log(`${doc.out}: ${Object.entries(counts).map(([l, n]) => `${l} ${n}`).join(", ")}`);
  if (wantPdf) printPdf(forPrint(html), join(ROOT, doc.pdf));
}

/** Highlights every <pre><code>…</code></pre>; an explicit class="language-x" on <code> always wins. */
function highlightBlocks(page) {
  const counts = {};
  const out = page.replace(/<pre><code(?: class="language-([\w-]+)")?>([\s\S]*?)<\/code><\/pre>/g, (_match, explicit, body, offset) => {
    const code = decode(body.replace(/<[^>]+>/g, ""));
    const lang = explicit ?? detect(code, tabLangAt(page, offset));
    counts[lang] = (counts[lang] ?? 0) + 1;
    if (lang === "text") return `<pre class="shiki"><code>${body.replace(/<[^>]+>/g, "")}</code></pre>`;
    const rendered = highlighter.codeToHtml(code.replace(/\n$/, ""), {
      lang,
      themes: THEMES,
      defaultColor: false,
    });
    // Keep the page's own block styling (background, padding); Shiki supplies only token colours.
    return rendered.replace(/^<pre class="shiki[^"]*" style="[^"]*"/, `<pre class="shiki" data-lang="${lang}"`);
  });
  return { html: out, counts };
}

/** The data-lang of the tab panel that encloses this offset, if any. */
function tabLangAt(page, offset) {
  const open = page.lastIndexOf('role="tabpanel" data-lang="', offset);
  if (open < 0) return null;
  if (page.slice(open, offset).includes("</pre>")) return null;
  return page.slice(open + 27, page.indexOf('"', open + 27));
}

function detect(code, tab) {
  const first = code.trimStart();
  const lines = first.split("\n");
  if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\/|https?:)\S*/.test(first) || /^HTTP\/\d(\.\d)? \d{3}/.test(first)) return "http";
  if (/^[A-Z][A-Za-z-]+: \S/.test(first) && /\n\s*\n/.test(first)) return "http";
  if (/^<(iframe|form|div|script|html|!doctype)/i.test(first)) return "html";
  if (/^<!--|^<\?xml|^<project/.test(first)) return "xml";
  if (/^(CREATE|ALTER|INSERT|SELECT|UPDATE|DELETE)\s/i.test(first)) return "sql";
  const installLike = /(^|\n)\s*(npm (i|install)|pnpm add|yarn add|pip install|composer require|go get|dotnet add|brew install|apt(-get)? install|curl |openssl |export |cat )/;
  if (tab && installLike.test(first) && lines.length <= 12 && /^#/.test(first)) return "bash";
  if (tab) return TAB_LANG[tab] ?? "text";
  if (/^[{[]/.test(first) || /^\/\/ (header|payload|claims|GET|POST|body)/.test(first)) return /\/\/|\/\*/.test(first) ? "jsonc" : "json";
  if (/^<\?php/.test(first)) return "php";
  if (/^(npm|pnpm|yarn|npx) /.test(first)) return "bash";
  if (/^(import |export |const |let |function |async |class |private |public |protected |@\w|window\.|document\.|\/\/ )/.test(first)) return "typescript";
  if (/^#!|^#\s|^curl |^openssl |^\$ /.test(first)) return "bash";
  if (/^[a-z_]+:\s/m.test(first) && !/[;{}]/.test(first)) return "yaml";
  return "text";
}

/** Web copy: open Vazirmatn instead of the local commercial font, and the dark/light colour switch for print. */
function forWeb(page) {
  let html = stripLocalFonts(page).replace(/font-family:\s*"(YekanBakh|Yekan)"/g, 'font-family: "Vazirmatn"');
  const fonts =
    '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">\n';
  if (!html.includes('name="viewport"')) html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">');
  return html.replace("<style>", `${fonts}<style>\n${SHIKI_CSS}`);
}

/** Print copy: keep the locally installed font so the PDF matches the earlier editions. */
function forPrint(page) {
  const local = (file, weight) =>
    existsSync(join(fontDir, file)) ? `@font-face { font-family: "YekanBakh"; src: url("file://${join(fontDir, file)}"); font-weight: ${weight}; }\n` : "";
  const faces = local("Yekan_Bakh_Fanum_Regular.TTF", 400) + local("Yekan_Bakh_Fanum_Medium.TTF", 500) + local("Yekan_Bakh_Fanum_Bold.TTF", 700);
  const html = stripLocalFonts(page).replace(/font-family:\s*"Yekan"/g, 'font-family: "YekanBakh"');
  return html.replace("<style>", `<style>\n${faces}${SHIKI_CSS}`);
}

function stripLocalFonts(page) {
  return page.replace(/@font-face\s*\{[^}]*file:\/\/[^}]*\}\s*/g, "");
}

function printPdf(html, outFile) {
  const dir = mkdtempSync(join(tmpdir(), "partner-docs-"));
  const file = join(dir, "page.html");
  writeFileSync(file, html);
  mkdirSync(dirname(outFile), { recursive: true });
  execFileSync(chrome, ["--headless", "--disable-gpu", "--no-pdf-header-footer", "--virtual-time-budget=10000", `--print-to-pdf=${outFile}`, `file://${file}`], { stdio: "ignore" });
  console.log(`pdf: ${outFile.replace(ROOT + "/", "")}`);
}

function decode(text) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, "&");
}

function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
